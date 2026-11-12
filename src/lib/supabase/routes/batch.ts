/**
 * 批量导入：批次创建、查询、确认入库、重试/继续、取消。
 *
 * 执行本身不在浏览器里：创建批次后触发 Edge Function batch-worker，
 * 由它自链式跑完。这里只负责「投递任务」和「读状态 / 写结果」。
 */
import { accessToken, cuid, nowIso, requireUser, restJson } from "../core";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../config";
import { apiError, json, type RouteHandler } from "../http";
import { buildItem, linkTags } from "./error-items";

const WORKER_URL = `${SUPABASE_URL}/functions/v1/batch-worker`;
/** 单批上限：与产品约定一致（约 3MB 图片，深度模式约 30 分钟跑完） */
const MAX_BATCH = 30;
/** 活跃态：用于首页横幅与并发约束 */
const ACTIVE_STATUSES = ["queued", "processing", "confirming", "paused"];

/** 后台任务不存在「请求-响应」生命周期，触发后不等待，交给 keepalive 送出 */
function kickWorker(jobId: string): void {
  void accessToken().then((token) => {
    fetch(WORKER_URL, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ jobId }),
    }).catch(() => {});
  });
}

function publicItem(row: Record<string, any>) {
  // 列表/确认页不拉原图（单张 200KB，30 张会把详情接口拖到 6MB）
  const { imageBase64, ...rest } = row;
  let points: string[] = [];
  try {
    points = JSON.parse(rest.knowledgePoints || "[]");
  } catch {
    points = [];
  }
  return { ...rest, knowledgePoints: points, hasImage: !!imageBase64 };
}

async function loadJob(jobId: string, userId: string) {
  const rows = await restJson<any[]>(
    `/BatchJob?select=*&id=eq.${encodeURIComponent(jobId)}&userId=eq.${encodeURIComponent(userId)}&limit=1`,
  ).catch(() => []);
  return rows?.[0] || null;
}

/** 创建批次后要等多久 / 花多少钱，前端也算，这里给一份同一口径的估算 */
function estimate(count: number, mode: "fast" | "deep") {
  const perItemSec = mode === "deep" ? 80 : 20;
  const perItemCost = mode === "deep" ? 0.019 : 0.008;
  return {
    etaSeconds: count * perItemSec,
    estimatedCost: Number((count * perItemCost).toFixed(2)),
  };
}

