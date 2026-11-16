"use client";

/**
 * 「我的」页（方案 C 新增）。
 * 把原来挤在首页顶栏的用户 / 设置 / 版本 / 退出，以及散落在 2×2 按钮组里的
 * 管理入口统一收在这里；手机底部第 4 个 Tab 直达。
 */
import Link from "next/link";
import {
    User, Settings2, LogOut, Tags, BarChart3, Activity, Layers, ScanLine,
    ChevronRight, Bell, Shield, Info,
} from "lucide-react";
import { useSession, signOut } from "@/lib/supabase/session";
import { useLanguage } from "@/contexts/LanguageContext";
import { SettingsDialog } from "@/components/settings-dialog";
import { AiQuotaCard } from "@/components/ai-quota-card";
import { BroadcastNotification } from "@/components/broadcast-notification";
import { VersionBadge } from "@/components/version-badge";
import { Button } from "@/components/ui/button";

const SHORTCUTS = [
    { href: "/tags", label: "标签管理", desc: "知识点标签与分类", icon: Tags },
    { href: "/stats", label: "统计中心", desc: "错题分布与趋势", icon: BarChart3 },
    { href: "/mastery", label: "掌握度", desc: "各知识点掌握情况", icon: Activity },
    { href: "/batch", label: "批量进展", desc: "导入批次与历史记录", icon: Layers },
    { href: "/mark-center", label: "批改中心", desc: "查看试卷、标准答案与批改结果，不耗AI", icon: ScanLine },
];

export default function MePage() {
    const { data: session, status } = useSession();
    const { t } = useLanguage();
    const user = session?.user;
    const name = user?.name || user?.username || user?.email || (status === "loading" ? "…" : "未登录");
    const role = user?.role === "admin" ? "管理员" : "学生";

    return (
        <main className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
            <div className="mb-4 flex items-center justify-between">
                <div>
                    <h1 className="text-lg font-bold tracking-tight sm:text-xl">我的</h1>
                    <p className="mt-0.5 text-xs text-muted-foreground">账户、设置与工具入口</p>
                </div>
                <VersionBadge />
            </div>

            {/* 用户卡片 */}
            <section className="app-glass mb-4 flex items-center gap-3 p-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                    <User className="h-6 w-6" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {status === "unauthenticated" ? "登录后可同步错题数据" : `${role} · 数据已同步`}
                    </p>
                </div>
                {user?.role === "admin" && (
                    <Link
                        href="/admin"
                        className="flex shrink-0 items-center gap-1 rounded-lg border bg-card/70 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                        <Shield className="h-3.5 w-3.5" /> 后台
                    </Link>
                )}
            </section>

            {/* 工具入口 */}
            <section className="app-glass mb-4 overflow-hidden">
                <div className="border-b border-border/60 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    管理工具
                </div>
                <div className="divide-y divide-border/60">
                    {SHORTCUTS.map((item) => {
                        const Icon = item.icon;
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
                            >
                                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                                    <Icon className="h-4 w-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] font-medium">{item.label}</span>
                                    <span className="block text-[11px] text-muted-foreground">{item.desc}</span>
                                </span>
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            </Link>
                        );
                    })}
                </div>
            </section>

            {/* 设置 / 通知 */}
            <section className="app-glass mb-4 overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <Bell className="h-3.5 w-3.5" /> 通知
                    </span>
                    <BroadcastNotification />
                </div>
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                    <span className="flex items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                            <Settings2 className="h-4 w-4" />
                        </span>
                        <span>
                            <span className="block text-[13px] font-medium">偏好设置</span>
                            <span className="block text-[11px] text-muted-foreground">语言、解析、打印与模型参数</span>
                        </span>
                    </span>
                    <SettingsDialog />
                </div>
            </section>

            {/* 配额 */}
            <div className="mb-4">
                <AiQuotaCard />
            </div>

            {/* 关于 / 退出 */}
            <section className="app-glass mb-4 p-4">
                <div className="mb-3 flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>AI 错题复习平台 · 本地静态站点，数据保存在你自己的 Supabase 项目中。版本信息见右上角。</span>
                </div>
                <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => signOut({ callbackUrl: "/login" })}
                >
                    <LogOut className="mr-2 h-4 w-4" />
                    {t.app?.logout || "退出登录"}
                </Button>
            </section>
        </main>
    );
}
