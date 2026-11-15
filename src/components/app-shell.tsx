"use client";

/**
 * 方案 C 双端外壳：一套页面组件，两套导航壳。
 *
 * 桌面（≥768px）左侧固定侧栏，手机（<768px）底部 4 Tab。
 * 内容页不重复写导航，只在本组件里按断点切换。
 *
 * 静态导出注意：Next 的 usePathname() 在 basePath 下通常不含前缀，但不同
 * 版本行为不一致，这里统一剥一次；选中态才能正确高亮。
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    Upload, BookOpen, Sparkles, User, Layers, Tags, BarChart3, Activity,
    ChevronRight, Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/supabase/session";
import { VersionBadge } from "@/components/version-badge";
import {
    isShellExempt,
    activeTabKey,
    isNavActive as matchNavPath,
} from "@/lib/app-shell-path";

type NavItem = {
    href: string;
    label: string;
    icon: typeof Upload;
    /** 高亮时额外匹配的路径前缀 */
    match?: string[];
};

const MAIN_TABS: NavItem[] = [
    { href: "/", label: "导入", icon: Upload },
    { href: "/notebooks", label: "错题本", icon: BookOpen },
    { href: "/review", label: "复习", icon: Sparkles },
    { href: "/me", label: "我的", icon: User },
];

const SIDE_GROUPS: { title: string; items: NavItem[] }[] = [
    {
        title: "学习",
        items: [
            { href: "/", label: "导入错题", icon: Upload },
            { href: "/notebooks", label: "错题本", icon: BookOpen, match: ["/notebook"] },
            { href: "/review", label: "今日复习", icon: Sparkles, match: ["/practice"] },
            { href: "/mastery", label: "掌握度", icon: Activity },
        ],
    },
    {
        title: "管理",
        items: [
            { href: "/batch", label: "批量进展", icon: Layers },
            { href: "/tags", label: "标签管理", icon: Tags },
            { href: "/stats", label: "统计中心", icon: BarChart3 },
        ],
    },
    {
        title: "账户",
        items: [
            { href: "/me", label: "设置 · 关于 · 退出", icon: Settings, match: ["/tags", "/stats", "/batch"] },
        ],
    },
];

export function AppShell({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const userName = session?.user?.name || session?.user?.username || session?.user?.email || "";

    // 例外页直接透传，避免导航干扰全屏表单 / 打印 / 沉浸式流程
    if (isShellExempt(pathname)) return <>{children}</>;

    const activeTab = activeTabKey(pathname);

    return (
        <div className="app-shell min-h-[100dvh] md:flex">
            {/* ============ 桌面侧栏 ============ */}
            <aside
                className={cn(
                    "app-shell-nav app-sidebar hidden md:flex md:sticky md:top-0 md:h-[100dvh] md:w-60 md:shrink-0",
                    "flex-col border-r border-sidebar-border bg-sidebar px-3 py-4 backdrop-blur-xl",
                )}
            >
                <Link href="/" className="mb-5 flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                        <Sparkles className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                        <span className="block truncate text-sm font-bold leading-tight text-foreground">错题复习</span>
                        <span className="block text-[10px] leading-tight text-muted-foreground">AI 智能错题本</span>
                    </span>
                </Link>

                <nav className="flex-1 space-y-4 overflow-y-auto">
                    {SIDE_GROUPS.map((group) => (
                        <div key={group.title}>
                            <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                                {group.title}
                            </div>
                            <div className="space-y-0.5">
                                {group.items.map((item) => {
                                    const active = matchNavPath(item.href, pathname, item.match || []);
                                    const Icon = item.icon;
                                    return (
                                        <Link
                                            key={item.href}
                                            href={item.href}
                                            aria-current={active ? "page" : undefined}
                                            className={cn(
                                                "flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] transition-colors",
                                                active
                                                    ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground shadow-sm"
                                                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                                            )}
                                        >
                                            <Icon className="h-4 w-4 shrink-0" />
                                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                                            {active && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" />}
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </nav>

                <Link
                    href="/me"
                    className="mt-3 flex items-center gap-2 rounded-xl border border-border/60 bg-card/70 px-3 py-2.5"
                >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                        <User className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-foreground">{userName || "我的账户"}</span>
                        <span className="block text-[10px] text-muted-foreground">设置 · 配额 · 版本</span>
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </Link>
                <div className="mt-2 flex justify-center">
                    <VersionBadge />
                </div>
            </aside>

            {/* ============ 内容区 ============ */}
            <main className="app-main min-w-0 flex-1">{children}</main>

            {/* ============ 手机底部 4 Tab ============ */}
            <nav
                className={cn(
                    "app-shell-nav app-tabbar fixed inset-x-0 bottom-0 z-40 md:hidden",
                    "border-t border-border bg-card/90 backdrop-blur-xl",
                    "pb-[env(safe-area-inset-bottom)]",
                )}
                style={{ height: "calc(var(--app-tabbar-h) + env(safe-area-inset-bottom))" }}
                aria-label="主导航"
            >
                <div className="flex h-[var(--app-tabbar-h)] items-stretch">
                    {MAIN_TABS.map((tab) => {
                        const active = activeTab === tab.href;
                        const Icon = tab.icon;
                        return (
                            <Link
                                key={tab.href}
                                href={tab.href}
                                aria-current={active ? "page" : undefined}
                                className={cn(
                                    "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors",
                                    active ? "text-primary" : "text-muted-foreground",
                                )}
                            >
                                <Icon className={cn("h-5 w-5", active && "stroke-[2.3]")} />
                                <span>{tab.label}</span>
                            </Link>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
}
