"use client";

/**
 * 兼容 next-auth/react API 的 Supabase Auth 会话层。
 *
 * 旧版页面里大量使用 useSession / signIn / signOut，为了让 214 个前端文件
 * 零改动，这里保持完全相同的调用签名，只把底层换成 Supabase Auth。
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { SUPABASE_URL, SUPABASE_ANON_KEY, BASE_PATH } from "./config";
import {
  clearSession,
  getSession,
  setSession,
  ensureFreshToken,
  invalidateAppUser,
  appUser,
  resolveLoginEmail,
  type StaticSession,
} from "./core";

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  username?: string | null;
  role: string;
  image?: string | null;
}

export interface Session {
  user: SessionUser;
  expires: string;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated";

interface SessionContextValue {
  data: Session | null;
  status: SessionStatus;
  update: () => Promise<Session | null>;
}

const SessionContext = createContext<SessionContextValue>({
  data: null,
  status: "loading",
  update: async () => null,
});

function toSession(raw: StaticSession | null): Session | null {
  if (!raw) return null;
  return {
    user: raw.user,
    expires: new Date(raw.expires_at).toISOString(),
  };
}

async function refreshToken(): Promise<boolean> {
  // 交给 core 的单例刷新锁处理：SessionProvider 与首屏 API 请求不会再各刷各的，
  // 避免 refresh token 被并发轮换后互相踢下线。
  if (!getSession()) return false;
  const token = await ensureFreshToken();
  return Boolean(token);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Session | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  // 登录时若 User 表没读到（RLS/网络抖动），role 会停在默认的 user；
  // 这里在后续启动时补一次校正，避免管理员每次都被降级。
  const roleSyncRef = useRef(false);

  const syncRole = useCallback(async (base: StaticSession | null) => {
    if (!base || base.roleVerified === true || roleSyncRef.current) return;
    roleSyncRef.current = true;
    try {
      const row = await appUser(true);
      if (!row?.role) return;
      const updated: StaticSession = {
        ...base,
        roleVerified: true,
        user: {
          ...base.user,
          role: row.role,
          username: row.username || base.user.username,
          name: base.user.name || row.name || "",
        },
      };
      setSession(updated, { silent: true });
      setData(toSession(updated));
    } catch {
      // 下次启动再试
    } finally {
      roleSyncRef.current = false;
    }
  }, []);

  const update = useCallback(async () => {
    const raw = getSession();
    if (!raw) {
      setData(null);
      setStatus("unauthenticated");
      return null;
    }
    const ok = await refreshToken();
    const current = getSession();
    if (!ok && !current) {
      // 只有会话真的被清掉了才算登出
      setData(null);
      setStatus("unauthenticated");
      return null;
    }
    // 刷新失败但盘上会话还在（弱网/服务端抖动）：继续当作已登录，
    // 不要因为一次请求失败就让界面掉成「欢迎回来，User」。
    const next = toSession(current || raw);
    setData(next);
    setStatus("authenticated");
    void syncRole(current || raw);
    return next;
  }, [syncRole]);

  useEffect(() => {
    void update();
    const onSessionChange = () => {
      invalidateAppUser();
      void update();
    };
    window.addEventListener("sb-session-change", onSessionChange);
    window.addEventListener("focus", update);
    const timer = window.setInterval(() => void update(), 10 * 60 * 1000);
    return () => {
      window.removeEventListener("sb-session-change", onSessionChange);
      window.removeEventListener("focus", update);
      window.clearInterval(timer);
    };
  }, [update]);

  return (
    <SessionContext.Provider value={{ data, status, update }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}

/** 兼容 NextAuth 的 getSession() */
export async function getSessionCompat(): Promise<Session | null> {
  const raw = getSession();
  if (!raw) return null;
  if (!(await refreshToken())) return null;
  return toSession(getSession());
}
export { getSessionCompat as getSession };

export interface SignInResult {
  ok: boolean;
  error: string | null;
  status: number;
  url: string | null;
}

/** 兼容 signIn("credentials", { email, password, redirect: false }) */
export async function signIn(
  provider: string,
  options: { email?: string; password?: string; redirect?: boolean; callbackUrl?: string } = {},
): Promise<SignInResult> {
  if (provider !== "credentials" || !options.email || !options.password) {
    return { ok: false, error: "CredentialsSignin", status: 401, url: null };
  }
  // 登录框收的是用户名；Supabase Auth 只认邮箱，先做一次映射
  const loginEmail = await resolveLoginEmail(options.email);
  if (!loginEmail) {
    return { ok: false, error: "CredentialsSignin", status: 401, url: null };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: loginEmail, password: options.password }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      return { ok: false, error: "CredentialsSignin", status: res.status, url: null };
    }
    const session: StaticSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + 1000 * (data.expires_in || 3600),
      token_type: data.token_type || "bearer",
      user: {
        id: data.user?.id || "",
        email: data.user?.email || loginEmail,
        name: data.user?.user_metadata?.displayName || "",
        username: data.user?.user_metadata?.username || "",
        role: "user",
      },
    };
    setSession(session);
    invalidateAppUser();
    // 读出真实角色与用户名，保证管理员后台与界面展示可用
    try {
      const row = await appUser(true);
      if (row?.role) {
        session.user.role = row.role;
        // 只有在真正读到 User 表后才标记，读不到时留给下次启动补校正
        session.roleVerified = true;
      }
      if (row?.username) session.user.username = row.username;
      if (!session.user.name && row?.name) session.user.name = row.name;
    } catch {
      /* RLS 未就绪时忽略 */
    }
    setSession(session);
    return { ok: true, error: null, status: 200, url: options.callbackUrl || "/" };
  } catch {
    return { ok: false, error: "CredentialsSignin", status: 500, url: null };
  }
}

/** 兼容 signOut({ callbackUrl: "/login" }) */
export async function signOut(options: { callbackUrl?: string; redirect?: boolean } = {}) {
  clearSession();
  const target = options.callbackUrl || "/login";
  if (options.redirect !== false && typeof window !== "undefined") {
    window.location.href = `${BASE_PATH}${target}`.replace(/\/+/g, "/");
  }
  return { url: target };
}
