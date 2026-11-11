"use client";

import Link from "next/link";
import { useLanguage } from "@/contexts/LanguageContext";
import { useActiveBatches } from "@/lib/batch-store";
import { cn } from "@/lib/utils";
import { ArrowRight, AlertTriangle, Loader2, PauseCircle } from "lucide-react";

/**
 * 首页顶部的批次看板。
 * 任务本身跑在后台，这里只是「库里的状态」的投影 —— 重新登录进来就能看到，
 * 关掉页面也不会丢。同账号可能同时存在多批（排队串行），所以这里做汇总。
 */
export function BatchBanner() {
    const { t } = useLanguage();
    const b = t.batch;
    const jobs = useActiveBatches();

    if (!jobs.length) return null;

    const by = (s: string) => jobs.filter((j) => j.status === s).length;
    const paused = by("paused");
    const confirming = by("confirming");
    const running = by("processing");
    const queued = by("queued");

    // 汇总：只显示存在的状态，避免出现「待确认 0」这种噪音
    const parts = [
        confirming ? `${b.confirming} ${confirming}` : "",
        running ? `${b.processing} ${running}` : "",
        queued ? `${b.queued} ${queued}` : "",
        paused ? `${b.paused} ${paused}` : "",
    ].filter(Boolean);

    const palette = paused
        ? "border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-300"
        : confirming
            ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
            : "border-primary/30 bg-primary/5 text-foreground";

    const Icon = paused ? PauseCircle : confirming ? AlertTriangle : Loader2;

    return (
        <Link
            href="/batch"
            className={cn("block shrink-0 rounded-lg border px-3 py-2 transition-colors hover:brightness-[1.03]", palette)}
        >
            <div className="flex items-center gap-2">
                <Icon className={cn("h-4 w-4 shrink-0", !paused && !confirming && "animate-spin")} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium sm:text-sm">
                    {b.bannerSummary.replace("{count}", String(jobs.length))}
                    <span className="ml-2 font-normal opacity-80">{parts.join(" · ")}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium sm:text-xs">
                    {b.viewProgress}
                    <ArrowRight className="h-3.5 w-3.5" />
                </span>
            </div>
        </Link>
    );
}
