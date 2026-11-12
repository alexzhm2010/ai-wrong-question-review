/** 错题 CRUD、筛选分页、批量删除、掌握状态、笔记、GeoGebra */
import { aiEdge, byId, cuid, nowIso, requireUser, restJson, restJsonPage } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";
import { attachRelations, getTagIndex, getTagsByIds } from "./shared";

/**
 * 列表页字段：刻意不含 originalImageUrl。
 * 该字段是 base64 原图（单张最大 500KB，全库 7MB+），而列表卡片根本不显示图片；
 * 旧实现 `select=*` 把整库原图拉回浏览器再筛选分页，是列表加载慢的主因。
 * 打印预览传 includeImage=true 时才把原图加回来。
 */
const LIST_FIELDS = [
  "id", "userId", "subjectId", "questionText", "ocrText", "mistakeStatus",
  "knowledgePoints", "source", "errorType", "userNotes", "masteryLevel",
  "gradeSemester", "paperLevel", "createdAt", "updatedAt",
  // 题号与对错计数：选题区、打印页、批改页都要用
  "shortCode", "wrongCount", "correctCount", "correctStreak", "lastResult", "lastAttemptAt",
];
/** 打印预览同接口复用：需要答案/解析正文，再加原图 */
const PRINT_FIELDS = [...LIST_FIELDS, "answerText", "analysis", "wrongAnswerText", "mistakeAnalysis"];
const MAX_PAGE_SIZE = 1000;

