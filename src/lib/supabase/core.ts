/**
 * Supabase 访问内核：会话、PostgREST、RPC、Edge Functions。
 *
 * 静态版没有 Node 服务端，所有「后端」能力都落在这里：
 * - 会话：Supabase Auth 的 password / refresh_token 流程，存 localStorage
 * - 数据：PostgREST（rest/v1），由 RLS 保证用户只能读写自己的数据
 * - AI：Edge Function ai-proxy（服务端持有各家 AI 厂商密钥）
 * - 特权操作：Postgres RPC（注册用户、管理员增删用户、重置数据）
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, AI_EDGE, UPLOAD_EDGE } from "./config";

const SESSION_KEY = "sb-static-session";

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  username?: string;
  role: string;
}

export interface StaticSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  user: SessionUser;
}

/** 带 HTTP 状态码的错误，供 fetch 桥接层转换成 Response */
export class ApiBridgeError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiBridgeError";
  }
}

/* ---------------------------------- 会话 ---------------------------------- */

export function getSession(): StaticSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StaticSession) : null;
  } catch {
    return null;
  }
}

export function setSession(session: StaticSession | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可写，降级为内存态由调用方处理 */
  }
  window.dispatchEvent(new CustomEvent("sb-session-change", { detail: session }));
}

export function clearSession(): void {
  invalidateAppUser();
  setSession(null);
}

/** 从 JWT payload 解出 Supabase auth uid（仅用于日志，不用于鉴权） */
export function authUid(): string | null {
  const session = getSession();
  if (!session) return null;
  try {
    const payload = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(payload)))).sub || null;
  } catch {
    return null;
  }
}

async function refreshSession(session: StaticSession): Promise<string> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) {
      clearSession();
      return "";
    }
    const data = await res.json();
    setSession({
      ...session,
      access_token: data.access_token,
      refresh_token: data.refresh_token || session.refresh_token,
      expires_at: Date.now() + 1000 * (data.expires_in || 3600),
    });
    return data.access_token as string;
  } catch {
    clearSession();
    return "";
  }
}

/** 返回可用的 access token，过期前 60 秒自动刷新 */
export async function accessToken(): Promise<string> {
  const session = getSession();
  if (!session) return "";
  if (Date.now() < session.expires_at - 60_000) return session.access_token;
  return refreshSession(session);
}

/* -------------------------------- 通用工具 -------------------------------- */

export function nowIso(): string {
  return new Date().toISOString();
}

/** 与 Prisma cuid 形态兼容的本地 ID（不依赖服务端） */
export function cuid(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ------------------------------ PostgREST -------------------------------- */

async function restRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set("apikey", SUPABASE_ANON_KEY);
  headers.set("Authorization", `Bearer ${token || SUPABASE_ANON_KEY}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!headers.has("Prefer")) headers.set("Prefer", "return=representation");
  return fetch(`${SUPABASE_URL}/rest/v1/${path.replace(/^\//, "")}`, { ...init, headers });
}

/** 调用 PostgREST，返回解析后的 JSON；非 2xx 抛 ApiBridgeError */
export async function restJson<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await restRequest(path, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data && (data.message || data.hint)) || `REST ${res.status}`;
    throw new ApiBridgeError(res.status, message, data);
  }
  return data as T;
}

/** 调用数据库函数（SECURITY DEFINER，用于注册/管理员操作） */
export function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return restJson<T>(`/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

/**
 * 登录标识（用户名或邮箱）→ 邮箱。
 *
 * Supabase Auth 只认邮箱，所以用户名登录先在库里换成邮箱再走密码流程。
 * 函数 login_email 是 SECURITY DEFINER，未登录也可调用；查不到返回 null。
 */
export async function resolveLoginEmail(identifier: string): Promise<string> {
  const value = identifier.trim();
  if (!value) return "";
  try {
    const email = await rpc<string | null>("login_email", { p_identifier: value });
    if (typeof email === "string" && email) return email;
  } catch {
    /* RPC 未部署时回退：按邮箱直登 */
  }
  return value.includes("@") ? value : "";
}

/* ----------------------------- Edge Functions ---------------------------- */

/** AI 统一代理：analyze / reanswer / geogebra_analyze / test / practice_generate */
export async function aiEdge(
  action: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const token = await accessToken();
  return fetch(AI_EDGE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action, payload }),
    signal,
  });
}

/** OpenClaw 批量导入 */
export async function uploadEdge(payload: unknown): Promise<Response> {
  const token = await accessToken();
  const res = await fetch(UPLOAD_EDGE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(payload || {}),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
  });
}

/* -------------------------------- 当前用户 ------------------------------- */

let cachedUser: Record<string, any> | null = null;

/**
 * 当前登录用户在 User 表里的记录。RLS 会自动按 auth.uid() 过滤，
 * 所以 `select=*&limit=1` 拿到的就是自己那一行。
 */
export async function appUser(force = false): Promise<Record<string, any> | null> {
  if (cachedUser && !force) return cachedUser;
  if (!getSession()) return null;
  const rows = await restJson<any[]>("/User?select=*&limit=1");
  cachedUser = rows?.[0] || null;
  return cachedUser;
}

export function invalidateAppUser(): void {
  cachedUser = null;
}

/** 要求已登录，否则 401 */
export async function requireUser(): Promise<Record<string, any>> {
  const user = await appUser();
  if (!user) throw new ApiBridgeError(401, "Unauthorized");
  return user;
}

/** 要求管理员，否则 403 */
export async function requireAdmin(): Promise<Record<string, any>> {
  const user = await requireUser();
  if (user.role !== "admin") throw new ApiBridgeError(403, "Forbidden");
  return user;
}

/** PostgREST 的单行过滤路径，例如 byId("ErrorItem", "c123") */
export function byId(table: string, id: string): string {
  return `/${table}?id=eq.${encodeURIComponent(id)}`;
}
