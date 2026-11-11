"use client";

import { LanguageProvider } from "@/contexts/LanguageContext";
import { SessionProvider } from "@/lib/supabase/session";
import { Toaster } from "@/components/ui/toaster";
import { installFetchBridge } from "@/lib/supabase/bridge";

// 在客户端模块加载时把 /api/* 请求桥接到 Supabase（构建/SSR 阶段自动跳过）
installFetchBridge();

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <SessionProvider>
            <LanguageProvider>
                {children}
                <Toaster />
            </LanguageProvider>
        </SessionProvider>
    );
}
