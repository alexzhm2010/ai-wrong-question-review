"use client";

import { useState, useEffect } from "react";

import { useLanguage } from "@/contexts/LanguageContext";
import { useSession } from "@/lib/supabase/session";
import { User } from "lucide-react";

/** 上次成功登录的用户名，用于会话恢复期间先占位，避免闪一下「User」 */
const NAME_CACHE_KEY = "wr:last-user-name";

export function UserWelcome() {
    const { t } = useLanguage();
    const { data: session, status } = useSession();
    // null = 还在确认身份（首屏）；"" = 已确认未登录
    const [name, setName] = useState<string | null>(null);

    useEffect(() => {
        if (status === "authenticated" && session?.user) {
            const next = session.user.name || session.user.username || session.user.email || "";
            setName(next);
            try {
                if (next) localStorage.setItem(NAME_CACHE_KEY, next);
            } catch {
                /* 隐私模式忽略 */
            }
            return;
        }
        if (status === "unauthenticated") {
            setName("");
            try {
                localStorage.removeItem(NAME_CACHE_KEY);
            } catch {
                /* ignore */
            }
            return;
        }
        // 还在加载：先用上次的名字，没有就临时占位，宁可显示省略号也不显示「User」
        try {
            const cached = localStorage.getItem(NAME_CACHE_KEY);
            if (cached) setName(cached);
        } catch {
            /* ignore */
        }
    }, [status, session]);

    const suffix = name === null ? "…" : name || (status === "unauthenticated" ? "User" : "");

    return (
        <div className="flex w-full min-w-0 items-center gap-2 rounded-lg border bg-card p-3 shadow-sm animate-in fade-in slide-in-from-top-4 duration-700 sm:w-auto sm:p-4">
            <User className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 truncate font-medium">
                {t.common.welcome || 'Welcome back, '}
                {suffix}
            </span>
        </div>
    );
}
