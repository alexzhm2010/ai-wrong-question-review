"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Loader2, AlertTriangle, CheckCircle2, PauseCircle, Clock } from "lucide-react";

export type JobStatus = "queued" | "processing" | "confirming" | "paused" | "done" | "canceled";

export interface BatchJobRow {
    id: string;
    status: JobStatus;
    reasoningMode: "fast" | "deep";
    totalCount: number;
    doneCount: number;
    failedCount: number;
    savedCount: number;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    errorMessage?: string | null;
    createdAt: string;
}

interface Props {
    /** 已加载好的数据（首页 tab 传，页面自己管刷新）；不传则组件自己拉 */
    jobs?: BatchJobRow[] | null;
    onOpen?: (id: string) => void;
    /** 只显示前 N 条（首页 tab 用） */
    limit?: number;
    className?: string;
}

function statusMeta(status: JobStatus, b: any) {
    switch (status) {
        case "queued": return { label: b.queued, cls: "bg-muted text-muted-foreground" };
        case "processing": return { label: b.processing, cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
        case "confirming": return { label: b.confirming, cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
        case "paused": return { label: b.paused, cls: "bg-orange-500/10 text-orange-600 dark:text-orange-400" };
        case "done": return { label: b.done, cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
        default: return { label: b.canceled, cls: "bg-muted text-muted-foreground" };
    }
}

/**
 * 批次列表（多任务）。
 *
 * 分组顺序按「需要你动手的紧迫程度」排：需要处理（暂停）→ 待确认 → 进行中（含排队）
 * → 已结束。排队批次会显示队列位置，否则用户只看到「排队中」会以为卡死了。
 */
export function BatchJobList({ jobs: external, onOpen, limit, className }: Props) {
    const { t } = useLanguage();
    const b = t.batch;
    const router = useRouter();
    const [fetched, setFetched] = useState<BatchJobRow[] | null>(external ?? null);

    const load = useCallback(async () => {
        try {
            setFetched(await apiClient.get<BatchJobRow[]>("/api/batch/list"));
        } catch {
            setFetched((prev) => prev ?? []);
        }
    }, []);

    useEffect(() => {
        if (external !== undefined) setFetched(external);
    }, [external]);

    // 没有外部数据时自己轮询：只有解析中/排队才需要高频刷新
    useEffect(() => {
        if (external !== undefined) return;
        void load();
        const timer = setInterval(() => {
            if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
            void load();
        }, 6000);
        return () => clearInterval(timer);
    }, [external, load]);

    const jobs = fetched;

    // 排队位置：同账号 queued 批次按创建时间排序
    const queuePos = useMemo(() => {
        const map = new Map<string, number>();
        (jobs || [])
            .filter((j) => j.status === "queued")
            .sort((a, b2) => new Date(a.createdAt).getTime() - new Date(b2.createdAt).getTime())
            .forEach((j, i) => map.set(j.id, i + 1));
        return map;
    }, [jobs]);

    if (jobs === null) {
        return (
            <div className={cn("flex justify-center py-10", className)}>
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!jobs.length) {
        return (
            <div className={cn("rounded-lg border border-dashed px-4 py-10 text-center", className)}>
                <p className="text-sm font-medium">{b.empty}</p>
                <p className="mt-1 text-xs text-muted-foreground">{b.emptyHint}</p>
            </div>
        );
    }

    const groups: { key: string; title: string; icon: typeof Clock; items: BatchJobRow[] }[] = [
        { key: "paused", title: b.paused, icon: PauseCircle, items: jobs.filter((j) => j.status === "paused") },
        { key: "confirming", title: b.confirming, icon: AlertTriangle, items: jobs.filter((j) => j.status === "confirming") },
        {
            key: "active",
            title: b.inProgress,
            icon: Loader2,
            items: jobs.filter((j) => j.status === "processing" || j.status === "queued"),
        },
        {
            key: "finished",
            title: b.done,
            icon: CheckCircle2,
            items: jobs.filter((j) => j.status === "done" || j.status === "canceled"),
        },
    ].filter((g) => g.items.length);

    const shown = limit ? groups.slice(0, 3) : groups;
    const open = onOpen || ((id: string) => router.push(`/batch?id=${id}`));

    return (
        <div className={cn("space-y-4", className)}>
            {shown.map((g) => {
                const Icon = g.icon;
                const items = limit ? g.items.slice(0, limit) : g.items;
                return (
                    <div key={g.key} className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                            <Icon className={cn("h-3.5 w-3.5", g.key === "active" && "animate-spin")} />
                            {g.title}
                            <span className="tabular-nums">{g.items.length}</span>
                        </div>
                        {items.map((job) => {
                            const meta = statusMeta(job.status, b);
                            const done = job.doneCount;
                            const pct = job.totalCount ? Math.round((done / job.totalCount) * 100) : 0;
                            const pos = queuePos.get(job.id);
                            return (
                                <button
                                    key={job.id}
                                    onClick={() => open(job.id)}
                                    className="w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40"
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="min-w-0 truncate text-sm font-medium">
                                            {b.totalCount.replace("{count}", String(job.totalCount))}
                                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                                                {new Date(job.createdAt).toLocaleString()}
                                            </span>
                                        </span>
                                        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", meta.cls)}>
                                            {meta.label}
                                        </span>
                                    </div>
                                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                        <span>{b.progress.replace("{done}", String(done)).replace("{total}", String(job.totalCount))}</span>
                                        {job.failedCount > 0 && <span className="text-destructive">{b.failed} {job.failedCount}</span>}
                                        <span>{job.reasoningMode === "deep" ? b.deep : b.fast}</span>
                                        {job.status === "queued" && pos && (
                                            <span className="text-amber-600 dark:text-amber-400">
                                                {b.queuePosition.replace("{n}", String(pos))}
                                            </span>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}
