/**
 * 批量导入后台执行器（自链式 worker）。
 *
 * 关键约束与设计：
 * 1. Edge Function 单次调用约 150s 硬上限。每轮既有「软预算」也有「硬截止」：
 *    软预算到点交棒给下一轮；硬截止保证哪怕一张图卡住，本轮也一定在函数被杀之前
 *    收尾返回，绝不把条目留在 processing。写完库、刷新 heartbeatAt 后再自调用，
 *    因此执行不依赖浏览器——关页、换设备、重新登录都不影响任务。
 * 2. 每张图处理前用条件 PATCH 抢占（status=pending → processing），
 *    防止两个 worker 同时处理同一条；处理期间定时刷新 updatedAt 作为「存活心跳」。
 * 3. 同轮内只有「模型返回了内容但漏标签」才自动降级深度重试，且两段共享同一个
 *    AbortSignal 与总预算；超时/网络错误绝不在本轮重跑（两段累计必然撞函数上限）。
 *    这些瞬时故障改为把条目拨回 pending、由下一轮（新的调用）重试，最多 MAX_ATTEMPTS
 *    次——既拿回 v1.19.8 之前「超时再试一次」的成功率，又不会撞平台上限。
 *    降级后置 autoDeepRetry=true，确认列表里明确标注（费用与时长会上浮）。
 * 4. 批量不做「反向代入验算」：验算在深度模式下本身可长达 120s，
 *    一旦触发必然撞上函数上限。改为把答案冲突信息落库，由确认列表提示人工核对。
 * 5. 并发闸门：用户反复点「重试/继续」会拉起多条 worker 链。每轮开头先回收僵死条目，
 *    若仍有「心跳还新鲜」的 processing，说明别人正在干活，本实例立刻退出且不自调用，
 *    多条链自然收敛成一条。attempts 上限在抢占时判定，不再依赖会被并发刷新的 updatedAt。
 */

import { generateAnalyzePrompt } from "../ai-proxy/lib/prompts.ts";
import {
  sanitizeBodyText, extractTagSafe, parseMistakeFieldsFromResponse,
  withoutMistakeAnalysis, shouldStopGeneration,
} from "../ai-proxy/lib/response-guard.ts";
import { deriveAnswerFromAnalysis } from "../ai-proxy/lib/answer-consistency.ts";
import { resolveSubject } from "../ai-proxy/lib/subject-resolve.ts";
import {
  PER_ITEM_TIMEOUT_MS, MAX_ATTEMPTS,
  attemptsExhausted, canStartItem, itemBudgetMs, shouldRetryDeep, shouldRetryItem,
} from "./policy.ts";

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

/** 每轮处理的软预算：到点交棒给下一轮，避免单轮过长 */
const ROUND_BUDGET_MS = 55_000;
/**
 * 单轮硬截止：平台 150s 会直接杀进程，留 10s 给自调用、收尾和网络抖动。
 * 单张预算恢复到 120s 后硬截止必须同步抬到 140s，否则 canStartItem 的
 * 128s 门槛会让整轮一张都开不了；超过这个点本轮必须停止开新条目并返回。
 * 软预算 55s 保证一轮最多跑一张慢图，最坏约 120s + 收尾，不会撞上限。
 */
const ROUND_HARD_DEADLINE_MS = 140_000;
/** processing 存活心跳间隔；活实例的条目永远不会显得「僵死」 */
const ITEM_HEARTBEAT_MS = 15_000;
/** 僵死回收窗口：大于心跳间隔，小于单张超时，被杀的条目最多 45s 就能被下一轮接管 */
const STALE_MS = 45_000;
/** 超过这个时间没心跳就算「别人不在了」，可以接管 */
const FRESH_HEARTBEAT_MS = 40_000;

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

/**
 * 图片引用 → 裸 base64。
 *
 * 批次表里的 imageBase64 现在存的是图片引用（前端 storage 层写入）：
 *   - 现在是 data URL 或裸 base64 → 去掉前缀即可；
 *   - 以后换成对象存储会是 https 地址 → 这里拉一次二进制再转 base64。
 * 放在 worker 里而不是复用前端模块：Deno 运行时导不进 src/lib，逻辑只有这几行。
 */