/** 去掉会破坏 PostgREST 逻辑树 / ilike 语法的字符，保留搜索词本身 */
function likeTerm(raw: string): string {
  return raw.replace(/[\\*,()%"']/g, " ").replace(/\s+/g, " ").trim();
}

/** 兼容前端两套参数名（列表页用 query/mastery，旧版用 search/masteryLevel） */
function qget(q: URLSearchParams, ...names: string[]): string {
  for (const n of names) {
    const v = q.get(n);
    if (v !== null && v !== "") return v;
  }
  return "";
}

/**
 * 批量装配列表的 tags / subject。
 * 旧实现每条错题单独查一次关联表（每页 18 次串行往返），这里改成
 * 「一次 in.(...) 批量查关联 + 按标签 id 精确取 + 内存映射」，
 * 无论一页多少条都只有固定 2~3 次请求，且不再为几个标签名拉 1809 行索引。
 */
async function attachMany(items: Record<string, any>[]): Promise<Record<string, any>[]> {
  if (!items.length) return [];
  const ids = items.map((i) => `"${String(i.id).replace(/"/g, "")}"`).join(",");
  const [links, subjects] = await Promise.all([
    restJson<any[]>(`/_ErrorItemToKnowledgeTag?select=A,B&A=in.(${ids})`).catch(() => []),
    restJson<any[]>("/Subject?select=id,name").catch(() => []),
  ]);
  const tags = await getTagsByIds((links || []).map((l) => String(l.B)));
  const tagById = new Map<string, any>(tags.map((t) => [t.id, t]));
  const linksByItem = new Map<string, any[]>();
  for (const l of links || []) {
    const tag = tagById.get(l.B);
    if (!tag) continue;
    if (!linksByItem.has(l.A)) linksByItem.set(l.A, []);
    linksByItem.get(l.A)!.push(tag);
  }
  const subjectById = new Map<string, any>((subjects || []).map((s) => [s.id, s]));
  return items.map((item) => ({
    ...item,
    tags: linksByItem.get(item.id) || [],
    subject: item.subjectId
      ? (subjectById.get(item.subjectId) || { id: item.subjectId })
      : null,
  }));
}

const ITEM_FIELDS = [
  "ocrText", "questionText", "answerText", "analysis", "wrongAnswerText",
  "mistakeAnalysis", "mistakeStatus", "geogebraCommands", "source", "errorType",
  "userNotes", "gradeSemester", "paperLevel", "subjectId",
];

export function buildItem(body: any, userId: string): Record<string, any> {
  const row: Record<string, any> = {
    id: cuid(),
    userId,
    originalImageUrl: body.originalImageUrl || "",
    masteryLevel: body.masteryLevel ?? 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  for (const key of ITEM_FIELDS) row[key] = body[key] ?? null;
  if (Array.isArray(body.knowledgePoints)) row.knowledgePoints = JSON.stringify(body.knowledgePoints);
  else row.knowledgePoints = body.knowledgePoints ?? null;
  return row;
}

export async function linkTags(itemId: string, knowledgePoints: any[]): Promise<void> {
  if (!knowledgePoints?.length) return;
  const allTags = await restJson<any[]>("/KnowledgeTag?select=id,name").catch(() => []);
  for (const kp of knowledgePoints) {
    const name = typeof kp === "string" ? kp : kp?.name;
    const tag = allTags.find((t) => t.name === name);
    if (!tag) continue;
    await restJson("/_ErrorItemToKnowledgeTag", {
      method: "POST",
      body: JSON.stringify({ A: itemId, B: tag.id }),
    }).catch(() => {});
  }
}

/**
 * 记录一次作答并回写计数。
 *
 * 规则刻意保持可解释：连续答对是掌握信号，错一次立刻归零。
 * masteryLevel 由 streak 派生（0/1/2），这样旧的「按掌握度筛选」不用改。
 * 空白未作答（skip）只留痕，不计对也不计错——否则跳过的题会被误算成做错。
 */
async function recordAttempt(id: string, result: string): Promise<Record<string, any> | null> {
  const rows = await restJson<any[]>(
    `/ErrorItem?select=id,wrongCount,correctCount,correctStreak,masteryLevel` +
      `&id=eq.${encodeURIComponent(id)}`,
  ).catch(() => []);
  const cur = rows?.[0];
  if (!cur) return null;

  const stamp = nowIso();
  const patch: Record<string, any> = { lastResult: result, lastAttemptAt: stamp, updatedAt: stamp };
  if (result === "skip") return { id, ...patch };

  if (result === "correct") {
    patch.correctCount = Number(cur.correctCount || 0) + 1;
    patch.correctStreak = Number(cur.correctStreak || 0) + 1;
  } else {
    patch.wrongCount = Number(cur.wrongCount || 0) + 1;
    patch.correctStreak = 0;
    patch.mistakeStatus = "wrong_attempt";
  }
  const streak = Number(patch.correctStreak || 0);
  // 已归档（masteryLevel=3）的题，答对就保持归档；答错自动回到待攻克
  const wasArchived = Number(cur.masteryLevel || 0) >= 3;
  patch.masteryLevel =
    wasArchived && result === "correct" ? 3 : streak >= 3 ? 2 : streak >= 2 ? 1 : 0;

  const saved = await restJson<any[]>(byId("ErrorItem", id), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  }).catch(() => null);
  return saved?.[0] || { id, ...patch };
}

/** 固定子路径优先于 /:id，避免把 list、clear 当成 ID */
async function handleFixed(ctx: RouteContext, sub: string): Promise<Response | null> {
  if (sub === "list" && ctx.method === "GET") {
    const q = ctx.query;
    const page = Math.max(1, Number(q.get("page")) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.get("pageSize")) || 10));
    const includeImage = qget(q, "includeImage") === "true";
    // 打印预览要答案/解析/原图；列表卡片一样都不用，只取渲染所需的最小字段集
    const fields = includeImage ? [...PRINT_FIELDS, "originalImageUrl"] : LIST_FIELDS;

    const params = new URLSearchParams();
    params.set("select", fields.join(","));
    params.set("order", "createdAt.desc");
    params.set("limit", String(pageSize));
    params.set("offset", String((page - 1) * pageSize));

    // 只把「简单相等/范围」条件放顶层，PostgREST 天然按 AND 组合
    // ids 用于「今日卷 / 指定必刷」：只取点名的这几道，不再拉全库回来过滤
    const ids = (q.get("ids") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (ids.length) {
      params.set("id", `in.(${ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",")})`);
    }
    const subjectId = qget(q, "subjectId");
    const grade = qget(q, "gradeSemester");
    const mastery = qget(q, "mastery", "masteryLevel");
    const timeRange = qget(q, "timeRange");
    if (subjectId) params.append("subjectId", `eq.${subjectId}`);
    if (grade) params.append("gradeSemester", `eq.${grade}`);
    if (mastery === "1") params.append("masteryLevel", "gt.0");
    else if (mastery === "0") params.append("masteryLevel", "eq.0");
    else if (mastery) params.append("masteryLevel", `eq.${mastery}`);
    if (timeRange === "week" || timeRange === "month") {
      const days = timeRange === "week" ? 7 : 30;
      params.append("createdAt", `gte.${new Date(Date.now() - days * 86_400_000).toISOString()}`);
    }

    // 搜索 / 标签是 OR 组：一个直接放顶层 or，两个用 and 内嵌（已实测 PostgREST 支持）
    const orGroups: string[] = [];
    const simple: [string, string][] = [];
    const search = likeTerm(qget(q, "query", "search"));
    if (search) {
      orGroups.push(
        `(questionText.ilike.*${search}*,ocrText.ilike.*${search}*,userNotes.ilike.*${search}*)`,
      );
    }

    const tag = likeTerm(qget(q, "tag"));
    const chapter = likeTerm(qget(q, "chapter"));
    let tagNames: string[] = tag ? [tag] : [];
    if (chapter) {
      // 章节 → 该节点下所有叶子知识点名；knowledgePoints 是存标签名的 JSON 文本，
      // 用它做 ilike 比关联表更全（库里 80 道题都有 knowledgePoints，但只有 39 条关联记录）。
      const rows = await getTagIndex();
      const children = new Map<string, any[]>();
      for (const r of rows) {
        const k = r.parentId || "";
        if (!children.has(k)) children.set(k, []);
        children.get(k)!.push(r);
      }
      const leaves: string[] = [];
      const walk = (node: any) => {
        const kids = children.get(node.id) || [];
        if (!kids.length) { leaves.push(node.name); return; }
        for (const k of kids) walk(k);
      };
      for (const root of rows.filter((r) => r.name === chapter)) walk(root);
      tagNames = [...new Set([...tagNames, ...leaves])].slice(0, 40);
      if (!tagNames.length) tagNames = [chapter];
    }
    if (tagNames.length === 1) {
      simple.push(["knowledgePoints", `ilike.*${tagNames[0]}*`]);
    } else if (tagNames.length > 1) {
      orGroups.push(`(${tagNames.map((n) => `knowledgePoints.ilike.*${n}*`).join(",")})`);
    }

    if (orGroups.length === 1) params.append("or", orGroups[0]);
    else if (orGroups.length > 1) {
      params.append("and", `(${orGroups.map((g) => `or${g}`).join(",")})`);
    }
    for (const [k, v] of simple) params.append(k, v);

    const { data, total } = await restJsonPage<any[]>(
      `/ErrorItem?${params.toString()}`,
      { signal: ctx.signal },
    );
    const rows = Array.isArray(data) ? data : [];
    return json({
      items: await attachMany(rows),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  }
  if (sub === "batch-delete" && ctx.method === "POST") {
    const ids: string[] = (ctx.body?.ids || []).filter(Boolean);
    await deleteMany(ids);
    return json({ success: true, deleted: ids.length });
  }
  /**
   * 归档 / 取消归档：masteryLevel=3 表示「已掌握，不再进日常复习」。
   * 单开一个接口而不是逐条 PATCH，是为了 80 道题也只发一次请求。
   */
  if (sub === "archive" && ctx.method === "POST") {
    const ids: string[] = (ctx.body?.ids || []).map(String).filter(Boolean).slice(0, 300);
    if (!ids.length) return json({ success: true, updated: 0 });
    const level = ctx.body?.archived === false ? 0 : 3;
    const stamp = nowIso();
    const inList = ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const ok = await restJson(`/ErrorItem?id=in.(${inList})`, {
      method: "PATCH",
      body: JSON.stringify({ masteryLevel: level, updatedAt: stamp }),
    })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      // RLS 挡住批量 PATCH 时退回逐条，功能不能因为权限配置挂掉
      await Promise.all(
        ids.map((id) =>
          restJson(byId("ErrorItem", id), {
            method: "PATCH",
            body: JSON.stringify({ masteryLevel: level, updatedAt: stamp }),
          }).catch(() => {}),
        ),
      );
    }
    return json({ success: true, updated: ids.length, masteryLevel: level });
  }
  /**
   * 批改页一次交一整页：逐条 PATCH，并发 6 条。
   * 不用 RPC 是为了保持这条链路与列表接口同一套权限（RLS 下管理员必须显式带 userId）。
   */
  if (sub === "attempt-batch" && ctx.method === "POST") {
    const raw: any[] = Array.isArray(ctx.body?.items) ? ctx.body.items : [];
    const valid = raw
      .map((x) => ({ id: String(x?.id || ""), result: String(x?.result || "") }))
      .filter((x) => x.id && ["correct", "wrong", "skip"].includes(x.result))
      .slice(0, 200);
    if (!valid.length) return json({ success: true, updated: 0, items: [] });

    const out: Record<string, any>[] = [];
    const CONCURRENCY = 6;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, valid.length) }, async () => {
        while (cursor < valid.length) {
          const job = valid[cursor++];
          const row = await recordAttempt(job.id, job.result).catch(() => null);
          if (row) out.push(row);
        }
      }),
    );
    return json({ success: true, updated: out.length, items: out });
  }
  if (sub === "clear" && ctx.method === "DELETE") {
    await requireUser();
    const rows = await restJson<any[]>("/ErrorItem?select=id").catch(() => []);
    await deleteMany((rows || []).map((r) => String(r.id)));
    return json({ message: "Error data cleared successfully", count: rows.length });
  }
  /**
   * 打印预览/详情页按需取原图。原图是 base64，全库 7MB+，绝不能混在列表里。
   * 前端按片传 ids，每片一次查询，页面先出文字骨架，图片渐进补齐。
   */
  if (sub === "images" && ctx.method === "GET") {
    const ids = (ctx.query.get("ids") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 60);
    if (!ids.length) return json({ images: [] });
    const inList = ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await restJson<any[]>(
      `/ErrorItem?select=id,originalImageUrl&id=in.(${inList})`,
    ).catch(() => []);
    return json({ images: Array.isArray(rows) ? rows : [] });
  }
  /**
   * 批改页按 id 取整题（含答案与原图）。一页最多 100 道，一次查完。
   * 不复用 list 是因为批改只需要「这一批」，拉全库再过滤会白传几百 KB。
   */
  if (sub === "details" && ctx.method === "GET") {
    const ids = (ctx.query.get("ids") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
    if (!ids.length) return json({ items: [] });
    const inList = ids.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const rows = await restJson<any[]>(
      `/ErrorItem?select=${[...PRINT_FIELDS, "originalImageUrl"].join(",")}&id=in.(${inList})`,
    ).catch(() => []);
    return json({ items: Array.isArray(rows) ? rows : [] });
  }
  return null;
}

