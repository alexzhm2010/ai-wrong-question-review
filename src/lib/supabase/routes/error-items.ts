/** 错题 CRUD、筛选分页、批量删除、掌握状态、笔记、GeoGebra */
import { aiEdge, byId, cuid, nowIso, requireUser, restJson } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";
import { attachRelations } from "./shared";

const ITEM_FIELDS = [
  "ocrText", "questionText", "answerText", "analysis", "wrongAnswerText",
  "mistakeAnalysis", "mistakeStatus", "geogebraCommands", "source", "errorType",
  "userNotes", "gradeSemester", "paperLevel", "subjectId",
];

function buildItem(body: any, userId: string): Record<string, any> {
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

async function linkTags(itemId: string, knowledgePoints: any[]): Promise<void> {
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
    const all = await restJson<any[]>("/ErrorItem?select=*&order=createdAt.desc").catch(() => []);
    const page = Number(ctx.query.get("page") || 1);
    const pageSize = Number(ctx.query.get("pageSize") || 10);
    const subjectId = ctx.query.get("subjectId");
    const search = (ctx.query.get("search") || "").trim();
    const gradeSemester = ctx.query.get("gradeSemester");
    const mastery = ctx.query.get("masteryLevel");
    const filtered = all.filter(
      (item) =>
        (!subjectId || item.subjectId === subjectId) &&
        (!gradeSemester || item.gradeSemester === gradeSemester) &&
        (mastery === null || mastery === "" || String(item.masteryLevel) === mastery) &&
        (!search ||
          `${item.questionText || ""}${item.ocrText || ""}${item.userNotes || ""}`.includes(search)),
    );
    const offset = (page - 1) * pageSize;
    const allTags = await restJson<any[]>("/KnowledgeTag?select=*").catch(() => []);
    // 一次取出学科名池，避免逐条再查
    const allSubjects = await restJson<any[]>("/Subject?select=id,name").catch(() => []);
    return json({
      items: await Promise.all(
        filtered.slice(offset, offset + pageSize).map((i) => attachRelations(i, allTags, allSubjects)),
      ),
      total: filtered.length,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
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
