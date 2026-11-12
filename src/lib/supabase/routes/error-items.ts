/** 错题 CRUD、筛选分页、批量删除、掌握状态、笔记、GeoGebra */
import { aiEdge, byId, cuid, nowIso, requireUser, restJson, restJsonPage } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";
import { attachRelations } from "./shared";

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

/** 标签索引缓存：1809 条标签树，避免每次列表请求都全表拉一次 */
let tagIndexCache: { at: number; rows: { id: string; name: string; parentId: string | null }[] } | null = null;
async function tagIndex() {
  if (tagIndexCache && Date.now() - tagIndexCache.at < 300_000) return tagIndexCache.rows;
  const rows = await restJson<any[]>("/KnowledgeTag?select=id,name,parentId").catch(() => []);
  tagIndexCache = { at: Date.now(), rows: rows || [] };
  return tagIndexCache.rows;
}

/**
 * 批量装配列表的 tags / subject。
 * 旧实现每条错题单独查一次关联表（每页 18 次串行往返），这里改成
 * 「一次 in.(...) 批量查关联 + 内存映射」，无论一页多少条都只有固定 2~3 次请求。
 */
async function attachMany(items: Record<string, any>[]): Promise<Record<string, any>[]> {
  if (!items.length) return [];
  const ids = items.map((i) => `"${String(i.id).replace(/"/g, "")}"`).join(",");
  const [tags, links, subjects] = await Promise.all([
    tagIndex(),
    restJson<any[]>(`/_ErrorItemToKnowledgeTag?select=A,B&A=in.(${ids})`).catch(() => []),
    restJson<any[]>("/Subject?select=id,name").catch(() => []),
  ]);
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
      const rows = await tagIndex();
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
    const ids: string[] = ctx.body?.ids || [];
    for (const id of ids) await restJson(byId("ErrorItem", id), { method: "DELETE" }).catch(() => {});
    return json({ success: true, deleted: ids.length });
  }
  if (sub === "clear" && ctx.method === "DELETE") {
    await requireUser();
    const rows = await restJson<any[]>("/ErrorItem?select=id").catch(() => []);
    for (const row of rows) {
      await restJson(byId("ErrorItem", row.id), { method: "DELETE" }).catch(() => {});
    }
    return json({ message: "Error data cleared successfully", count: rows.length });
  }
  return null;
}

export async function handleErrorItems(ctx: RouteContext): Promise<Response | null> {
  const [root, second, third] = ctx.parts;
  if (root !== "error-items" || ctx.parts.length > 3) return null;

  const fixed = await handleFixed(ctx, second || "");
  if (fixed) return fixed;

  // 集合
  if (!second) {
    if (ctx.method === "GET") {
      return json(await restJson<any[]>("/ErrorItem?select=*&order=createdAt.desc").catch(() => []));
    }
    if (ctx.method === "POST") {
      const user = await requireUser();
      // 两秒内同题干的重复提交直接复用，避免 AI 流式重复写入
      const preview = String(ctx.body?.questionText || "").slice(0, 100);
      if (preview) {
        const recent = await restJson<any[]>("/ErrorItem?select=*&order=createdAt.desc").catch(() => []);
        const duplicate = recent.find(
          (item) =>
            String(item.questionText || "").startsWith(preview) &&
            Date.now() - new Date(item.createdAt).getTime() < 2000,
        );
        if (duplicate) return json({ ...duplicate, duplicate: true });
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
