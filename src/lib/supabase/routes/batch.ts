/**
 * 批量导入：批次创建、查询、确认入库、重试/继续、取消。
 *
 * 执行本身不在浏览器里：创建批次后触发 Edge Function batch-worker，
 * 由它自链式跑完。这里只负责「投递任务」和「读状态 / 写结果」。
 */
import { accessToken, cuid, nowIso, requireUser, restJson } from "../core";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../config";
import { apiError, json, type RouteHandler } from "../http";
import { buildItem } from "./error-items";
import { recentGradeFromRows, resolveGradeForNewItem } from "./grade";
import { hasImageRef, refToSrc } from "../../storage/ref";

const WORKER_URL = `${SUPABASE_URL}/functions/v1/batch-worker`;
/** 单批上限：与产品约定一致（约 3MB 图片，深度模式约 30 分钟跑完） */
const MAX_BATCH = 30;
/** 活跃态：用于首页横幅与并发约束 */
const ACTIVE_STATUSES = ["draft", "queued", "processing", "confirming", "paused"];

/** 草稿存活期：超过这个天数没人动就清掉，否则 30 张原图会一直占库 */
export const DRAFT_TTL_DAYS = 7;
const DRAFT_TTL_MS = DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * 惰性清理过期草稿。
 *
 * 为什么不走定时任务：这个项目是静态站 + Supabase，没有常驻进程，
 * 为一个「7 天没人碰」的场景专门起 cron 不划算。读活跃批次列表时顺手扫一遍，
 * 只要有用户打开页面就会清，效果等价，代码只有十几行。
 *
 * BatchItem.jobId 是 on delete cascade，删 job 会连带删条目，不会留孤儿图。
 */
