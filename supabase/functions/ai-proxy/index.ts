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
import { deriveAnswerFromAnalysis, findConclusionExpr, answersEquivalent, intervals } from "./lib/answer-consistency.ts";
import { resolveSubject } from "./lib/subject-resolve.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
// 主模型：火山引擎方舟（豆包），OpenAI 兼容端点。可用 OPENAI_* 秘密覆盖。
const BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3";
const MODEL = Deno.env.get("OPENAI_MODEL") || "doubao-seed-2-1-lite-260915";

/**
 * 重新解题里「深度思考」的时间预算（毫秒）。
 * Edge Function 单次请求墙钟上限 150s，超时会被平台直接杀掉（546 WORKER_RESOURCE_LIMIT），
 * 前端只能看到一句「重新解题失败」。留 95s 给 deep，剩余 ~50s 给快速模式兜底。
 */
const REANSWER_DEEP_BUDGET_MS = 95_000;

function extractTag(text: string, tag: string) { return extractTagSafe(text, tag, tag === "analysis"); }

/** data URL 或裸 base64 → 可直接喂给 chat() 的 { imageBase64, mimeType } */
function parseImagePayload(raw: unknown): { imageBase64?: string; mimeType?: string } {
  const value = String(raw || "");
  if (!value) return {};
  const m = value.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (m) return { imageBase64: m[2].trim(), mimeType: m[1] || "image/jpeg" };
  return { imageBase64: value.trim(), mimeType: "image/jpeg" };
}

