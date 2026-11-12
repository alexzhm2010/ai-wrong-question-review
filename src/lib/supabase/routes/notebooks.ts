/** 错题本（对应 Prisma Subject 模型） */
import { byId, cuid, nowIso, requireUser, restJson } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";
import { listNotebooks } from "./shared";

export async function handleNotebooks(ctx: RouteContext): Promise<Response | null> {
  const [root, id] = ctx.parts;
  if (root !== "notebooks" || ctx.parts.length > 2) return null;

  // 列表
  if (!id) {
    if (ctx.method === "GET") return json(await listNotebooks());
    if (ctx.method === "POST") {
      const user = await requireUser();
      const name = String(ctx.body?.name || "").trim();
      if (!name) return apiError(400, "Notebook name is required");
      // 只按自己的本查重：管理员既不该被别人的同名本挡住，也不该漏掉自己的。
      // 查询失败要明确报错，不能静默当成「没有重名」继续创建。
      const existing = await restJson<any[]>(
        `/Subject?select=id,name&userId=eq.${encodeURIComponent(user.id)}`,
      ).catch(() => null);
      if (existing === null) return apiError(503, "Unable to verify notebook name, please retry");
      if (existing.some((s) => s.name === name)) {
        return apiError(409, "Notebook with this name already exists");
      }
      const row = {
        id: cuid(),
        name,
        userId: user.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      // (name, userId) 上有唯一约束；并发重复创建会 409，转成明确提示
      let created: any[];
      try {
        created = await restJson<any[]>("/Subject", {
          method: "POST",
          body: JSON.stringify(row),
        });
      } catch (e: any) {
        if (e?.status === 409) return apiError(409, "Notebook with this name already exists");
        throw e;
      }
      return json({ ...(created?.[0] || row), _count: { errorItems: 0 } }, 201);
    }
    return null;
  }

  // 单个错题本
  if (ctx.method === "GET") {
    const rows = await restJson<any[]>(byId("Subject", id));
    if (!rows?.length) return apiError(404, "Notebook not found");
    const items = await restJson<any[]>("/ErrorItem?select=id,subjectId").catch(() => []);
    return json({ ...rows[0], _count: { errorItems: items.filter((i) => i.subjectId === id).length } });
  }
  if (ctx.method === "PUT") {
    const name = String(ctx.body?.name || "").trim();
    if (!name) return apiError(400, "Notebook name is required");
    const rows = await restJson<any[]>(byId("Subject", id), {
      method: "PATCH",
      body: JSON.stringify({ name, updatedAt: nowIso() }),
    });
    return json(rows?.[0] || { id, name });
  }
  if (ctx.method === "DELETE") {
    await restJson(byId("Subject", id), { method: "DELETE" }).catch(() => {});
    return json({ message: "Notebook deleted successfully" });
  }
  return null;
}

export const NOTEBOOK_HANDLERS: RouteHandler[] = [handleNotebooks];
