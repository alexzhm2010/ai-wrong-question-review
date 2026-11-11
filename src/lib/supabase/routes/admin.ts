/** 管理员后台：仪表盘、用户管理、系统重置 */
import { byId, requireAdmin, restJson, rpc } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";

async function handleAdmin(ctx: RouteContext): Promise<Response | null> {
  const [root, sub, third, fourth] = ctx.parts;
  if (root !== "admin") return null;

  if (sub === "dashboard") {
    await requireAdmin();
    const users = await restJson<any[]>("/User?select=id,email,name,role,createdAt").catch(() => []);
    const items = await restJson<any[]>("/ErrorItem?select=id").catch(() => []);
    return json({ totalUsers: users.length, totalErrors: items.length, users });
  }

  if (sub === "migrate-tags") return json({ success: true, migrated: 0 });

  if (sub === "system-reset") {
    await requireAdmin();
    if (ctx.body?.confirm !== "RESET") {
      return apiError(400, "Confirmation string 'RESET' is required for system reset");
    }
    const result = await rpc<any>("reset_user_data").catch((e) => ({
      success: false,
      error: e?.message || "重置失败",
    }));
    if (!result?.success) return apiError(400, result?.error || "重置失败");
    return json({ success: true, ...result });
  }

  if (sub === "users") {
    await requireAdmin();
    if (!third) {
      if (ctx.method === "GET") {
        return json(
          await restJson<any[]>(
            "/User?select=id,email,name,role,isActive,createdAt",
          ).catch(() => []),
        );
      }
      if (ctx.method === "POST") {
        const { email, password, name, role } = ctx.body || {};
        const result = await rpc<any>("admin_create_user", {
          p_email: email,
          p_password: password,
          p_name: name,
          p_role: role || "user",
        }).catch((e) => ({ success: false, error: e?.message || "创建失败" }));
        if (!result?.success) return apiError(400, result?.error || "创建失败");
        return json({ id: result.id, email: result.email, role: result.role }, 201);
      }
      return null;
    }

    // 用户详情（/api/admin/users/:id 或 /api/admin/users/:id/detail）
    if (ctx.method === "GET") {
      const rows = await restJson<any[]>(byId("User", third));
      const items = await restJson<any[]>("/ErrorItem?select=*").catch(() => []);
      return json({ ...(rows?.[0] || {}), errorItems: items.filter((i) => i.userId === third) });
    }
    if (ctx.method === "PATCH" || ctx.method === "PUT") {
      const rows = await restJson<any[]>(byId("User", third), {
        method: "PATCH",
        body: JSON.stringify(ctx.body || {}),
      });
      return json(rows?.[0] || { id: third, ...(ctx.body || {}) });
    }
    if (ctx.method === "DELETE") {
      const result = await rpc<any>("admin_delete_user", { p_target_user_id: third }).catch((e) => ({
        success: false,
        error: e?.message || "删除失败",
      }));
      if (!result?.success) return apiError(400, result?.error || "删除失败");
      return json({ success: true, deleted: third });
    }
    return null;
  }

  return null;
}

export const ADMIN_HANDLERS: RouteHandler[] = [handleAdmin];
