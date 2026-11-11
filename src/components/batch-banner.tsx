"use client";

import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import { useActiveBatch } from "@/lib/batch-store";
import { cn } from "@/lib/utils";
import { ArrowRight, AlertTriangle, Loader2, PauseCircle } from "lucide-react";

/**
 * 首页顶部的批次看板。
 * 任务本身跑在后台，这里只是「库里的状态」的投影 —— 重新登录进来就能看到，
 * 关掉页面也不会丢。
 */
export function BatchBanner() {
    const { t } = useLanguage();
    const b = t.batch;
    const job = useActiveBatch();

    if (!job) return null;

    const total = job.counts?.total || job.totalCount || 0;
    const done = (job.counts?.done || 0) + (job.counts?.saved || 0);
    const failed = job.counts?.failed || job.failedCount || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const href = `/batch?id=${job.id}`;

    const palette = job.status === "confirming"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
        : job.status === "paused"
            ? "border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-300"
            : "border-primary/30 bg-primary/5 text-foreground";

    const title = job.status === "confirming"
        ? b.bannerPending
        : job.status === "paused"
            ? b.bannerPaused
            : job.status === "queued" ? b.bannerQueued : b.bannerProcessing;

    return (
        <Link
            href={href}
            className={cn("block shrink-0 rounded-lg border px-3 py-2 transition-colors hover:brightness-[1.03]", palette)}
        >
            <div className="flex items-center gap-2">
                {job.status === "paused" ? (
                    <PauseCircle className="h-4 w-4 shrink-0" />
                ) : job.status === "confirming" ? (
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                ) : (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">
                    {title}
                    <span className="ml-2 font-normal opacity-80">
                        {b.progress.replace("{done}", String(done)).replace("{total}", String(total))}
                        {failed > 0 ? ` · ${b.failed} ${failed}` : ""}
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium sm:text-xs">
                    {job.status === "confirming" ? b.goConfirm : b.viewProgress}
                    <ArrowRight className="h-3.5 w-3.5" />
                </span>
            </div>
            {job.status !== "confirming" && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
            )}
        </Link>
    );
}

/** 顶部导航的批量入口，带待处理角标 */
export function BatchEntryButton() {
    const { t } = useLanguage();
    const job = useActiveBatch();
    const pending = job ? (job.counts?.total || 0) - (job.counts?.done || 0) - (job.counts?.saved || 0) : 0;

    return (
        <Link
            href="/batch"
            title={t.batch.entry}
            className="relative flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            {!!job && pending > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground">
                    {pending > 99 ? "99+" : pending}
                </span>
            )}
        </Link>
    );
}
