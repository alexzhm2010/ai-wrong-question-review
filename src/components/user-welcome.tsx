"use client";

import { useState, useEffect } from "react";

import { useLanguage } from "@/contexts/LanguageContext";
import { useSession, signOut } from "@/lib/supabase/session";
import { Button } from "@/components/ui/button";
import { LogOut, User } from "lucide-react";

export function UserWelcome() {
    const { t, language } = useLanguage();
    const { data: session } = useSession();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Server always renders 'User' (no session). Client matches this initially.
    // After mount, we show the real name.
    const userName = mounted && session?.user ? (session.user.name || session.user.email) : 'User';

    return (
        <div className="flex w-full min-w-0 items-center gap-2 rounded-lg border bg-card p-3 shadow-sm animate-in fade-in slide-in-from-top-4 duration-700 sm:w-auto sm:p-4">
            <User className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 truncate font-medium">
                {t.common.welcome || 'Welcome back, '}
                {userName}
            </span>
        </div>
    );
}