async function resolveImage(ref: string): Promise<string> {
  const s = String(ref || "").trim();
  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s);
    if (!res.ok) throw new Error(`IMAGE_FETCH_${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  return s.replace(/^data:[^;]+;base64,/, "");
}

async function analyzeOne(
  imageBase64: string,
  reasoningMode: "fast" | "deep",
  budgetMs: number,
): Promise<{ parsed: ReturnType<typeof parseAnalyzeResponse>; autoDeepRetry: boolean }> {
  const clean = await resolveImage(imageBase64);
  const systemPrompt = generateAnalyzePrompt("zh", null, null, {}, null);

  // fast 与 deep（如果触发）共用同一个 AbortController 和同一个 deadline，
  // 两段加起来绝不会超过 budget，也就不会把单次调用拖过平台上限。
  const budget = Math.max(1_000, Math.min(PER_ITEM_TIMEOUT_MS, budgetMs));
  const deadline = Date.now() + budget;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);

  const run = async (mode: "fast" | "deep") => {
    const text = await chatAnalyze(systemPrompt, clean, mode, ac.signal);
    return parseAnalyzeResponse(text);
  };

  try {
    return { parsed: await run(reasoningMode), autoDeepRetry: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 只有「模型返回了内容但漏标签」才降级；超时 / 网络 / 额度错误一律直接失败。
    if (shouldRetryDeep(reasoningMode, msg, ac.signal.aborted, deadline - Date.now())) {
      console.log("[batch-worker] fast missing tags, deep retry within same budget:", msg);
      return { parsed: await run("deep"), autoDeepRetry: true };
    }
    throw e;
  } finally {
    clearTimeout(timer);
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

/**
 * 并发闸门：统计「心跳还新鲜」的 processing 条目数。
 *
 * 单个 worker 是串行的，一轮内最多只会有 1 条 processing；出现 ≥2 条就说明
 * 用户反复点「重试/继续」拉起了多条 worker 链，它们正互相抢模型并发——
 * 越抢越慢、越慢越超时、越超时越重启。此时本实例必须退出且不自我续链。
 *
 * 只看 1 条不退出：那可能是本链上一轮被杀留下的残留（心跳还没过期），
 * 交给下面的 reclaimStale / 下一轮接管，避免自己把自己锁死。
 */
async function countActiveProcessing(jobId: string): Promise<number> {
  const cutoff = new Date(Date.now() - FRESH_HEARTBEAT_MS).toISOString();
  const rows = await rest<any[]>(
    `/BatchItem?select=id&jobId=eq.${enc(jobId)}&status=eq.processing&updatedAt=gt.${enc(cutoff)}`,
  ).catch(() => []);
  return rows?.length || 0;
}

/**
 * 回收「僵死条目」：worker 抢占某条后若被平台杀掉（单次调用超时），
 * 该条会永远停在 processing，而 worker 只挑 pending，整批就永久卡死。
 * 这里把超过 staleMs 未更新的条目拨回 pending；重试次数用尽的直接标 failed。
 *
 * 旧版窗口 3 分钟且只看 updatedAt：用户反复点「重启」会拉起多条 worker，
 * 它们轮流抢占同一批条目、不断刷新 updatedAt，条件永远不成立，于是整批
 * 看起来永远「解析中」。现在窗口缩短 + 活实例每 15s 主动刷心跳，两者配合
 * 才能区分「别人正在干活」和「上一轮被平台杀掉」。
 */
async function reclaimStale(jobId: string, staleMs = STALE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const base = `/BatchItem?jobId=eq.${enc(jobId)}&status=eq.processing&updatedAt=lt.${enc(cutoff)}`;
  const now = new Date().toISOString();
  const back = await rest<any[]>(`${base}&attempts=lt.${MAX_ATTEMPTS}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "pending", failureReason: null, updatedAt: now }),
  }).catch(() => []);
  await rest(`${base}&attempts=gte.${MAX_ATTEMPTS}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "failed", failureReason: "处理中断（多次超时），可单独重试", updatedAt: now }),
  }).catch(() => {});
  return (back || []).length;
}

/** 无 pending 却仍有剩余时：把卡住的条目直接判失败，避免整批永久停在「解析中」 */
async function failStuck(jobId: string, staleMs = STALE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const rows = await rest<any[]>(
    `/BatchItem?jobId=eq.${enc(jobId)}&status=eq.processing&updatedAt=lt.${enc(cutoff)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "failed", failureReason: "处理中断，可点重试单独补跑", updatedAt: new Date().toISOString() }),
    },
  ).catch(() => []);
  return (rows || []).length;
}

