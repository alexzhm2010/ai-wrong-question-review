/**
 * fetch 桥接层：把旧版 42 个 /api/* 请求在本地翻译成 Supabase 调用。
 *
 * 这是本次迁移的核心。旧版所有前端组件都通过 apiClient.get('/api/xxx') 取数据，
 * 我们保留这些调用不变，只在浏览器里拦截 fetch，把请求交给按业务域拆分的
 * routes/* 处理器。处理器用 PostgREST / RPC / Edge Function 完成原来服务端的逻辑，
 * 并合成一个 Response 返回，前端代码完全感知不到差别。
 */
import { BASE_PATH } from "./config";
import { ApiBridgeError, getSession } from "./core";
import { apiError, json, type RouteContext } from "./http";
import { ROUTE_HANDLERS } from "./routes";
import { handleAiRoute } from "./routes/ai";
import { handleAuthRoute } from "./routes/auth";

/** 无需登录即可访问的根路径（与旧版 middleware 的 PUBLIC_API_PREFIXES 对齐） */
const PUBLIC_ROOTS = ["version", "auth", "register", "openclaw"];

function normalize(raw: string): string {
  let path = raw;
  if (!path.startsWith("/")) {
    try {
      const url = new URL(path);
      path = url.pathname + url.search;
    } catch {
      return path;
    }
  }
  if (path.startsWith(BASE_PATH)) path = path.slice(BASE_PATH.length);
  return path || "/";
}

function parseBody(body: BodyInit | null | undefined): any {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

export async function handleApi(pathname: string, init?: RequestInit): Promise<Response> {
  const url = new URL(pathname, "https://local.invalid");
  const path = url.pathname;
  const query = url.searchParams;
  const method = (init?.method || "GET").toUpperCase();
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  const ctx: RouteContext = {
    method,
    path,
    parts,
    query,
    body: parseBody(init?.body),
    signal: init?.signal || undefined,
  };

  // NextAuth 兼容端点（session / csrf / providers / signout / callback）
  if (path.startsWith("/api/auth/") || path === "/api/auth") {
    return handleAuthRoute(ctx);
  }

  const root = parts[0];
  if (!PUBLIC_ROOTS.includes(root) && !getSession()) {
    return apiError(401, "Unauthorized");
  }

  for (const handler of ROUTE_HANDLERS) {
    const result = await handler(ctx);
    if (result) return result;
  }

  // AI 类端点统一走 Edge Function
  if (
    root === "ai" ||
    root === "ai-quota" ||
    ["analyze", "reanswer", "geogebra-analyze", "geogebra_analyze"].includes(root)
  ) {
    return handleAiRoute(ctx);
  }

  // 旧版存在但静态版不需要真实数据的端点，返回成功占位避免前端报错
  return json({ success: true, stub: path });
}

let installed = false;

/** 在浏览器里安装一次 fetch 拦截（模块加载时调用，SSR 阶段自动跳过） */
export function installFetchBridge(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const stripped = normalize(raw);
    if (!stripped.startsWith("/api/")) return original(input, init);
    try {
      return await handleApi(stripped, init);
    } catch (error) {
      if (error instanceof ApiBridgeError) {
        return apiError(error.status, error.message, (error.data as Record<string, unknown>) || {});
      }
      return apiError(500, error instanceof Error ? error.message : String(error), {
        error: "INTERNAL_ERROR",
      });
    }
  };
}
