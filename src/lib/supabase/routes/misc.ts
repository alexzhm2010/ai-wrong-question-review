/** version / settings / user / 日志 / 注册 / OpenClaw 导入 */
import { APP_VERSION, APP_CHANNEL, SUPABASE_URL, SUPABASE_ANON_KEY } from "../config";
import {
  authUid,
  byId,
  getSession,
  nowIso,
  requireAdmin,
  requireUser,
  restJson,
  rpc,
  uploadEdge,
} from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";
import { loadPublicConfig, savePublicConfig } from "./shared";
import { fetchLastUsedGrade } from "./grade";

async function handleVersion(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "version") return null;
  return json({ version: APP_VERSION, channel: APP_CHANNEL });
}

async function handleSettings(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "settings") return null;
  if (ctx.method === "GET") return json(await loadPublicConfig());
  if (ctx.method === "POST") {
    await requireAdmin();
    const current = await loadPublicConfig();
    const merged = { ...current, ...(ctx.body || {}) };
    const { gemini, azure, openai, ...rest } = merged;
    await savePublicConfig({ ...rest, gemini, azure, openai });
    return json(await loadPublicConfig());
  }
  return null;
}

async function handleUser(ctx: RouteContext): Promise<Response | null> {
  const [root, sub] = ctx.parts;
  if (root !== "user" || (sub && sub !== "last-grade") || ctx.parts.length > 2) return null;

  if (!sub) {
    if (ctx.method === "GET") return json(await requireUser());
    if (ctx.method === "PUT") {
      const user = await requireUser();
      const patch: Record<string, any> = { updatedAt: nowIso() };
      for (const key of ["name", "educationStage", "enrollmentYear", "email"]) {
        if (ctx.body?.[key] !== undefined) patch[key] = ctx.body[key];
      }
      const rows = await restJson<any[]>(byId("User", user.id), {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return json(rows?.[0] || { ...user, ...patch });
    }
    return null;
  }

  // /api/user/last-grade：沿用最近一道错题的年级学期。
  // 与入库兜底共用 grade.ts 的判定，保证「编辑器预填」和「写库结果」是同一个值。
  if (ctx.method === "GET") {
    const user = await requireUser();
    return json({ gradeSemester: await fetchLastUsedGrade(user.id) });
  }
  if (ctx.method === "POST" || ctx.method === "PUT") {
    return json({ gradeSemester: ctx.body?.gradeSemester || null });
  }
  return null;
}

async function handleFrontendLog(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "logs" || ctx.parts[1] !== "frontend" || ctx.method !== "POST") return null;
  const session = getSession();
  await fetch(`${SUPABASE_URL}/rest/v1/frontend_logs`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      auth_user_id: authUid(),
      level: ctx.body?.level || "info",
      event: String(ctx.body?.message || ctx.body?.event || "").slice(0, 2000),
      context: ctx.body?.context || {},
      created_at: nowIso(),
    }),
  }).catch(() => {});
  return json({ success: true });
}

async function handleRegister(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "register") return null;

  if (ctx.parts[1] === "status") {
    const cfg = await loadPublicConfig();
    const enabled = cfg.allowRegistration !== false;
    return json({ enabled, allowRegistration: enabled });
  }
  if (ctx.parts.length === 1 && ctx.method === "POST") {
    const { email, password, name, username } = ctx.body || {};
    const result = await rpc<any>("register_user", {
      p_email: email,
      p_password: password,
      p_name: name,
      p_username: username,
    }).catch((e) => ({ success: false, error: e?.message || "注册失败" }));
    if (!result?.success) return apiError(400, result?.error || "注册失败");
    return json(
      { user: { id: result.id, email: result.email, username: result.username }, message: "User created successfully" },
      201,
    );
  }
  return apiError(404, "Unknown register endpoint");
}

async function handleOpenclaw(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "openclaw" || ctx.parts[1] !== "batch-upload") return null;
  return uploadEdge(ctx.body);
}

export const MISC_HANDLERS: RouteHandler[] = [
  handleVersion,
  handleSettings,
  handleUser,
  handleFrontendLog,
  handleRegister,
  handleOpenclaw,
];