/** 当前批次跑完后，把同账号排队最久的一批拉起来 */
async function startNextQueued(userId: string, currentJobId: string): Promise<void> {
  try {
    const rows = await rest<any[]>(
      `/BatchJob?select=id&userId=eq.${enc(userId)}&status=eq.queued&order=createdAt.asc&limit=1`,
    );
    const next = rows?.[0];
    if (!next || next.id === currentJobId) return;
    await patchJob(next.id, { status: "processing", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    selfInvoke(next.id);
  } catch (e) {
    console.error("[batch-worker] startNextQueued failed:", e);
  }
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
  const softDeadline = startedAt + ROUND_BUDGET_MS;
  const hardDeadline = startedAt + ROUND_HARD_DEADLINE_MS;
  let processed = 0;
  // 本轮已拨回 pending 的条目不允许在本轮立刻重跑：两次 120s 累计会撞 150s 上限
  const requeued = new Set<string>();
  console.log(`[batch-worker] v1.19.10 round start job=${jobId} mode=${mode}`);

  // 上一轮被平台杀掉时留下的 processing 条目，先拨回 pending / failed，否则永远轮不到它
  await reclaimStale(jobId).catch(() => 0);

  // 并发闸门：≥2 条活跃 processing ⇒ 多实例并发，本链退出且不续链，
  // 用户反复点「重试/继续」拉起的多条链会这样自然收敛成一条。
  const activeCount = await countActiveProcessing(jobId);
  if (activeCount >= 2) {
    console.log(`[batch-worker] ${activeCount} concurrent workers, yield job=${jobId}`);
    await patchJob(jobId, { heartbeatAt: new Date().toISOString() });
    return { processed: 0, remaining: 0, status: "busy" };
  }

  while (canStartItem(hardDeadline, Date.now(), softDeadline)) {
    const pending = await rest<any[]>(
      `/BatchItem?select=*&jobId=eq.${enc(jobId)}&status=eq.pending&order=idx.asc&limit=8`,
    );
    // 跳过本轮刚拨回 pending 的条目，让它们的重试落到下一轮（新的一次 150s 调用）
    const item = pending?.find((p) => !requeued.has(p.id));
    if (!item) break;

    // 尝试次数在抢占阶段判定，不依赖会被并发不断刷新的 updatedAt
    if (attemptsExhausted(item.attempts || 0, MAX_ATTEMPTS)) {
      await patchItem(item.id, {
        status: "failed",
        failureReason: "多次解析超时，建议裁掉空白只留题目后单独重试",
      });
      continue;
    }

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

    // 处理期间定时刷 updatedAt：让并发闸门能认出「这条是活的」，
    // 同时保证被平台杀掉后最多 45s 就能被下一轮回收，不会永远停在解析中。
    const heartbeat = setInterval(() => {
      patchItem(item.id, {}).catch(() => {});
    }, ITEM_HEARTBEAT_MS);

    try {
      const { parsed, autoDeepRetry } = await analyzeOne(
        item.imageBase64, mode, itemBudgetMs(hardDeadline, Date.now()),
      );
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
      const aborted = /signal has been aborted/i.test(msg);
      // v1.19.8 之前（11-14 凌晨 15/15 全成功）超时会自动再跑一次；v1.19.8/1.19.9
      // 改成超时直接 failed，结果 16 张失败图 attempts 全是 1。这里把重试机会拿回来，
      // 但用「拨回 pending + 下一轮再跑」实现——同轮连跑两次 120s 会撞平台 150s 上限，
      // 进程被杀、条目永远停在 processing，正是「永远解析中」的根因。
      if (!quota && shouldRetryItem(msg, aborted, item.attempts || 0, MAX_ATTEMPTS)) {
        await patchItem(item.id, { status: "pending", failureReason: null });
        requeued.add(item.id);
        console.log(
          `[batch-worker] item ${item.id} transient failure, requeued for next round ` +
          `(attempt ${(item.attempts || 0) + 1}/${MAX_ATTEMPTS}): ${msg.slice(0, 120)}`,
        );
      } else {
        await patchItem(item.id, {
          status: "failed",
          failureReason: quota ? "AI 额度不足，充值后可在确认列表中重试" : msg.slice(0, 300),
        });
      }
      if (quota) {
        // 整批暂停：继续跑只会把剩下的全打成 failed
        await patchJob(jobId, { status: "paused", errorMessage: "AI 额度不足，已暂停", heartbeatAt: new Date().toISOString() });
        const c = await recount(jobId);
        return { processed, remaining: c.total - c.done - c.failed, status: "paused" };
      }
    } finally {
      clearInterval(heartbeat);
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

  let c = await recount(jobId);
  let remaining = Math.max(0, c.total - c.done - c.failed);

  if (remaining > 0) {
    // 还有剩余但没有待处理条目：剩下的都卡在 processing（多半是上一轮被杀留下的）。
    const pendingLeft = await rest<any[]>(
      `/BatchItem?select=id&jobId=eq.${enc(jobId)}&status=eq.pending&limit=1`,
    ).catch(() => []);
    if (!pendingLeft?.length) {
      const reclaimed = await reclaimStale(jobId);
      if (reclaimed > 0) {
        selfInvoke(jobId);
        return { processed, remaining, status: "processing" };
      }
      const dead = await failStuck(jobId);
      if (dead > 0) {
        c = await recount(jobId);
        remaining = Math.max(0, c.total - c.done - c.failed);
      }
      // 走到这里说明还有心跳新鲜的 processing 在跑。旧版此处无条件 selfInvoke，
      // 多实例并发时每轮都会抢占 → 刷新 updatedAt → 状态刷回 processing，
      // 界面就永远「解析中」。现在：并发时不再续链（交给活着的链），
      // 单链残留时保留续链，保证 45s 后僵死条目能被下一轮接管。
      await patchJob(jobId, { heartbeatAt: new Date().toISOString() });
      if ((await countActiveProcessing(jobId)) >= 2) {
        return { processed, remaining, status: "waiting" };
      }
    }
  }

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
    // 本批跑完 → 立刻拉起同账号排队中的下一批，否则它会一直停在 queued
    await startNextQueued(job.userId, jobId);
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

  // 调用级版本标记：不依赖 job 是否存在，运维用日志就能确认线上跑的是哪一版
  console.log(`[batch-worker] v1.19.10 invoke job=${jobId}`);

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