export const BATCH_HANDLERS: RouteHandler[] = [
  async (ctx) => {
    if (ctx.parts[0] !== "batch") return null;
    const action = ctx.parts[1] || "";
    const user = await requireUser();

    /* ------------------------------ 创建批次 ------------------------------ */
    if (action === "create" && ctx.method === "POST") {
      const body = ctx.body || {};
      const images: { image?: string; thumb?: string }[] = Array.isArray(body.images) ? body.images : [];
      const mode: "fast" | "deep" = body.reasoningMode === "deep" ? "deep" : "fast";

      const cleaned = images
        .map((i) => ({
          image: String(i?.image || "").replace(/^data:[^;]+;base64,/, ""),
          thumb: String(i?.thumb || "").replace(/^data:[^;]+;base64,/, ""),
        }))
        .filter((i) => i.image.length > 100);

      if (!cleaned.length) return apiError(400, "请先选择图片");
      if (cleaned.length > MAX_BATCH) return apiError(400, `单个批次最多 ${MAX_BATCH} 张`);
      const oversized = cleaned.find((i) => i.image.length > 2_800_000);
      if (oversized) return apiError(400, "有图片体积过大，请压缩后重试");

      // 并发约束：同账号同时只允许一个批次在跑，其余排队，避免两批同时烧钱
      const running = await restJson<any[]>(
        `/BatchJob?select=id&userId=eq.${encodeURIComponent(user.id)}&status=in.(queued,processing)&limit=1`,
      ).catch(() => []);
      const jobId = cuid();
      const now = nowIso();
      const queued = !!running?.length;

      await restJson("/BatchJob", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id: jobId,
          userId: user.id,
          status: queued ? "queued" : "processing",
          reasoningMode: mode,
          totalCount: cleaned.length,
          doneCount: 0,
          failedCount: 0,
          savedCount: 0,
          startedAt: queued ? null : now,
          heartbeatAt: queued ? null : now,
          createdAt: now,
          updatedAt: now,
        }),
      });

      const rows = cleaned.map((img, idx) => ({
        id: cuid(),
        jobId,
        userId: user.id,
        idx,
        status: "pending",
        imageBase64: img.image,
        thumbBase64: img.thumb || null,
        attempts: 0,
        autoDeepRetry: false,
        answerConflict: false,
        createdAt: now,
        updatedAt: now,
      }));
      // 分批写入，避免单次请求体过大
      for (let i = 0; i < rows.length; i += 10) {
        await restJson("/BatchItem", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(rows.slice(i, i + 10)),
        });
      }

      if (!queued) kickWorker(jobId);
      return json({ id: jobId, queued, ...estimate(cleaned.length, mode) });
    }

    /* ------------------------- 活跃批次（横幅 / 角标） ------------------------- */
    if (action === "active" && ctx.method === "GET") {
      const rows = await restJson<any[]>(
        `/BatchJob?select=*&userId=eq.${encodeURIComponent(user.id)}&status=in.(${ACTIVE_STATUSES.join(",")})&order=createdAt.asc&limit=20`,
      ).catch(() => []);
      const jobs = rows || [];
      if (!jobs.length) return json({ jobs: [] });

      // 一次取回所有活跃批次的条目状态，避免 N+1 查询
      const ids = jobs.map((j) => j.id).join(",");
      const items = await restJson<any[]>(
        `/BatchItem?select=jobId,status&jobId=in.(${ids})`,
      ).catch(() => []);

      return json({
        jobs: jobs.map((job) => {
          const mine = items.filter((i) => i.jobId === job.id);
          return {
            ...job,
            counts: {
              done: mine.filter((i) => i.status === "done").length,
              failed: mine.filter((i) => i.status === "failed").length,
              saved: mine.filter((i) => i.status === "saved").length,
              total: mine.length,
            },
          };
        }),
      });
    }

    /* ------------------------------- 列表 -------------------------------- */
    if (action === "list" && ctx.method === "GET") {
      const rows = await restJson<any[]>(
        `/BatchJob?select=*&userId=eq.${encodeURIComponent(user.id)}&order=createdAt.desc&limit=50`,
      ).catch(() => []);
      return json(rows || []);
    }

    /* ------------------------------- 详情 -------------------------------- */
    if (action === "detail" && ctx.method === "GET") {
      const id = ctx.query.get("id") || "";
      const job = await loadJob(id, user.id);
      if (!job) return apiError(404, "批次不存在");
      // 明确列字段：不返回 imageBase64
      const items = await restJson<any[]>(
        `/BatchItem?select=id,jobId,idx,status,thumbBase64,questionText,answerText,analysis,subjectId,subjectName,gradeSemester,knowledgePoints,errorItemId,failureReason,attempts,autoDeepRetry,answerConflict,originalAnswerText,createdAt,updatedAt&jobId=eq.${encodeURIComponent(id)}&order=idx.asc`,
      ).catch(() => []);
      return json({ job, items: (items || []).map(publicItem) });
    }

    /* ------------------------------ 单条原图 ------------------------------ */
    // 详情接口刻意不返回 imageBase64（30 张会把响应拖到几十 MB）。
    // 打开某一条校对时才按需拉这一张，保证「题目原图」看到的是清晰原图而非 240px 缩略图。
    if (action === "item-image" && ctx.method === "GET") {
      const itemId = ctx.query.get("itemId") || "";
      if (!itemId) return apiError(400, "缺少 itemId");
      const rows = await restJson<any[]>(
        `/BatchItem?select=id,imageBase64,thumbBase64&id=eq.${encodeURIComponent(itemId)}&userId=eq.${encodeURIComponent(user.id)}&limit=1`,
      ).catch(() => []);
      if (!rows?.length) return apiError(404, "条目不存在");
      const row = rows[0];
      return json({
        imageBase64: row.imageBase64 || "",
        thumbBase64: row.thumbBase64 || "",
      });
    }

    /* ---------------------------- 编辑单条结果 ---------------------------- */
    if (action === "update" && ctx.method === "POST") {
      const { itemId, patch } = ctx.body || {};
      const rows = await restJson<any[]>(
        `/BatchItem?select=id,jobId&id=eq.${encodeURIComponent(itemId || "")}&userId=eq.${encodeURIComponent(user.id)}&limit=1`,
      ).catch(() => []);
      if (!rows?.length) return apiError(404, "条目不存在");
      const allowed = ["questionText", "answerText", "analysis", "subjectId", "subjectName", "gradeSemester", "errorItemId"];
      const next: Record<string, any> = { updatedAt: nowIso() };
      for (const k of allowed) if (patch && k in patch) next[k] = patch[k];
      if (patch && Array.isArray(patch.knowledgePoints)) {
        next.knowledgePoints = JSON.stringify(patch.knowledgePoints);
      }
      await restJson(`/BatchItem?id=eq.${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(next),
      });
      return json({ success: true });
    }

    /* ------------------------------ 批量入库 ------------------------------ */
    if (action === "save" && ctx.method === "POST") {
      const jobId = String(ctx.body?.jobId || "");
      const itemIds: string[] = Array.isArray(ctx.body?.itemIds) ? ctx.body.itemIds : [];
      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");
      if (!itemIds.length) return apiError(400, "没有选中任何条目");

      const rows = await restJson<any[]>(
        `/BatchItem?select=*&jobId=eq.${encodeURIComponent(jobId)}&id=in.(${itemIds.map((i) => `"${i}"`).join(",")})`,
      ).catch(() => []);
      // 库内已有题干池，用于确认页「疑似重复」的最终拦截
      const existing = await restJson<any[]>(
        `/ErrorItem?select=id,questionText&userId=eq.${encodeURIComponent(user.id)}&order=createdAt.desc&limit=2000`,
      ).catch(() => []);
      const existingTexts = new Set(
        (existing || []).map((e) => String(e.questionText || "").replace(/\s+/g, "").slice(0, 80)),
      );

      let saved = 0;
      let skipped = 0;
      const createdIds: string[] = [];

      for (const item of rows || []) {
        if (item.status === "saved") { skipped++; continue; }
        if (!item.questionText) { skipped++; continue; }
        const key = String(item.questionText).replace(/\s+/g, "").slice(0, 80);
        if (existingTexts.has(key)) { skipped++; continue; }

        const points = (() => {
          try { return JSON.parse(item.knowledgePoints || "[]"); } catch { return []; }
        })();
        const row = buildItem({
          originalImageUrl: item.imageBase64 ? `data:image/jpeg;base64,${item.imageBase64}` : (item.thumbBase64 || ""),
          questionText: item.questionText,
          answerText: item.answerText,
          analysis: item.analysis,
          subjectId: item.subjectId || null,
          knowledgePoints: points,
          gradeSemester: item.gradeSemester || null,
          source: "batch",
        }, user.id);

        const created = await restJson<any[]>("/ErrorItem", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(row),
        });
        const errorItemId = created?.[0]?.id || row.id;
        if (points.length) await linkTags(errorItemId, points);
        existingTexts.add(key);
        createdIds.push(errorItemId);
        saved++;
        await restJson(`/BatchItem?id=eq.${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "saved", errorItemId, updatedAt: nowIso() }),
        });
      }

      const all = await restJson<any[]>(
        `/BatchItem?select=status&jobId=eq.${encodeURIComponent(jobId)}`,
      ).catch(() => []);
      const counts = {
        total: all.length,
        done: all.filter((i) => i.status === "done").length,
        saved: all.filter((i) => i.status === "saved").length,
        failed: all.filter((i) => i.status === "failed").length,
        pending: all.filter((i) => i.status === "pending" || i.status === "processing").length,
      };
      const finished = counts.pending === 0 && counts.done === 0;
      await restJson(`/BatchJob?id=eq.${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          savedCount: counts.saved,
          doneCount: counts.done + counts.saved,
          failedCount: counts.failed,
          totalCount: counts.total,
          status: finished ? "done" : job.status,
          updatedAt: nowIso(),
        }),
      });

      // 本批收尾 → 拉起排队的下一批
      if (finished) await startNextQueued(user.id, jobId);

      return json({ success: true, saved, skipped, createdIds, counts });
    }

    /* ------------------------------- 重试 -------------------------------- */
    if (action === "retry" && ctx.method === "POST") {
      const jobId = String(ctx.body?.jobId || "");
      const itemId = ctx.body?.itemId ? String(ctx.body.itemId) : "";
      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");

      if (itemId) {
        const rows = await restJson<any[]>(
          `/BatchItem?select=id,status&id=eq.${encodeURIComponent(itemId)}&jobId=eq.${encodeURIComponent(jobId)}&limit=1`,
        ).catch(() => []);
        if (!rows?.length) return apiError(404, "条目不存在");
        await restJson(`/BatchItem?id=eq.${encodeURIComponent(itemId)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "pending", failureReason: null, updatedAt: nowIso() }),
        });
      }

      // 继续 / 重试都等价于把状态拨回进行中，再触发 worker
      await restJson(`/BatchJob?id=eq.${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "processing",
          errorMessage: null,
          finishedAt: null,
          heartbeatAt: nowIso(),
          updatedAt: nowIso(),
        }),
      });
      kickWorker(jobId);
      return json({ success: true, resumed: true });
    }

    /* ------------------------------- 取消 -------------------------------- */
    if (action === "cancel" && ctx.method === "POST") {
      const jobId = String(ctx.body?.jobId || "");
      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");
      await restJson(`/BatchJob?id=eq.${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "canceled", finishedAt: nowIso(), updatedAt: nowIso() }),
      });
      await startNextQueued(user.id, jobId);
      return json({ success: true });
    }

    /* ------------------------------- 忽略 -------------------------------- */
    if (action === "dismiss" && ctx.method === "POST") {
      const jobId = String(ctx.body?.jobId || "");
      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");
      // 待确认批次允许直接丢弃：条目与原图一并删除，避免长期占库
      await restJson(`/BatchJob?id=eq.${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
      await startNextQueued(user.id, jobId);
      return json({ success: true });
    }

    return apiError(404, "Unknown batch endpoint");
  },
];

/** 当前批次收尾后，把同账号排队最久的一批拉起来 */
async function startNextQueued(userId: string, currentJobId: string): Promise<void> {
  const rows = await restJson<any[]>(
    `/BatchJob?select=id&userId=eq.${encodeURIComponent(userId)}&status=eq.queued&order=createdAt.asc&limit=1`,
  ).catch(() => []);
  const next = rows?.[0];
  if (!next || next.id === currentJobId) return;
  await restJson(`/BatchJob?id=eq.${encodeURIComponent(next.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "processing", startedAt: nowIso(), heartbeatAt: nowIso(), updatedAt: nowIso() }),
  }).catch(() => {});
  kickWorker(next.id);
}
