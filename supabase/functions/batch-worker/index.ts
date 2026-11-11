/**
 * 批量导入后台执行器（自链式 worker）。
 *
 * 关键约束与设计：
 * 1. Edge Function 单次调用约 150s 上限，所以每轮只处理到「约 60s 预算」，
 *    写完库、刷新 heartbeatAt 后立刻再调用自己，响应先返回。
 *    因此执行不依赖浏览器——关页、换设备、重新登录都不影响任务。
 * 2. 每张图处理前用条件 PATCH 抢占（status=pending → processing），
 *    防止两个 worker 同时处理同一条。
 * 3. 快速模式下若模型漏了关键标签，自动用深度模式重跑这一张，
 *    并置 autoDeepRetry=true，确认列表里明确标注（费用与时长会上浮）。
 * 4. 批量不做「反向代入验算」：验算在深度模式下本身可长达 120s，
 *    一旦触发必然撞上函数上限。改为把答案冲突信息落库，由确认列表提示人工核对。
 */

import { generateAnalyzePrompt } from "../ai-proxy/lib/prompts.ts";
import {
  sanitizeBodyText, extractTagSafe, parseMistakeFieldsFromResponse,
  withoutMistakeAnalysis, shouldStopGeneration,
} from "../ai-proxy/lib/response-guard.ts";
import { deriveAnswerFromAnalysis } from "../ai-proxy/lib/answer-consistency.ts";
import { resolveSubject } from "../ai-proxy/lib/subject-resolve.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3";
const MODEL = Deno.env.get("OPENAI_MODEL") || "doubao-seed-2-1-lite-260915";

/** 每轮处理的软预算：留足余量给「快速失败→深度重试」的单张回退 */
const ROUND_BUDGET_MS = 60_000;
/** 单张解析硬超时：深度模式实测 70–85s，给到 120s */
const PER_ITEM_TIMEOUT_MS = 120_000;

/* --------------------------------- REST --------------------------------- */

function svcHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: svcHeaders((init.headers as Record<string, string>) || {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`REST ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

const enc = (v: string) => encodeURIComponent(v);

async function patchJob(id: string, patch: Record<string, any>) {
  await rest(`/BatchJob?id=eq.${enc(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updatedAt: new Date().toISOString() }),
  });
}

