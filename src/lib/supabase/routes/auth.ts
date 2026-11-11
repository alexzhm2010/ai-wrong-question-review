/** NextAuth 兼容端点：旧版组件仍会探测 session / providers / csrf */
import { getSession } from "../core";
import { json, apiError, type RouteContext } from "../http";

export async function handleAuthRoute(ctx: RouteContext): Promise<Response> {
  const rest = ctx.path.replace(/^\/api\/auth\/?/, "");

  if (rest === "session") {
    const s = getSession();
    return json(s ? { user: s.user, expires: new Date(s.expires_at).toISOString() } : {});
  }
  if (rest === "csrf") return json({ csrfToken: "static-csrf" });
  if (rest === "providers") {
    return json({
      credentials: {
        id: "credentials",
        name: "Credentials",
        type: "credentials",
        signinUrl: "/api/auth/callback/credentials",
        callbackUrl: "/",
      },
    });
  }
  if (rest === "signout") return json({ url: "/login" });

  // 正常登录已由 session.tsx 的 signIn() 直接走 Supabase Auth；
  // 这里仅兜底旧代码可能残留的 credentials 回调请求。
  if (rest.startsWith("callback/credentials")) {
    if (ctx.body && typeof ctx.body === "object") return json({ url: "/" });
    return apiError(401, "CredentialsSignin");
  }
  return json({});
}
