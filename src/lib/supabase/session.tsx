"use client";

/**
 * 兼容 next-auth/react API 的 Supabase Auth 会话层。
 *
 * 旧版页面里大量使用 useSession / signIn / signOut，为了让 214 个前端文件
 * 零改动，这里保持完全相同的调用签名，只把底层换成 Supabase Auth。
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { SUPABASE_URL, SUPABASE_ANON_KEY, BASE_PATH } from "./config";
import {
  clearSession,
  getSession,
  setSession,
  invalidateAppUser,
  appUser,
  type StaticSession,
} from "./core";

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
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
  const raw = getSession();
  if (!raw) return false;
  if (Date.now() < raw.expires_at) return true;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: raw.refresh_token }),
    });
    if (!res.ok) throw new Error("refresh failed");
    const data = await res.json();
    setSession({
      ...raw,
      access_token: data.access_token,
      refresh_token: data.refresh_token || raw.refresh_token,
      expires_at: Date.now() + 1000 * (data.expires_in || 3600),
    });
    return true;
  } catch {
    clearSession();
    return false;
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Session | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");

  const update = useCallback(async () => {
    const raw = getSession();
    if (!raw) {
      setData(null);
      setStatus("unauthenticated");
      return null;
    }
    if (!(await refreshToken())) {
      setData(null);
      setStatus("unauthenticated");
      return null;
    }
    const next = toSession(getSession());
    setData(next);
    setStatus("authenticated");
    return next;
  }, []);

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
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: options.email, password: options.password }),
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
        email: data.user?.email || options.email,
        name: data.user?.user_metadata?.displayName || "",
        role: "user",
      },
    };
    setSession(session);
    invalidateAppUser();
    // 读出真实角色，保证管理员后台可用；失败时按普通用户处理
    try {
      const row = await appUser(true);
      if (row?.role) session.user.role = row.role;
      setSession(session);
    } catch {
      /* RLS 未就绪时忽略 */
    }
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