async function patchItem(id: string, patch: Record<string, any>) {
  await rest(`/BatchItem?id=eq.${enc(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updatedAt: new Date().toISOString() }),
  });
}

/* -------------------------------- 解析核心 -------------------------------- */

function extractTag(text: string, tag: string) {
  return extractTagSafe(text, tag, tag === "analysis");
}

/** 批量版解析：与 ai-proxy#parseResponse 同源，但不做反向代入验算（会超时）。 */
function parseAnalyzeResponse(text: string) {
  const rawQuestion = extractTag(text, "question_text");
  const rawAnalysis = extractTag(text, "analysis");
  const finalTag = rawAnalysis.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  const finalAnswer = finalTag ? finalTag[1].trim() : "";
  const tagAnswer = extractTag(text, "answer_text");
  const rawAnswer = tagAnswer || finalAnswer;
  if (!rawQuestion || !rawAnswer || !rawAnalysis) {
    throw new Error("Missing critical XML tags");
  }
  const derived = deriveAnswerFromAnalysis(rawAnalysis, rawAnswer, finalAnswer);
  const questionText = sanitizeBodyText(rawQuestion);
  const answerText = sanitizeBodyText(derived.answerText);
  const analysis = sanitizeBodyText(rawAnalysis);
  const mistake = parseMistakeFieldsFromResponse(text, (t) => extractTag(text, t), answerText);
  const pointsRaw = extractTag(text, "knowledge_points");
  const knowledgePoints = pointsRaw
    ? pointsRaw.split(/[,，\n]/).map((k) => k.trim()).filter(Boolean).slice(0, 5)
    : [];
  const subjectInfo = resolveSubject(
    extractTag(text, "subject") || "", questionText, analysis, knowledgePoints,
  );
  return withoutMistakeAnalysis({
    questionText,
    answerText,
    analysis,
    wrongAnswerText: mistake.wrongAnswerText,
    mistakeAnalysis: mistake.mistakeAnalysis,
    mistakeStatus: mistake.mistakeStatus,
    subject: subjectInfo.subject,
    knowledgePoints,
    answerConflict: derived.conflict === true,
    originalAnswerText: derived.originalAnswerText || null,
  }, true);
}

async function chatAnalyze(
  systemPrompt: string,
  imageBase64: string,
  reasoningMode: "fast" | "deep",
  signal: AbortSignal,
): Promise<string> {
  const body: any = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }],
      },
    ],
    max_tokens: 16000,
    stream: false,
  };
  // 与单题流程一致：豆包默认自带深度思考，显式关闭只能靠 thinking.type
  if (reasoningMode === "fast") body.thinking = { type: "disabled" };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err: any = new Error(`AI_HTTP_${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || "";
  if (shouldStopGeneration(content)) return content;
  return content;
}

async function analyzeOne(
  imageBase64: string,
  reasoningMode: "fast" | "deep",
): Promise<{ parsed: ReturnType<typeof parseAnalyzeResponse>; autoDeepRetry: boolean }> {
  const clean = imageBase64.replace(/^data:[^;]+;base64,/, "");
  const systemPrompt = generateAnalyzePrompt("zh", null, null, {}, null);

  const run = async (mode: "fast" | "deep") => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PER_ITEM_TIMEOUT_MS);
    try {
      const text = await chatAnalyze(systemPrompt, clean, mode, ac.signal);
      return parseAnalyzeResponse(text);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return { parsed: await run(reasoningMode), autoDeepRetry: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 快速模式漏标签是最常见的失败，自动用深度重跑一次（用户已在方案里确认）
    if (reasoningMode === "fast" && /Missing critical XML tags|aborted/i.test(msg)) {
      console.log("[batch-worker] fast mode failed, retrying with deep:", msg);
      return { parsed: await run("deep"), autoDeepRetry: true };
    }
    throw e;
  }
}

/* ------------------------------- 学科落库 -------------------------------- */

async function resolveSubjectId(userId: string, name: string): Promise<string | null> {
  const subject = (name || "").trim();
  if (!subject || subject === "其他") return null;
  const rows = await rest<any[]>(
    `/Subject?select=id,name&userId=eq.${enc(userId)}&name=eq.${enc(subject)}&limit=1`,
  ).catch(() => []);
  if (rows?.[0]?.id) return rows[0].id;
  // 与单题流程一致：学科不存在时按需创建，避免批量导入全落到「未分类」
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 25);
  const now = new Date().toISOString();
  await rest("/Subject", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ id, name: subject, userId, createdAt: now, updatedAt: now }),
  }).catch(() => {});
  return id;
}

/* -------------------------------- worker -------------------------------- */

