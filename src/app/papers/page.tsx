"use client";

/**
 * 练习试卷（归档）：所有出卷记录——无论来自「今日复习」还是「错题本导出打印」——
 * 都汇在这里。提供两个操作：
 *  - 查看：必须恰好选中一份，进入只读的试卷内容页（题图 + 标准答案）
 *  - 点击整行：进入该卷的「扫码批改」页，可看到每道题的对错判定
 *  - 删除：可多选，但「已批改」的试卷不可勾选——其逐题明细用于计算熟悉度；
 *    二次确认后批量删除（paper_delete RPC 只删本人、且只删未批改的试卷）
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { QrScanner } from "@/components/qr-scanner";
import { apiClient } from "@/lib/api-client";
import { useSession } from "@/lib/supabase/session";
import {
    canDelete,
    canView,
    deleteConfirmText,
    paperViewHref,
    paperMarkHref,
    pageAfterDelete,
    deletableCodes,
    isSubmitted,
    scoreLabel,
    PAPER_PAGE_SIZE,
    totalPages,
} from "@/lib/paper-archive";
import {
    formatPaperTime,
} from "@/lib/paper-list";
import type { PaperListRow, PaperPage } from "@/lib/supabase/routes/paper";
import { FileText, RefreshCw, Eye, Trash2, Loader2, ChevronLeft, ChevronRight, Lock, ScanLine } from "lucide-react";

export default function PapersPage() {
    const router = useRouter();
    const { status: sessionStatus } = useSession();
    const [rows, setRows] = useState<PaperListRow[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState("");
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [scanning, setScanning] = useState(false);

    const load = useCallback(async (targetPage: number, silent = false) => {
        if (silent) setRefreshing(true);
        else setLoading(true);
        setError("");
        try {
            const data = await apiClient.get<PaperPage>(
                `/api/paper/list-page?page=${targetPage}&pageSize=${PAPER_PAGE_SIZE}`,
            );
            const list = Array.isArray(data?.rows) ? data.rows : [];
            const pages = totalPages(data?.total ?? 0);
            // 目标页越界（例如其它设备删了数据）时回退到最后一页再取一次
            if (targetPage > pages) {
                setPage(pages);
                setRows([]);
                setTotal(0);
                return;
            }
            setRows(list);
            setTotal(Number.isFinite(data?.total) ? data.total! : 0);
            setPage(targetPage);
            setSelected(new Set());
        } catch (e: any) {
            const msg = String(e?.message || "");
            setError(
                msg.includes("401") || msg.includes("登录")
                    ? "请先登录后再查看练习试卷。"
                    : "加载试卷列表失败，请重试。",
            );
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        if (sessionStatus === "loading") return;
        if (sessionStatus === "unauthenticated") {
            setLoading(false);
            setError("请先登录后再查看练习试卷。");
            return;
        }
        void load(1);
    }, [sessionStatus, load]);

    const toggle = (code: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(code)) next.delete(code);
            else next.add(code);
            return next;
        });
    };

    const viewOne = () => {
        if (!canView(selected.size)) return;
        router.push(paperViewHref([...selected][0]));
    };

    /** 点整行进入批改页，查看每道题的对错判定 */
    const openMark = (code: string) => {
        router.push(paperMarkHref(code));
    };

    const doDelete = async () => {
        if (!canDelete(selected.size) || deleting) return;
        // 双保险：即便 UI 状态异常混入了已批改卷，也不把它们发给删除接口
        const codes = deletableCodes(rows).filter((c) => selected.has(c));
        if (!codes.length) {
            setSelected(new Set());
            setConfirmOpen(false);
            return;
        }
        setDeleting(true);
        try {
            await apiClient.post<{ deleted?: number }>("/api/paper/delete", { codes });
            // 删空当前页则回退一页，避免停在空白页
            const nextPage = pageAfterDelete(page, rows.length, codes.length);
            setSelected(new Set());
            setConfirmOpen(false);
            await load(nextPage, true);
        } catch {
            setError("删除失败，请稍后重试。");
            setConfirmOpen(false);
        } finally {
            setDeleting(false);
        }
    };

    const deletable = deletableCodes(rows);
    const allSelected = deletable.length > 0 && deletable.every((c) => selected.has(c));

    const toggleAll = () => {
        if (allSelected) setSelected(new Set());
        else setSelected(new Set(deletable));
    };

    return (
        <div className="min-h-screen bg-slate-50 pb-24">
            {/* 顶栏 */}
            <div className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
                <div className="mx-auto flex max-w-2xl items-center gap-2.5 px-3 py-2.5">
                    <BackButton fallbackUrl="/" />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold leading-tight">练习试卷</div>
                        <div className="text-[11px] leading-tight text-muted-foreground">
                            扫码批卷 · 查看对错 · 试卷归档
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => void load(page, true)}
                        disabled={refreshing}
                        aria-label="刷新列表"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                    >
                        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                    </button>
                </div>
            </div>

            <div className="mx-auto max-w-2xl px-3 py-4">
                {/* 核心入口：扫码批卷（原批改中心移植而来） */}
                <button
                    type="button"
                    onClick={() => setScanning(true)}
                    className="mb-4 flex w-full items-center justify-between rounded-xl bg-primary px-4 py-3.5 text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
                >
                    <span className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/20">
                            <ScanLine className="h-5 w-5" />
                        </span>
                        <span className="text-left">
                            <span className="block text-sm font-bold">扫码批卷</span>
                            <span className="block text-[11px] text-white/80">
                                扫描卷首二维码，直接打开试卷逐题判分
                            </span>
                        </span>
                    </span>
                    <span className="text-xs font-semibold">开始 ›</span>
                </button>

                {/* 操作栏：查看 / 删除 */}
                <div className="mb-3 flex items-center gap-2">
                    <div className="flex-1 text-[11px] text-muted-foreground">
                        {selected.size > 0 ? `已选中 ${selected.size} 份` : "勾选试卷后操作"}
                    </div>
                    <button
                        type="button"
                        onClick={viewOne}
                        disabled={!canView(selected.size)}
                        title={canView(selected.size) ? "查看试卷内容与答案" : "请恰好选中一份试卷"}
                        className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                    >
                        <Eye className="h-4 w-4" />
                        查看
                    </button>
                    <button
                        type="button"
                        onClick={() => setConfirmOpen(true)}
                        disabled={!canDelete(selected.size)}
                        title={canDelete(selected.size) ? "删除选中试卷" : "请先选中试卷"}
                        className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-40"
                    >
                        <Trash2 className="h-4 w-4" />
                        删除
                    </button>
                </div>

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
                            onClick={() => void load(page)}
                            className="rounded-lg border bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
                        >
                            重新加载
                        </button>
                    </div>
                ) : rows.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-16 text-center">
                        <div className="text-4xl">📄</div>
                        <p className="text-sm font-medium">还没有试卷记录</p>
                        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                            从「今日复习」生成卷，或在「错题本」选题导出打印，试卷会自动归档到这里。
                        </p>
                    </div>
                ) : (
                    <div className="space-y-2.5">
                        {/* 全选（仅未批改卷可选） */}
                        {deletable.length > 0 && (
                            <label className="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-muted-foreground">
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    onChange={toggleAll}
                                    className="h-3.5 w-3.5 accent-slate-900"
                                />
                                {allSelected ? "取消全选" : `全选可删除的 ${deletable.length} 份`}
                            </label>
                        )}
                        {deletable.length < rows.length && (
                            <p className="flex items-center gap-1 px-1 text-[10px] text-slate-400">
                                <Lock className="h-3 w-3" />
                                已批改的试卷不可删除（批改明细用于计算熟悉度），点击仍可查看对错
                            </p>
                        )}

                        {rows.map((row) => {
                            const submitted = isSubmitted(row);
                            const checked = selected.has(row.code);
                            return (
                                <div
                                    key={row.code}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => openMark(row.code)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            openMark(row.code);
                                        }
                                    }}
                                    className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-white p-3.5 transition-colors ${
                                        checked ? "border-slate-900/60 bg-slate-50" : "hover:border-slate-300"
                                    }`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={submitted}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={() => toggle(row.code)}
                                        className="mt-1 h-4 w-4 shrink-0 accent-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                                    />
                                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                                        <FileText className="h-5 w-5" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2">
                                            <span className="truncate text-[13px] font-semibold">
                                                卷号 {row.paperNo || row.code.slice(0, 12)}
                                            </span>
                                            {submitted && (
                                                <Lock className="h-3 w-3 shrink-0 text-slate-400" aria-label="已批改，不可删除" />
                                            )}
                                        </span>
                                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                                            {row.subjectNames && <span>{row.subjectNames}</span>}
                                            {row.subjectNames && <span>·</span>}
                                            <span>{row.itemCount} 题</span>
                                            <span>·</span>
                                            <span>{formatPaperTime(row.createdAt)}</span>
                                        </span>
                                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                            {submitted
                                                ? `答对 ${row.correctCount ?? 0}/${row.itemCount} 题 · 点击查看对错`
                                                : "待批改 · 点击批改或查看"}
                                        </span>
                                    </span>
                                    {/* 得分列 */}
                                    <span className="ml-1 shrink-0 text-right">
                                        <span className="block text-[10px] leading-none text-muted-foreground">得分</span>
                                        <span
                                            className={`mt-1 block text-base font-bold leading-none ${
                                                submitted ? "text-emerald-600" : "text-slate-300"
                                            }`}
                                        >
                                            {scoreLabel(row)}
                                        </span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* 分页控件：服务端分页，只取当前页数据 */}
                {!loading && !error && total > 0 && (() => {
                    const pages = totalPages(total);
                    return (
                        <div className="mt-4 flex items-center justify-between gap-2 px-1">
                            <button
                                type="button"
                                onClick={() => void load(page - 1)}
                                disabled={page <= 1}
                                className="flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-xs font-medium text-slate-600 disabled:opacity-40"
                            >
                                <ChevronLeft className="h-4 w-4" />
                                上一页
                            </button>
                            <span className="text-[11px] text-muted-foreground">
                                第 {page} / {pages} 页 · 共 {total} 份
                            </span>
                            <button
                                type="button"
                                onClick={() => void load(page + 1)}
                                disabled={page >= pages}
                                className="flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-xs font-medium text-slate-600 disabled:opacity-40"
                            >
                                下一页
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    );
                })()}
            </div>

            {/* 删除二次确认弹层 */}
            {confirmOpen && (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-5 backdrop-blur-sm">
                    <div className="w-full max-w-xs rounded-2xl bg-white p-6 text-center shadow-2xl">
                        <div className="text-4xl">⚠️</div>
                        <h2 className="mt-2 text-base font-bold text-slate-800">确认删除试卷？</h2>
                        <p className="mt-2 text-xs leading-relaxed text-slate-500">
                            {deleteConfirmText(selected.size)}
                        </p>
                        <button
                            type="button"
                            onClick={() => void doDelete()}
                            disabled={deleting}
                            className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-rose-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                        >
                            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            {deleting ? "删除中…" : `确认删除 ${selected.size} 份`}
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmOpen(false)}
                            disabled={deleting}
                            className="mt-2 w-full py-1.5 text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50"
                        >
                            取消
                        </button>
                    </div>
                </div>
            )}

            {/* 扫码批卷弹层：扫到凭证后进批改页，并标记来源以便返回归档页 */}
            {scanning && (
                <QrScanner
                    onClose={() => setScanning(false)}
                    onResult={(code) => {
                        setScanning(false);
                        router.push(paperMarkHref(code));
                    }}
                />
            )}
        </div>
    );
}