/** 与 src/lib/ai/openai-provider.ts#parseResponse 同源 */
function parseResponse(text: string, fallbackQuestionText?: string) {
  // 文字解题时调用方已经持有题干，模型漏写 <question_text> 不该整单失败
  const rawQuestion = extractTag(text, "question_text") || (fallbackQuestionText || "").trim();
  const rawAnalysis = extractTag(text, "analysis");
  // <answer_text> 是首选来源；只有当模型整段漏掉这个标签时才回退到正文里的 <final_answer>
  // （关闭思考的「快速」模式更容易漏标签）。绝不反向：标签存在时绝不会被正文结论覆盖。
  const finalTag = rawAnalysis.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  const finalAnswer = finalTag ? finalTag[1].trim() : "";
  const tagAnswer = extractTag(text, "answer_text");
  const rawAnswer = tagAnswer || finalAnswer;
  if (!rawQuestion || !rawAnswer || !rawAnalysis) {
    throw new Error("Invalid AI response: Missing critical XML tags");
  }
  if (!tagAnswer) {
    console.log("[ai-proxy] <answer_text> missing, fallback to <final_answer>");
  }
  // 单一真相源 = 模型提交的答案（<final_answer> 或 answer_text），全篇只此一份。
  // 解析正文里的「结论区间」仅用于冲突检测，绝不反向覆盖已提交答案：
  // 覆盖会在两种情况下翻车——提交答案对但解析末尾改口成错（本次事故），或反之（旧问题）。
  // 故 deriveAnswerFromAnalysis 永不自动覆盖，冲突只上报告警交人工裁决。
  // <final_answer> 标签由 sanitizeBodyText 的 stripLeakedTags 剥离。
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
  // 学科：模型自报值只作弱提示，用题干+解析+知识点全文证据校正（避免「其他」误归档）
  const subjectInfo = resolveSubject(subjectRaw || "", questionText, analysis, knowledgePoints);
  if (subjectInfo.changed) {
    console.log(
      `[ai-proxy] subject corrected: tag="${subjectInfo.tag}" -> "${subjectInfo.subject}"`,
      JSON.stringify(subjectInfo.scores),
    );
  }
  return withoutMistakeAnalysis({
    questionText, answerText, analysis,
    wrongAnswerText: mistake.wrongAnswerText,
    mistakeAnalysis: mistake.mistakeAnalysis,
    mistakeStatus: mistake.mistakeStatus,
    subject: subjectInfo.subject,
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

/**
 * 解析思考模式：deep（默认，开思考）/ fast（关闭思考）。
 * 存于 AppSetting.app_config_public.reasoningMode，设置页可改，无需重新部署。
 * 匿名 key 即可读取（RLS 只放行 app_config_public），60 秒缓存避免每次请求多打一次库。
 */
let reasoningModeCache: { mode: "deep" | "fast"; at: number } | null = null;

async function readReasoningMode(): Promise<"deep" | "fast"> {
  if (reasoningModeCache && Date.now() - reasoningModeCache.at < 60_000) {
    return reasoningModeCache.mode;
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/AppSetting?key=eq.app_config_public&select=value`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } },
    );
    const rows = await res.json();
    const cfg = JSON.parse(rows?.[0]?.value || "{}");
    const mode = cfg?.reasoningMode === "fast" ? "fast" : "deep";
    reasoningModeCache = { mode, at: Date.now() };
    return mode;
  } catch {
    return "deep";
  }
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
  /** 豆包思考强度：deep=默认开思考，fast=关闭思考（设置页可配） */
  reasoningMode?: "deep" | "fast";
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
  // 豆包（方舟）：默认自带深度思考（reasoning_effort=high），显式关闭需要 thinking.type
  const isDoubao = /doubao|seed/i.test(creds.model) || creds.baseUrl.includes("ark.cn-beijing");
  if (isDoubao && opts.reasoningMode === "fast") {
    body.thinking = { type: "disabled" };
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
  reasoningMode: "deep" | "fast" = "deep",
): Promise<string> {
  const prompt = generateVerifyPrompt(questionText, bodyConclusion, tagAnswer, language);
  const text = await chat({
    systemPrompt: prompt,
    userText: "请完成反向代入验算，并只输出 <verified> 与 <reason> 两个标签。",
    stream: false,
    enableThinking: false,
    reasoningMode,
  });
  const m = text.match(/<verified>\s*([\s\S]*?)\s*<\/verified>/i);
  if (!m) return "";
  let verified = m[1].trim();
  // 模型常把「候选 A / 候选 B：」前缀写进 <verified>，必须剥离，否则会泄漏进参考答案。
  verified = verified.replace(/^候选\s*[AB]\s*[:：]\s*/i, "").trim();
  // 归一到两个候选原文之一：若与某个候选等价，返回该候选的规范文本，杜绝脏格式。
  // 顺序：优先正文推理结论，再回退标签值。
  const candidates = [bodyConclusion, tagAnswer].filter(Boolean);
  for (const c of candidates) {
    if (answersEquivalent(verified, c)) return sanitizeBodyText(c);
  }
  // 次生兜底：verified 可能只含区间片段，按「最后一个区间等价」匹配候选。
  const vi = intervals(verified);
  if (vi.length) {
    for (const c of candidates) {
      const ci = intervals(c);
      if (ci.length && ci[ci.length - 1] === vi[vi.length - 1]) return sanitizeBodyText(c);
    }
  }
  // 验算结果无法归一到任一候选（模型自创第三值）→ 返回空，
  // 由上层回退到「正文推理结论」，绝不把来源不明的值写进参考答案。
  return "";
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
  reasoningMode: "deep" | "fast" = "deep",
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
      parsed.questionText, bodyConclusion, tagAnswer, language, reasoningMode,
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
  // 思考深度由前端逐题下发（设置页已不再提供全局开关）；
  // 没带时回落到 AppSetting 里的全局值，最后兜底 deep。
  const requestedMode =
    payload.reasoningMode === "fast" || payload.reasoningMode === "deep"
      ? (payload.reasoningMode as "deep" | "fast")
      : null;
  const reasoningMode = requestedMode ?? (await readReasoningMode());

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
          // 豆包/推理模型会把「思考」也计入 completion tokens；给足空间，
          // 避免思考+作答被 8192 截断导致 <analysis>/<final_answer> 标签缺失而报错。
          maxTokens: 16000,
          reasoningMode,
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
          const decided = await decideReferenceAnswer(primaryText, result, payload, language, reasoningMode);
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
      const userGuidance = String(payload.guidance || "").trim();
      const lockedAnswer = String(payload.lockedAnswerText || "").trim();
      const p = generateReanswerPrompt(
        language, payload.questionText || "", payload.subject || null, options,
        payload.gradeSemester ?? null, userGuidance, lockedAnswer,
      );
      const image = parseImagePayload(payload.imageBase64);
      const startedAt = Date.now();
      const base = {
        systemPrompt: p,
        ...image,
        userText: image.imageBase64 ? undefined : "请重新解答",
        stream: false,
        // 与 analyze 对齐：思考 + 作答都算 completion tokens，给足空间避免被截断
        maxTokens: 16000,
      };

      // 平台硬限制：单次请求 150s 墙钟（Free plan），超过直接被 worker 杀掉返回 546。
      // 深度思考遇到长题很容易突破 150s，所以给 deep 留一条明确的预算线，
      // 超预算立刻降级为快速模式，保证用户一定能拿到结果，并如实告知降级。
      let text = "";
      let usedMode: "deep" | "fast" = reasoningMode;
      let degraded = false;
      if (reasoningMode === "deep") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REANSWER_DEEP_BUDGET_MS);
        try {
          text = await chat({ ...base, reasoningMode: "deep", signal: controller.signal });
          console.log(`[ai-proxy] reanswer deep ok in ${Date.now() - startedAt}ms`);
        } catch (e) {
          if (!controller.signal.aborted) throw e;
          console.warn(`[ai-proxy] reanswer deep aborted at ${REANSWER_DEEP_BUDGET_MS}ms, fallback to fast`);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!text) {
        if (reasoningMode === "deep") degraded = true;
        usedMode = "fast";
        text = await chat({ ...base, reasoningMode: "fast" });
        console.log(`[ai-proxy] reanswer fast done in ${Date.now() - startedAt}ms`);
      }
      const parsed = parseResponse(text, payload.questionText || "");
      // 用户锁定答案时，答案以用户为准，模型只贡献解析（防止它又把答案改回去）
      if (lockedAnswer) parsed.answerText = lockedAnswer;
      return json({ ...parsed, finalResult: parsed, usedMode, degraded, answerLocked: !!lockedAnswer });
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