function selfInvoke(jobId: string) {
  const p = fetch(`${SUPABASE_URL}/functions/v1/batch-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  }).catch((e) => console.error("[batch-worker] self invoke failed:", e));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
  return p;
}

async function recount(jobId: string) {
  const items = await rest<any[]>(`/BatchItem?select=status&jobId=eq.${enc(jobId)}`);
  const done = items.filter((i) => i.status === "done" || i.status === "saved").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const saved = items.filter((i) => i.status === "saved").length;
  return { total: items.length, done, failed, saved };
}

async function runRound(jobId: string): Promise<{ processed: number; remaining: number; status: string }> {
  const jobRows = await rest<any[]>(`/BatchJob?select=*&id=eq.${enc(jobId)}&limit=1`);
  const job = jobRows?.[0];
  if (!job) throw new Error("Job not found");
  if (job.status === "canceled" || job.status === "done") {
    return { processed: 0, remaining: 0, status: job.status };
  }

  if (job.status === "queued") {
    await patchJob(jobId, {
      status: "processing",
      startedAt: job.startedAt || new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
  }

  const mode: "fast" | "deep" = job.reasoningMode === "deep" ? "deep" : "fast";
  const startedAt = Date.now();
  let processed = 0;

  while (Date.now() - startedAt < ROUND_BUDGET_MS) {
    const pending = await rest<any[]>(
      `/BatchItem?select=*&jobId=eq.${enc(jobId)}&status=eq.pending&order=idx.asc&limit=1`,
    );
    if (!pending?.length) break;
    const item = pending[0];

    // 条件 PATCH 抢占：只有仍处于 pending 的那一条会被更新，返回空表示被别人抢走
    const claimed = await rest<any[]>(
      `/BatchItem?id=eq.${enc(item.id)}&status=eq.pending`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          status: "processing",
          attempts: (item.attempts || 0) + 1,
          updatedAt: new Date().toISOString(),
        }),
      },
    );
    if (!claimed?.length) continue;

    try {
      const { parsed, autoDeepRetry } = await analyzeOne(item.imageBase64, mode);
      const subjectId = await resolveSubjectId(job.userId, parsed.subject);
      await patchItem(item.id, {
        status: "done",
        questionText: parsed.questionText,
        answerText: parsed.answerText,
        analysis: parsed.analysis,
        subjectId,
        subjectName: parsed.subject || null,
        knowledgePoints: JSON.stringify(parsed.knowledgePoints || []),
        autoDeepRetry,
        answerConflict: parsed.answerConflict === true,
        originalAnswerText: parsed.originalAnswerText || null,
        failureReason: null,
      });
      processed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[batch-worker] item ${item.id} failed:`, msg);
      const quota = /AI_HTTP_402|AI_HTTP_403|AccountOverdue|quota|额度/i.test(msg);
      await patchItem(item.id, {
        status: "failed",
        failureReason: quota ? "AI 额度不足，充值后可在确认列表中重试" : msg.slice(0, 300),
      });
      if (quota) {
        // 整批暂停：继续跑只会把剩下的全打成 failed
        await patchJob(jobId, { status: "paused", errorMessage: "AI 额度不足，已暂停", heartbeatAt: new Date().toISOString() });
        const c = await recount(jobId);
        return { processed, remaining: c.total - c.done - c.failed, status: "paused" };
      }
    }

    const c = await recount(jobId);
    await patchJob(jobId, {
      heartbeatAt: new Date().toISOString(),
      doneCount: c.done,
      failedCount: c.failed,
      savedCount: c.saved,
      totalCount: c.total,
    });
  }

  const c = await recount(jobId);
  const remaining = c.total - c.done - c.failed;
  if (remaining <= 0) {
    await patchJob(jobId, {
      status: "confirming",
      finishedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      doneCount: c.done,
      failedCount: c.failed,
      savedCount: c.saved,
      totalCount: c.total,
    });
    return { processed, remaining: 0, status: "confirming" };
  }
  // 先续上下一轮，再返回；waitUntil 保证响应结束后仍会发出请求
  selfInvoke(jobId);
  return { processed, remaining, status: "processing" };
}

/**
 * 内部自调用识别：平台注入的 SERVICE_ROLE_KEY 直接比对；
 * 另外兼容 legacy service_role JWT（payload.role === "service_role"），
 * 便于运维/测试用同一把 key 手动触发。用户 token 永远不会命中。
 */
function isServiceToken(token: string): boolean {
  if (token && token === SERVICE_KEY) return true;
  try {
    const part = token.split(".")[1];
    if (!part) return false;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function assertOwner(token: string, jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const u = await res.json();
    const rows = await rest<any[]>(`/BatchJob?select=id,userId&id=eq.${enc(jobId)}&limit=1`);
    const job = rows?.[0];
    if (!job) return false;
    // 注意：库里该列名是 auth_user_id（schema.sql 里的 auth_uid 是历史写法）
    const users = await rest<any[]>(`/User?select=id&auth_user_id=eq.${enc(u.id)}&limit=1`);
    return users?.[0]?.id === job.userId;
  } catch (e) {
    console.error("[batch-worker] assertOwner failed:", e);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SERVICE_KEY) return json({ error: "SERVICE_ROLE_KEY missing" }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  let jobId = "";
  try {
    const body = await req.json();
    jobId = String(body.jobId || "");
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!jobId) return json({ error: "Missing jobId" }, 400);

  const internal = isServiceToken(token);
  if (!internal && !(await assertOwner(token, jobId))) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!API_KEY) return json({ error: "AI_NOT_CONFIGURED" }, 503);

  try {
    const result = await runRound(jobId);
    return json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[batch-worker] round failed:", msg);
    await patchJob(jobId, { status: "paused", errorMessage: msg.slice(0, 300) }).catch(() => {});
    return json({ ok: false, error: msg }, 500);
  }
});
