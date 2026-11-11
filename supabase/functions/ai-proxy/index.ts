/**
 * Supabase Edge Function：静态版 AI 代理。
 * 百炼 API Key 只存在 EF secrets，浏览器永远拿不到。
 * 提示词、逐句清洗、错因判定 100% 复用主仓库 src/lib/ai 的实现（lib/ 下为同源副本）。
 */
import { generateAnalyzePrompt, generateSimilarQuestionPrompt, generateGeogebraPrompt, generateReanswerPrompt, generateVerifyPrompt } from "./lib/prompts.ts";
import {
  sanitizeBodyText, extractTagSafe, parseMistakeFieldsFromResponse,
  withoutMistakeAnalysis, shouldStopGeneration,
} from "./lib/response-guard.ts";
import { deriveAnswerFromAnalysis, findConclusionExpr, answersEquivalent } from "./lib/answer-consistency.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = Deno.env.get("OPENAI_MODEL") || "qwen3-vl-plus";

const VALID_SUBJECTS = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];

function extractTag(text: string, tag: string) { return extractTagSafe(text, tag, tag === "analysis"); }

/** 与 src/lib/ai/openai-provider.ts#parseResponse 同源 */
function parseResponse(text: string) {
  const rawQuestion = extractTag(text, "question_text");
  const rawAnswer = extractTag(text, "answer_text");
  const rawAnalysis = extractTag(text, "analysis");
  if (!rawQuestion || !rawAnswer || !rawAnalysis) {
    throw new Error("Invalid AI response: Missing critical XML tags");
  }
  // 单一真相源 = 模型提交的答案（<final_answer> 或 answer_text），全篇只此一份。
  // 解析正文里的「结论区间」仅用于冲突检测，绝不反向覆盖已提交答案：
  // 覆盖会在两种情况下翻车——提交答案对但解析末尾改口成错（本次事故），或反之（旧问题）。
  // 故 deriveAnswerFromAnalysis 永不自动覆盖，冲突只上报告警交人工裁决。
  // <final_answer> 标签由 sanitizeBodyText 的 stripLeakedTags 剥离。
  const finalTag = rawAnalysis.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  const finalAnswer = finalTag ? finalTag[1].trim() : '';
  const derived = deriveAnswerFromAnalysis(rawAnalysis, rawAnswer, finalAnswer);
  const questionText = sanitizeBodyText(rawQuestion);
  const answerText = sanitizeBodyText(derived.answerText);
  const analysis = sanitizeBodyText(rawAnalysis);
  const mistake = parseMistakeFieldsFromResponse(text, (t) => extractTag(text, t), answerText);
  const subjectRaw = extractTag(text, "subject");
  const pointsRaw = extractTag(text, "knowledge_points");
  const requiresImageRaw = extractTag(text, "requires_image");
  const knowledgePoints = pointsRaw
    ? pointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(Boolean).slice(0, 5)
    : [];
  return withoutMistakeAnalysis({
    questionText, answerText, analysis,
    wrongAnswerText: mistake.wrongAnswerText,
    mistakeAnalysis: mistake.mistakeAnalysis,
    mistakeStatus: mistake.mistakeStatus,
    subject: subjectRaw && VALID_SUBJECTS.includes(subjectRaw) ? subjectRaw : "其他",
    knowledgePoints,
    requiresImage: requiresImageRaw?.toLowerCase().trim() === "true",
    answerSource: derived.source,
    answerConflict: derived.conflict,
    originalAnswerText: derived.originalAnswerText || '',
  }, true);
}

async function verifyUser(req: Request): Promise<{ token: string; uid: string } | null> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token || token === ANON_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return { token, uid: u.id };
}

/** 从数据库读系统知识点标签，注入提示词（保持与全栈版一致的标签推荐能力） */
async function prefetchedTags(token: string) {
  const out: Record<string, string[]> = {
    math: [], physics: [], chemistry: [], biology: [], english: [],
  };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/KnowledgeTag?select=name,subject&isSystem=eq.true&limit=3000`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return out;
    const rows: { name: string; subject: string }[] = await res.json();
    for (const r of rows) {
      const key = String(r.subject || "").toLowerCase();
      if (key in out && out[key].length < 400) out[key].push(r.name);
    }
  } catch { /* 标签获取失败不阻断解析 */ }
  return out;
}

/** 服务端防欠费：quota_snapshot 最新快照标记不可用则直接阻断 */
async function quotaBlocked(token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/quota_snapshot?select=*&order=captured_at.desc&limit=1`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return false;
    const rows = await res.json();
    const r = rows?.[0];
    return !!r && r.free_quota_expired === true && r.stop_when_free_expired !== false;
  } catch { return false; }
}

type ChatCreds = { apiKey: string; baseUrl: string; model: string };

