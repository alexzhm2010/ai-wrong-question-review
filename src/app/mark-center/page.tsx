"use client";

/**
 * 批改中心：列出当前用户生成过的所有试卷，点一份进入扫码批改页。
 * 数据来自 paper_list RPC（按当前用户过滤），列表不含题目/答案，
 * 题目与答案仍由 /mark 页凭 code 通过 paper_read 读取。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import { useSession } from "@/lib/supabase/session";
import {
    formatPaperTime,
    markHref,
    paperStatus,
} from "@/lib/paper-list";
import type { PaperListRow } from "@/lib/supabase/routes/paper";
import { FileText, Plus, RefreshCw } from "lucide-react";

export default function MarkCenterPage() {
    const { status: sessionStatus } = useSession();
    const [rows, setRows] = useState<PaperListRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async (silent = false) => {
        if (silent) setRefreshing(true);
        else setLoading(true);
        setError("");
        try {
            const data = await apiClient.get<PaperListRow[]>("/api/paper/list");
            setRows(Array.isArray(data) ? data : []);
        } catch (e: any) {
            const msg = String(e?.message || "");
            setError(msg.includes("401") || msg.includes("登录") ? "请先登录后再查看批改中心。" : "加载试卷列表失败，请下拉重试。");
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        // 会话确定后再取数，避免未登录时打一次注定 401 的请求
        if (sessionStatus === "loading") return;
        if (sessionStatus === "unauthenticated") {
            setLoading(false);
            setError("请先登录后再查看批改中心。");
            return;
        }
        void load();
    }, [sessionStatus, load]);

    return (
        <div className="min-h-screen bg-slate-50 pb-24">
            {/* 顶栏 */}
            <div className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
                <div className="mx-auto flex max-w-2xl items-center gap-2.5 px-3 py-2.5">
                    <BackButton fallbackUrl="/me" />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold leading-tight">批改中心</div>
                        <div className="text-[11px] leading-tight text-muted-foreground">
                            选一份试卷，查看题目与批改结果
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => void load(true)}
                        disabled={refreshing}
                        aria-label="刷新列表"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                    >
                        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                    </button>
                </div>
            </div>

            <div className="mx-auto max-w-2xl px-3 py-4">
                {/* 生成入口 */}
                <Link
                    href="/review"
                    className="mb-4 flex items-center justify-between rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10"
                >
                    <span className="flex items-center gap-3">
                        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                            <Plus className="h-5 w-5" />
                        </span>
                        <span>
                            <span className="block text-[13px] font-semibold">生成今日复习卷</span>
                            <span className="block text-[11px] text-muted-foreground">
                                出卷后打印，卷首二维码供扫码批改
                            </span>
                        </span>
                    </span>
                    <span className="text-xs font-medium text-primary">去生成 ›</span>
                </Link>

                {loading ? (
                    <div className="flex justify-center py-16 text-sm text-muted-foreground">
                        正在加载试卷列表…
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-center">
                        <div className="text-4xl">📋</div>
                        <p className="text-sm text-foreground/80">{error}</p>
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="rounded-lg border bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
                        >
                            重新加载
                        </button>
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-center">
                        <div className="text-4xl">📄</div>
                        <p className="text-sm font-medium">还没有生成的试卷</p>
                        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                            点上方「生成今日复习卷」出第一份卷子，打印后让学生扫码批改，
                            这里就会出现记录。
                        </p>
                    </div>
                ) : (
                    <div className="space-y-2.5">
                        <div className="px-1 text-[11px] text-muted-foreground">
                            共 {rows.length} 份试卷
                        </div>
                        {rows.map((row) => {
                            const s = paperStatus(row);
                            return (
                                <Link
                                    key={row.code}
                                    href={markHref(row.code)}
                                    className="block rounded-xl border bg-white p-3.5 transition-colors hover:border-primary/50 hover:bg-slate-50/60"
                                >
                                    <div className="flex items-start gap-3">
                                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                                            <FileText className="h-5 w-5" />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <span className="truncate text-[13px] font-semibold">
                                                    卷号 {row.paperNo || row.code.slice(0, 12)}
                                                </span>
                                                <span
                                                    className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                                        s.tone === "done"
                                                            ? "bg-emerald-50 text-emerald-700"
                                                            : "bg-amber-50 text-amber-700"
                                                    }`}
                                                >
                                                    {s.label}
                                                </span>
                                            </div>
                                            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                                                {row.subjectNames && <span>{row.subjectNames}</span>}
                                                {row.subjectNames && <span>·</span>}
                                                <span>{row.itemCount} 题</span>
                                                <span>·</span>
                                                <span>{formatPaperTime(row.createdAt)}</span>
                                            </div>
                                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                                                {s.detail}
                                            </div>
                                        </div>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