/** 批量删除：一次 DELETE ... id=in.(...) 取代 N 次串行往返；失败再逐条兜底 */
async function deleteMany(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (const chunk of chunks) {
    const inList = chunk.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
    const ok = await restJson(`/ErrorItem?id=in.(${inList})`, { method: "DELETE" })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      // 某些 RLS/权限配置下批量 DELETE 可能被拒，退回逐条以保证功能可用
      await Promise.all(
        chunk.map((id) =>
          restJson(byId("ErrorItem", id), { method: "DELETE" }).catch(() => {}),
        ),
      );
    }
  }
}

export async function handleErrorItems(ctx: RouteContext): Promise<Response | null> {
  const [root, second, third] = ctx.parts;
  if (root !== "error-items" || ctx.parts.length > 3) return null;

  const fixed = await handleFixed(ctx, second || "");
  if (fixed) return fixed;

  // 集合
  if (!second) {
    if (ctx.method === "GET") {
      // 旧实现 select=* 把整库 7.6MB 原图拉回；列表路径一律走 list，这里只保留兼容
      return json(
        await restJson<any[]>(
          `/ErrorItem?select=${LIST_FIELDS.join(",")}&order=createdAt.desc`,
        ).catch(() => []),
      );
    }
    if (ctx.method === "POST") {
      const user = await requireUser();
      // 查重下推数据库：旧版每次保存前都把全库 7.6MB 原图拉回浏览器，
      // 再在 JS 里找 2 秒内同题干，这是「上传/保存慢」最隐蔽的主因。
      // 现在只查 id，条件全部交给 PostgREST，往返只有几百字节。
      const preview = likeTerm(String(ctx.body?.questionText || "").slice(0, 100));
      if (preview) {
        const since = new Date(Date.now() - 5000).toISOString();
        const recent = await restJson<any[]>(
          `/ErrorItem?select=id&userId=eq.${encodeURIComponent(user.id)}` +
            `&createdAt=gte.${encodeURIComponent(since)}` +
            `&questionText=like.${encodeURIComponent(preview)}*&limit=1`,
        ).catch(() => []);
        if (recent?.[0]?.id) return json({ id: recent[0].id, duplicate: true });
      }
      const row = buildItem(ctx.body || {}, user.id);
      const created = await restJson<any[]>("/ErrorItem", {
        method: "POST",
        body: JSON.stringify(row),
      });
      const item = created?.[0] || row;
      if (Array.isArray(ctx.body?.knowledgePoints)) {
        await linkTags(item.id, ctx.body.knowledgePoints);
      }
      return json(await attachRelations(item));
    }
    return null;
  }

  // 单个错题：/api/error-items/:id[/:action]
  const id = second;
  const action = third;
  const one = () => restJson<any[]>(byId("ErrorItem", id));

  if (!action) {
    if (ctx.method === "GET") {
      const rows = await one();
      return rows?.length ? json(await attachRelations(rows[0])) : apiError(404, "Item not found");
    }
    if (ctx.method === "PUT" || ctx.method === "PATCH") {
      const patch = { ...(ctx.body || {}), updatedAt: nowIso() };
      for (const key of ["id", "userId", "createdAt", "tags", "subject"]) delete patch[key];
      const rows = await restJson<any[]>(byId("ErrorItem", id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return json(rows?.[0] || { id, ...patch });
    }
    if (ctx.method === "DELETE") {
      await restJson(byId("ErrorItem", id), { method: "DELETE" }).catch(() => {});
      return json({ message: "Deleted successfully" });
    }
    return null;
  }

  if (action === "delete" && ctx.method === "DELETE") {
    await restJson(byId("ErrorItem", id), { method: "DELETE" }).catch(() => {});
    return json({ message: "Deleted successfully" });
  }
  if (action === "attempt" && ctx.method === "POST") {
    const result = String(ctx.body?.result || "");
    if (!["correct", "wrong", "skip"].includes(result)) {
      return apiError(400, "result must be correct | wrong | skip");
    }
    const row = await recordAttempt(id, result);
    return row ? json(row) : apiError(404, "Item not found");
  }
  if (action === "mastery" && (ctx.method === "PATCH" || ctx.method === "PUT")) {
    const rows = await restJson<any[]>(byId("ErrorItem", id), {
      method: "PATCH",
      body: JSON.stringify({ masteryLevel: ctx.body?.masteryLevel, updatedAt: nowIso() }),
    });
    return json(rows?.[0] || { id, masteryLevel: ctx.body?.masteryLevel });
  }
  if (action === "notes" && (ctx.method === "PATCH" || ctx.method === "PUT")) {
    const notes = ctx.body?.userNotes ?? ctx.body?.notes ?? "";
    const rows = await restJson<any[]>(byId("ErrorItem", id), {
      method: "PATCH",
      body: JSON.stringify({ userNotes: notes, updatedAt: nowIso() }),
    });
    return json({ id, userNotes: notes, ...(rows?.[0] || {}) });
  }
  if (action === "geogebra" && ctx.method === "POST") {
    // 旧静态版这里是降级占位；现在转发到 ai-proxy，失败时返回空命令避免页面报错
    try {
      const res = await aiEdge("geogebra_analyze", {
        errorItemId: id,
        previousErrors: ctx.body?.previousErrors || "",
      }, ctx.signal);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const commands = data?.commands || "";
        if (commands) {
          await restJson(byId("ErrorItem", id), {
            method: "PATCH",
            body: JSON.stringify({ geogebraCommands: commands, updatedAt: nowIso() }),
          }).catch(() => {});
        }
        return json({ commands, suitable: !!commands });
      }
    } catch {
      /* 落到下面的降级返回 */
    }
    return json({ commands: "", suitable: false, message: "AI_QUOTA_BLOCKED" });
  }
  return null;
}

export const ERROR_ITEM_HANDLERS: RouteHandler[] = [handleErrorItems];