type ChatOptions = {
  systemPrompt: string;
  imageBase64?: string;
  mimeType?: string;
  userText?: string;
  stream: boolean;
  maxTokens?: number;
  enableThinking?: boolean;
  thinkingBudget?: number;
  onDelta?: (s: string) => void;
  signal?: AbortSignal;
  /** 指定调用哪个 provider；省略则用主模型（OPENAI_*） */
  creds?: ChatCreds;
};

async function chat(opts: ChatOptions): Promise<string> {
  const creds = opts.creds ?? { apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL };
  if (!creds.apiKey) throw new Error("AI_NOT_CONFIGURED");
  const messages: any[] = [{ role: "system", content: opts.systemPrompt }];
  if (opts.imageBase64) {
    messages.push({
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:${opts.mimeType || "image/jpeg"};base64,${opts.imageBase64}` } }],
    });
  } else {
    messages.push({ role: "user", content: opts.userText || "" });
  }
  const body: any = {
    model: creds.model,
    messages,
    max_tokens: opts.maxTokens ?? 8192,
    stream: opts.stream,
  };
  // enable_thinking 仅 Qwen/DashScope 支持；其它模型（如 Gemini）忽略该参数。
  if (creds.baseUrl.includes("dashscope") || creds.model.toLowerCase().includes("qwen3")) {
    body.enable_thinking = opts.enableThinking ?? false;
    if (body.enable_thinking) body.thinking_budget = opts.thinkingBudget ?? 4096;
  }
  if (opts.stream) body.stream_options = { include_usage: true };

  const res = await fetch(`${creds.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI_HTTP_${res.status}: ${t.slice(0, 300)}`);
  }
  if (!opts.stream) {
    const j = await res.json();
    return j.choices?.[0]?.message?.content || "";
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "", full = "";
  const controller = new AbortController();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || "";
        if (delta) {
          full += delta;
          opts.onDelta?.(delta);
          if (shouldStopGeneration(full)) { controller.abort(); await reader.cancel(); break; }
        }
      } catch { /* 忽略非 JSON 心跳 */ }
    }
    if (controller.signal.aborted) break;
  }
  return full;
}

/**
 * 从模型原始输出抽取「参考答案」的两个候选：
 *  - tagAnswer：模型标签 <answer_text> / <analysis> 末尾 <final_answer> 里写的值
 *    （历史事故正是它常与正文不一致、且被旧代码「冒昧」直接当作答案）
 *  - bodyConclusion：解析正文推理得出的结论（findConclusionExpr 从全文确定性提取，
 *    刻意排除 <final_answer> 标签，只认推理正文）
 */
function extractAnswerCandidates(primaryText: string): { tagAnswer: string; bodyConclusion: string } {
  const rawAnalysis = extractTag(primaryText, "analysis") || "";
  const tagAnswerRaw = extractTag(primaryText, "answer_text") || "";
  const finalMatch = rawAnalysis.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  const tagAnswer = sanitizeBodyText(((finalMatch && finalMatch[1]) || tagAnswerRaw || "").trim());
  const bodyConclusion = findConclusionExpr(rawAnalysis);
  return { tagAnswer, bodyConclusion };
}

/**
 * 反向代入验算：给定原题与两个候选答案，让模型只做「代入检验」不做解题，
 * 通过边界点/内部点/外部反例点逐一代入原条件，判断哪个候选正确。
 * 输入不含任何「哪个更可信」的引导，避免模型迁就标签。返回验算后的正确值（空串=无结论）。
 */
async function verifyAnswerViaSubstitution(
  questionText: string,
  bodyConclusion: string,
  tagAnswer: string,
  language: string,
): Promise<string> {
  const prompt = generateVerifyPrompt(questionText, bodyConclusion, tagAnswer, language);
  const text = await chat({
    systemPrompt: prompt,
    userText: "请完成反向代入验算，并只输出 <verified> 与 <reason> 两个标签。",
    stream: false,
    enableThinking: false,
  });
  const m = text.match(/<verified>\s*([\s\S]*?)\s*<\/verified>/i);
  return m ? m[1].trim() : "";
}

/**
 * 决定「参考答案」最终填入的值（取数可信度核心逻辑）。
 * 决策顺序：
 *  1. 标签答案与正文推理结论一致 → 直接采用（无需额外验算）；
 *  2. 不一致 → 发起独立「反向代入验算」，由验算结果定夺；
 *  3. 验算无结论/失败 → 优先信任「正文推理结论」而非标签
 *     （修复此前冒昧采信错误标签值、正文结论被闲置的问题）；
 *  4. 纯文字论述题等无区间答案 → 优先采用正文结论（或标签）。
 */
async function decideReferenceAnswer(
  primaryText: string,
  parsed: ReturnType<typeof parseResponse>,
  payload: any,
  language: string,
): Promise<{ answerText: string; verified: boolean; reason: string }> {
  const { tagAnswer, bodyConclusion } = extractAnswerCandidates(primaryText);
  const fallback = () => {
    const text = bodyConclusion || tagAnswer || parsed.answerText;
    return { answerText: sanitizeBodyText(text), verified: false, reason: bodyConclusion ? "fallback_to_analysis" : "" };
  };
  // 仅区间类答案才需要验算；两者等价直接采用正文结论（与标签一致）。
  if (!bodyConclusion || !tagAnswer || answersEquivalent(bodyConclusion, tagAnswer)) {
    return fallback();
  }
  // 不一致 → 反向代入验算（同模型独立一次调用，只看原题、不泄露答案归属）
  try {
    const verified = await verifyAnswerViaSubstitution(
      parsed.questionText, bodyConclusion, tagAnswer, language,
    );
    if (verified) {
      return { answerText: sanitizeBodyText(verified), verified: true, reason: "reverse_substitution" };
    }
  } catch (e) {
    console.error("[ai-proxy] verify (reverse substitution) failed:", e);
  }
  // 验算无结论时，优先信任正文推理结论（不再冒昧采信标签错误值）
  return fallback();
}

function sseHeaders() {
  return { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await verifyUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let action = "", payload: any = {};
  try {
    const body = await req.json();
    action = body.action || "";
    payload = body.payload || {};
  } catch { return json({ error: "Invalid JSON" }, 400); }

  if (action === "test") return json({ ok: true, model: MODEL, configured: !!API_KEY });
  if (!API_KEY) return json({ error: "AI_NOT_CONFIGURED", message: "Edge Function 尚未配置 OPENAI_API_KEY" }, 503);

  if (await quotaBlocked(user.token)) {
    return json({ error: "AI_QUOTA_BLOCKED", message: "AI 额度已用尽或欠费，已自动阻断调用" }, 429);
  }

  const tags = await prefetchedTags(user.token);
  const options = {
    prefetchedMathTags: tags.math,
    prefetchedPhysicsTags: tags.physics,
    prefetchedChemistryTags: tags.chemistry,
    prefetchedBiologyTags: tags.biology,
    prefetchedEnglishTags: tags.english,
  };
  const language = payload.language === "en" ? "en" : "zh";

  // ---------------------------------------------------------------- 拍照识题（SSE）
  if (action === "analyze") {
    let imageBase64 = String(payload.imageBase64 || "");
    let mimeType = "image/jpeg";
    const m = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { mimeType = m[1]; imageBase64 = m[2]; }
    if (!imageBase64) return json({ error: "Missing imageBase64" }, 400);

    const subject = payload.subjectName || null;
    const isMath = !!subject && String(subject).includes("数学");
    const systemPrompt = generateAnalyzePrompt(
      language, payload.grade ?? null, subject, options, payload.gradeSemester ?? null,
    );
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* closed */ }
        };
        // 主模型：流式（保证 UX），逐段转发 delta。
        const primaryPromise = chat({
          systemPrompt, imageBase64, mimeType, stream: true,
          enableThinking: isMath,
          onDelta: (d) => send({ type: "delta", content: d }),
        });
        let primaryText: string;
        try {
          primaryText = await primaryPromise;
        } catch (e) {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
          return;
        }
        try {
          const result = parseResponse(primaryText);
          // —— 参考答案取数可信度：反向代入验算后再决定填入哪个值 ——
          // 不再默认直接采信 <answer_text> 标签；以「正文推理结论」为第一候选，
          // 当其与标签答案不一致时发起独立反向代入验算，由验算结果定夺。
          const decided = await decideReferenceAnswer(primaryText, result, payload, language);
          send({
            type: "done",
            result: {
              ...result,
              answerText: decided.answerText,
              answerVerified: decided.verified,
              answerReason: decided.reason,
            },
          });
        } catch (e) {
          send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          try { controller.close(); } catch { /* noop */ }
        }
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  }

  // ---------------------------------------------------------------- 其它 AI 动作
  try {
    if (action === "reanswer") {
      const p = generateReanswerPrompt(language, payload.questionText || "", payload.subject || null, options, payload.gradeSemester ?? null);
      const text = await chat({ systemPrompt: p, userText: payload.imageBase64 ? undefined : "请重新解答", stream: false });
      return json({ ...parseResponse(text), finalResult: parseResponse(text) });
    }
    if (action === "geogebra_analyze") {
      const p = generateGeogebraPrompt(payload.questionText || "", payload.answerText || "", payload.analysis || "", payload.previousErrors);
      const text = await chat({ systemPrompt: p, userText: "生成 GeoGebra 命令", stream: false });
      return json({ commands: text, result: text });
    }
    if (action === "practice_generate") {
      const p = generateSimilarQuestionPrompt(
        language, payload.originalQuestion || "", payload.knowledgePoints || [],
        payload.difficulty || "medium", options, payload.gradeSemester ?? null,
      );
      const text = await chat({ systemPrompt: p, userText: "生成同类题", stream: false });
      return json(parseResponse(text));
    }
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
