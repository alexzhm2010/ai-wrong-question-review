"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/contexts/LanguageContext";
import { BROADCAST_READ_KEY, isBroadcastUnread, markBroadcastRead } from "@/lib/broadcast-read";
import { cn } from "@/lib/utils";

export function BroadcastNotification() {
    const { t } = useLanguage();
    // 初值必须为 false：服务端渲染时读不到 localStorage，挂载后再按已读记录校正。
    const [hasUnread, setHasUnread] = useState(false);

    useEffect(() => {
        const sync = () => setHasUnread(isBroadcastUnread());
        sync();
        // 另一个标签页读过公告时，本页也同步熄灭
        const onStorage = (event: StorageEvent) => {
            if (event.key === BROADCAST_READ_KEY || event.key === null) sync();
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const handleOpenChange = (open: boolean) => {
        if (!open) return;
        // 看过了就写进 localStorage，重新进入页面不会再亮
        markBroadcastRead();
        setHasUnread(false);
    };

    const label = t.broadcast?.title || "Announcements";
    const triggerLabel = hasUnread
        ? `${label} · ${t.broadcast?.unread || "New announcements"}`
        : label;

    return (
        <DropdownMenu onOpenChange={handleOpenChange}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                        "rounded-full border transition-colors",
                        hasUnread
                            ? "border-red-500/70 text-red-500 hover:border-red-500 hover:text-red-600 dark:border-red-400/70 dark:text-red-400"
                            : "border-transparent text-muted-foreground hover:text-primary"
                    )}
                    title={triggerLabel}
                >
                    {/* lucide 图标是 currentColor 描边：只改文字色即只让线条变红，不填充、不加红点 */}
                    <Bell className="h-5 w-5" />
                    <span className="sr-only">{triggerLabel}</span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                className="w-72 sm:w-80 p-0"
            >
                <DropdownMenuLabel className="flex items-center gap-2 px-4 py-3 bg-primary/5 border-b">
                    <Bell className="h-4 w-4 text-primary" />
                    <span className="font-semibold">{t.broadcast?.title || "Announcements"}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="m-0" />
                <div className="p-4 space-y-3">
                    {/* 广播消息 1：教育阶段提醒 */}
                    <div className="flex gap-3 items-start p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                        <div className="shrink-0 mt-0.5">
                            <span className="text-amber-500 text-lg">📢</span>
                        </div>
                        <div className="space-y-1 text-sm">
                            <p className="text-foreground leading-relaxed">
                                {t.broadcast?.profileReminder || "Please make sure to correctly fill in your education stage and enrollment year in Settings -> Account to ensure tags are associated correctly."}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t.broadcast?.settingsPath || "Settings -> Account"}
                            </p>
                        </div>
                    </div>

                    {/* 广播消息 2：标签库迁移提醒 */}
                    <div className="flex gap-3 items-start p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                        <div className="shrink-0 mt-0.5">
                            <span className="text-blue-500 text-lg">🔧</span>
                        </div>
                        <div className="space-y-1 text-sm">
                            <p className="text-foreground leading-relaxed">
                                {t.broadcast?.tagMigrationReminder || "If the standard tag library fails to load, please use an admin account to reset it."}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t.broadcast?.settingsPath2 || "Settings -> Danger -> Tag System Migration"}
                            </p>
                        </div>
                    </div>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