async function expireDrafts(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - DRAFT_TTL_MS).toISOString();
  const stale = await restJson<any[]>(
    `/BatchJob?select=id&userId=eq.${encodeURIComponent(userId)}&status=eq.draft&updatedAt=lt.${encodeURIComponent(cutoff)}`,
  ).catch(() => []);
  if (!stale?.length) return 0;
  for (const row of stale) {
    await restJson(`/BatchJob?id=eq.${encodeURIComponent(row.id)}`, { method: "DELETE" }).catch(() => {});
  }
  return stale.length;
}

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
  return { ...rest, knowledgePoints: points, hasImage: hasImageRef(imageBase64) };
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

    /* ------------------- 草稿：选完图先落一个任务，防丢 ------------------- */
    /**
     * 为什么要有 draft：
     * 旧流程是「点开始」才建 job，选图和改图全在浏览器内存里，崩一次全没。
     * 现在选完图立刻建草稿，图片逐张写库，浏览器崩了也能从批量 tab 接着改。
     * status 是 text 字段，'draft' 不需要改表结构。
     */
    if (action === "draft" && ctx.method === "POST") {
      const body = ctx.body || {};
      const total = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(body.totalCount) || 0)));
      const mode: "fast" | "deep" = body.reasoningMode === "deep" ? "deep" : "fast";

      // 先清过期草稿，否则「有一批 7 天前的半成品」会把用户永远挡在门外
      await expireDrafts(user.id);

      /**
       * 同账号只留一个活跃草稿。
       *
       * 放开的后果是批量 tab 里堆一排半成品，用户自己都分不清哪批是哪批；
       * 而草稿只可能是「刚选完图还没开始解析」，正常不会有第二个的正当理由。
       * 想开新的就先处理或丢弃旧的——前端拿到 409 时会给出这两个出口。
       */
      const running = await restJson<any[]>(
        `/BatchJob?select=id,totalCount,updatedAt&userId=eq.${encodeURIComponent(user.id)}&status=eq.draft&limit=1`,
      ).catch(() => []);
      const existing = running?.[0];
      if (existing) {
        return apiError(409, "还有一批没处理完", {
          existingId: existing.id,
          existingCount: Number(existing.totalCount) || 0,
          existingAt: existing.updatedAt || null,
        });
      }

      const jobId = cuid();
      const now = nowIso();
      await restJson("/BatchJob", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id: jobId,
          userId: user.id,
          status: "draft",
          reasoningMode: mode,
          totalCount: total,
          doneCount: 0,
          failedCount: 0,
          savedCount: 0,
          startedAt: null,
          heartbeatAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      });
      return json({ id: jobId, total });
    }

    /* ---------------- 草稿：逐张写入 / 覆盖（同一 idx 幂等） ---------------- */
    if (action === "image" && ctx.method === "POST") {
      const body = ctx.body || {};
      const jobId = String(body.jobId || "");
      const idx = Math.max(0, Math.min(MAX_BATCH - 1, Math.floor(Number(body.idx) || 0)));
      const image = String(body.image || "").replace(/^data:[^;]+;base64,/, "");
      const thumb = String(body.thumb || "").replace(/^data:[^;]+;base64,/, "");
      if (!jobId) return apiError(400, "缺少批次");
      if (image.length < 100) return apiError(400, "图片为空");
      if (image.length > 2_800_000) return apiError(413, "单张图片过大，请压缩后重试");

      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");
      if (job.status !== "draft") return apiError(409, "这批已经开始解析，不能再改图");

      // 主键 = `${jobId}-${idx}`：同一张重复上传就是覆盖，断点重传不会长出重复行
      const status = body.edited ? "edited" : "pending";
      const now = nowIso();
      await restJson("/BatchItem?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{
          id: `${jobId}-${idx}`,
          jobId,
          userId: user.id,
          idx,
          status,
          imageBase64: image,
          thumbBase64: thumb || null,
          attempts: 0,
          autoDeepRetry: false,
          answerConflict: false,
          createdAt: now,
          updatedAt: now,
        }]),
      });
      await restJson(`/BatchJob?id=eq.${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ updatedAt: now }),
      }).catch(() => {});
      return json({ ok: true, idx, status });
    }

    /* ------------------------------ 草稿详情 ------------------------------ */
    if (action === "draft-detail" && ctx.method === "GET") {
      const id = ctx.query.get("id") || "";
      const job = await loadJob(id, user.id);
      if (!job) return apiError(404, "批次不存在");
      if (job.status !== "draft") return apiError(409, "这批已经开始解析，不能再改图");
      const expiresAt = draftExpiresAt(job);
      // 只回缩略图，30 张原图会把响应拉到几十 MB
      const items = await restJson<any[]>(
        `/BatchItem?select=id,idx,status,thumbBase64&jobId=eq.${encodeURIComponent(id)}&order=idx.asc`,
      ).catch(() => []);
      return json({ job: { ...job, expiresAt }, items: items || [] });
    }

    /* ---------------------------- 草稿开始解析 ---------------------------- */
    if (action === "start" && ctx.method === "POST") {
      const jobId = String(ctx.body?.jobId || "");
      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");
      if (job.status !== "draft") return apiError(409, "这批已经启动过了");

      const items = await restJson<any[]>(
        `/BatchItem?select=id,status,imageBase64&jobId=eq.${encodeURIComponent(jobId)}`,
      ).catch(() => []);
      const ready = (items || []).filter((i) => hasImageRef(i.imageBase64));
      if (!ready.length) return apiError(400, "还没有可解析的图片");

      const ids = ready.map((i) => `"${String(i.id).replace(/["\\]/g, "")}"`).join(",");
      // edited（人工改过）和 pending 统一回 pending：worker 只认 pending
      await restJson(`/BatchItem?id=in.(${ids})`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "pending", updatedAt: nowIso() }),
      });

      const running = await restJson<any[]>(
        `/BatchJob?select=id&userId=eq.${encodeURIComponent(user.id)}&status=in.(queued,processing)&limit=1`,
      ).catch(() => []);
      const queued = !!running?.length;
      const now = nowIso();
      await restJson(`/BatchJob?id=eq.${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: queued ? "queued" : "processing",
          totalCount: ready.length,
          startedAt: queued ? null : now,
          heartbeatAt: queued ? null : now,
          updatedAt: now,
        }),
      });
      if (!queued) kickWorker(jobId);
      const mode: "fast" | "deep" = job.reasoningMode === "deep" ? "deep" : "fast";
      return json({ id: jobId, queued, count: ready.length, ...estimate(ready.length, mode) });
    }

    /* ------------------------- 活跃批次（横幅 / 角标） ------------------------- */
    if (action === "active" && ctx.method === "GET") {
      // 用户每次打开首页都会走到这里，顺手把过期草稿清掉（有图的话能省几十 MB）
      await expireDrafts(user.id);
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
            expiresAt: job.status === "draft" ? draftExpiresAt(job) : null,
            counts: {
              // 草稿阶段没有 done，「已检查」用 edited 表示，卡片进度才有意义
              edited: mine.filter((i) => i.status === "edited").length,
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
      await expireDrafts(user.id);
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
        `/BatchItem?select=id,jobId,idx,status,thumbBase64,questionText,answerText,analysis,subjectId,subjectName,gradeSemester,knowledgePoints,errorItemId,failureReason,attempts,autoDeepRetry,answerConflict,originalAnswerText,userGuidance,createdAt,updatedAt&jobId=eq.${encodeURIComponent(id)}&order=idx.asc`,
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
      const allowed = ["questionText", "answerText", "analysis", "subjectId", "subjectName", "gradeSemester", "errorItemId", "userGuidance"];
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
      /** 前端分片提交时，只有最后一片做批次统计与收尾，避免重复查询 */
      const final = ctx.body?.final !== false;
      const job = await loadJob(jobId, user.id);
      if (!job) return apiError(404, "批次不存在");
      if (!itemIds.length) return apiError(400, "没有选中任何条目");

      const quoted = itemIds.map((i) => `"${String(i).replace(/["\\]/g, "")}"`).join(",");
      /**
       * 第一轮只取「判定用」字段：状态、题干、标签、答案等。
       * 原图 base64 动辄数百 KB，10 条就 3MB；已入库 / 题干重复的条目
       * 根本不需要再传一次图，所以先判定、后补图，能省掉全部被跳过条目的图片流量。
       */
      const rows = await restJson<any[]>(
        `/BatchItem?select=id,idx,status,questionText,answerText,analysis,subjectId,subjectName,`
        + `gradeSemester,knowledgePoints,userGuidance,thumbBase64`
        + `&jobId=eq.${encodeURIComponent(jobId)}&id=in.(${quoted})`,
      ).catch(() => []);
      // 题干池：既用于同题干去重，也顺带取「最近一次保存的年级」。
      // v1.13.0 定下的规则（沿用最近一次手选年级）原本只做在前端编辑器里，
      // 批量「一键全部入库」不经过编辑器 → 整批年级落空。这里在写库前兜底，
      // 复用同一次查询，不增加任何往返。
      const existing = await restJson<any[]>(
        `/ErrorItem?select=questionText,gradeSemester&userId=eq.${encodeURIComponent(user.id)}&order=createdAt.desc&limit=2000`,
      ).catch(() => []);
      const existingTexts = new Set(
        (existing || []).map((e) => String(e.questionText || "").replace(/\s+/g, "").slice(0, 80)),
      );
      /** 整批共用同一个沿用值，保证同一批题目年级一致 */
      const inheritedGrade = recentGradeFromRows(existing);
      // 标签名 → id 映射整片只查一次（旧版每个知识点都重查一遍全表）
      const allTags = await restJson<any[]>("/KnowledgeTag?select=id,name").catch(() => []);

      let saved = 0;
      let skipped = 0;
      const createdIds: string[] = [];
      const failed: { idx: number; message: string }[] = [];

      type Candidate = {
        item: Record<string, any>;
        errorItemId: string;
        row: Record<string, any>;
        points: any[];
        /** 最终写入的年级，入库成功后同步回 BatchItem，保证批次页与详情页一致 */
        finalGrade: string | null;
      };
      const candidates: Candidate[] = [];
      const imageMissing: string[] = [];
      for (const item of rows || []) {
        if (item.status === "saved") { skipped++; continue; }
        if (!item.questionText) { skipped++; continue; }
        const key = String(item.questionText).replace(/\s+/g, "").slice(0, 80);
        if (existingTexts.has(key)) { skipped++; continue; }
        existingTexts.add(key); // 同批内题干重复也只入一条
        const points = (() => {
          try { return JSON.parse(item.knowledgePoints || "[]"); } catch { return []; }
        })();
        const fullImage = item.thumbBase64 ? refToSrc(String(item.thumbBase64)) : "";
        // 条目自带有效年级（校对页手选）优先，否则整批沿用最近一次年级。
        const finalGrade = resolveGradeForNewItem(item.gradeSemester, inheritedGrade);
        const row = buildItem({
          originalImageUrl: fullImage,
          questionText: item.questionText,
          answerText: item.answerText,
          analysis: item.analysis,
          subjectId: item.subjectId || null,
          knowledgePoints: points,
          gradeSemester: finalGrade,
          source: "batch",
        }, user.id);
        candidates.push({ item, errorItemId: row.id, row, points, finalGrade });
      }

      /**
       * 第二轮只为真正要入库的条目补原图：被跳过（已 saved / 题干重复）的条目
       * 一张图都不用传。续跑场景（上次存了一半）能省掉大半流量。
       */
      if (candidates.length) {
        const candIds = candidates
          .map((c) => `"${String(c.item.id).replace(/["\\]/g, "")}"`)
          .join(",");
        const imgById = new Map<string, string>();
        const readImages = async () => {
          const imgs = await restJson<any[]>(
            `/BatchItem?select=id,imageBase64&id=in.(${candIds})&userId=eq.${encodeURIComponent(user.id)}`,
          );
          for (const x of imgs || []) {
            imgById.set(String(x.id), String(x.imageBase64 || ""));
          }
        };
        try {
          await readImages();
        } catch {
          /* 整批读失败（跨境链路上 600KB 响应超时很常见），下面逐条补 */
        }

        /**
         * 缺图的条目逐条补一次。
         *
         * v1.18.36 修复：此前整批 catch 后直接保留 thumbBase64 当原图，
         * 结果详情页永远是一张 240px 缩略图，用户重传多少次都一样 ——
         * 因为缩略图是在入库时写死的，跟后来传什么无关。
         */
        const missingNow = candidates.filter((c) => !hasImageRef(imgById.get(String(c.item.id))));
        if (missingNow.length) {
          await Promise.all(missingNow.map(async (c) => {
            try {
              const one = await restJson<any[]>(
                `/BatchItem?select=imageBase64&id=eq.${encodeURIComponent(String(c.item.id))}&userId=eq.${encodeURIComponent(user.id)}&limit=1`,
              );
              const b64 = String(one?.[0]?.imageBase64 || "");
              if (b64) imgById.set(String(c.item.id), b64);
            } catch { /* 留空，绝不降级成缩略图 */ }
          }));
        }

        for (const c of candidates) {
          const b64 = imgById.get(String(c.item.id)) || "";
          // 取不到原图就留空：让详情页明确"无图"，而不是塞一张永远糊的缩略图冒充原图。
          // 批次里存的是图片引用（现在是 data URL，将来是对象 key），统一过一遍
          c.row.originalImageUrl = hasImageRef(b64) ? refToSrc(b64) : "";
          if (!b64) imageMissing.push(String(c.item.id));
        }
      }

      const insertOne = (row: Record<string, any>) =>
        restJson("/ErrorItem", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(row),
        });

      // 一次批量插多行。只有批量失败（单行超长 / 网关 5xx）才回退逐条。
      // 逐条时若「带原图」仍写不进，才降级用缩略图保底 —— 但会记进 imageMissing，
      // 让调用方知道这条的原图是缺的，而不是以为存了一张高清图。
      const ok = new Set<string>();
      if (candidates.length) {
        try {
          await restJson("/ErrorItem", {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify(candidates.map((c) => c.row)),
          });
          for (const c of candidates) ok.add(c.errorItemId);
        } catch {
          for (const c of candidates) {
            const thumbUrl = c.item.thumbBase64 ? refToSrc(String(c.item.thumbBase64)) : "";
            try {
              await insertOne(c.row);
              ok.add(c.errorItemId);
            } catch (first) {
              // 原图本身为空时不做缩略图降级：降级只会把"无图"变成"糊图"，
              // 用户看到的是一张不可用的图，还以为已经存好了。
              if (!c.row.originalImageUrl) {
                const msg = first instanceof Error ? first.message : String(first);
                failed.push({ idx: c.item.idx, message: msg.slice(0, 120) });
                continue;
              }
              try {
                await insertOne({ ...c.row, originalImageUrl: thumbUrl });
                ok.add(c.errorItemId);
                if (!imageMissing.includes(String(c.item.id))) {
                  imageMissing.push(String(c.item.id));
                }
              } catch {
                const msg = first instanceof Error ? first.message : String(first);
                failed.push({ idx: c.item.idx, message: msg.slice(0, 120) });
              }
            }
          }
        }
      }

      // 批量建标签关联：整片一次请求，去重避免撞 (A,B) 唯一约束
      const tagByName = new Map<string, string>(
        (allTags || []).map((t) => [String(t.name), String(t.id)]),
      );
      const links: { A: string; B: string }[] = [];
      const linkSeen = new Set<string>();
      for (const c of candidates) {
        if (!ok.has(c.errorItemId)) continue;
        for (const kp of c.points) {
          const name = typeof kp === "string" ? kp : kp?.name;
          const tagId = name ? tagByName.get(String(name)) : undefined;
          if (!tagId) continue;
          const dedupeKey = `${c.errorItemId}|${tagId}`;
          if (linkSeen.has(dedupeKey)) continue;
          linkSeen.add(dedupeKey);
          links.push({ A: c.errorItemId, B: tagId });
        }
      }
      if (links.length) {
        // 必须带 on_conflict：该表的唯一约束是 (A,B) 复合唯一索引而非主键，
        // 只给 resolution=ignore-duplicates 时 PostgREST 不会生成 ON CONFLICT，
        // 重入库同一条会整个批量请求 409。实测带 on_conflict 后重复插入稳定 201。
        const LINK_PATH = "/_ErrorItemToKnowledgeTag?on_conflict=A,B";
        const linkInit = (body: unknown) => ({
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify(body),
        });
        try {
          await restJson(LINK_PATH, linkInit(links));
        } catch {
          // 关联失败不影响题目入库，逐条补一次即可
          await Promise.allSettled(links.map((l) =>
            restJson(LINK_PATH, linkInit(l)).catch(() => {}),
          ));
        }
      }

      // 回写条目状态用并发 PATCH，不用 upsert：BatchItem 有 imageBase64 /
      // jobId / userId 等 NOT NULL 且无默认值的列，upsert 补全会把原图再传一遍。
      // 并发 25 条约等于 1 个 RTT 组，比旧版 25 次串行 await 快一个数量级。
      const succeeded = candidates.filter((c) => ok.has(c.errorItemId));
      await Promise.allSettled(succeeded.map((c) =>
        restJson(`/BatchItem?id=eq.${encodeURIComponent(c.item.id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            status: "saved",
            errorItemId: c.errorItemId,
            failureReason: null,
            // 把沿用后的年级写回留档：批量跟踪页的年级标签与详情页才不会一边有、一边空
            gradeSemester: c.finalGrade,
            // 入库后原图已经在 ErrorItem 里了，批次这张是同一份副本。
            // 不清就会一直双份占数据库（30 张约 36MB），而免费额度只有 500MB。
            imageBase64: "",
            updatedAt: nowIso(),
          }),
        }),
      ));
      for (const c of succeeded) { createdIds.push(c.errorItemId); saved++; }

      await Promise.allSettled(
        candidates.filter((c) => !ok.has(c.errorItemId)).map((c) =>
          restJson(`/BatchItem?id=eq.${encodeURIComponent(c.item.id)}`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              failureReason: `入库失败：${(failed.find((f) => f.idx === c.item.idx)?.message || "未知原因").slice(0, 80)}`,
              updatedAt: nowIso(),
            }),
          }),
        ),
      );

      let counts: Record<string, number> | null = null;
      if (final) {
        const all = await restJson<any[]>(
          `/BatchItem?select=status&jobId=eq.${encodeURIComponent(jobId)}`,
        ).catch(() => []);
        counts = {
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
        if (finished) await startNextQueued(user.id, jobId);
      }

      return json({ success: true, saved, skipped, failed, createdIds, counts, imageMissing });
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
        // 单张重试是用户明确「这一张重来」，attempts 必须归零：
        // worker 在抢占阶段会判 attempts>=3 直接标 failed，
        // 不清零的话用户无论点多少次重试都会被立刻打回失败。
        await restJson(`/BatchItem?id=eq.${encodeURIComponent(itemId)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ status: "pending", failureReason: null, attempts: 0, updatedAt: nowIso() }),
        });
      } else {
        // 整批继续：先回收「僵死条目」。
        // worker 抢占某一条后若被平台杀掉（单次调用超时），该条会永远停在 processing，
        // 而 worker 只挑 pending，于是整批看起来卡住不动。这里把超时未更新的拨回 pending。
        const cutoff = new Date(Date.now() - 3 * 60_000).toISOString();
        await restJson(
          `/BatchItem?jobId=eq.${encodeURIComponent(jobId)}&status=eq.processing&updatedAt=lt.${encodeURIComponent(cutoff)}&attempts=lt.3`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ status: "pending", failureReason: null, updatedAt: nowIso() }),
          },
        ).catch(() => {});
        await restJson(
          `/BatchItem?jobId=eq.${encodeURIComponent(jobId)}&status=eq.processing&updatedAt=lt.${encodeURIComponent(cutoff)}&attempts=gte.3`,
          {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ status: "failed", failureReason: "处理中断（多次超时），可单独重试", updatedAt: nowIso() }),
          },
        ).catch(() => {});
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

/** 草稿到期时间：最后一次改动 + TTL，前端据此显示「还有 N 天」 */
function draftExpiresAt(job: any): string | null {
  if (job?.status !== "draft") return null;
  const base = Date.parse(job.updatedAt || job.createdAt || "");
  if (!Number.isFinite(base)) return null;
  return new Date(base + DRAFT_TTL_MS).toISOString();
}

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
