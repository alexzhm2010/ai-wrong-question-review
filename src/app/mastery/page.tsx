"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import {
    BAND_META,
    BAND_ORDER,
    MasteryBand,
    bandOf,
    isArchived,
    knowledgeNames,
    summarizeMastery,
    tagMastery,
} from "@/lib/mastery";

/** 题干去掉公式标记，只留能认出是哪道题的文字 */
function brief(text?: string | null, len = 46): string {
    const s = (text || "")
        .replace(/\$[^$]*\$/g, " ")
        .replace(/\\[a-zA-Z]+/g, " ")
        .replace(/[{}$\\^_]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return s.length > len ? `${s.slice(0, len)}…` : s;
}

function relDays(iso?: string | null): string {
    if (!iso) return "没做过";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    const d = Math.floor((Date.now() - t) / 86_400_000);
    if (d <= 0) return "今天";
    if (d === 1) return "昨天";
    if (d < 30) return `${d} 天前`;
    return `${Math.floor(d / 30)} 个月前`;
}

export default function MasteryPage() {
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [band, setBand] = useState<MasteryBand | null>(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState("");

    useEffect(() => {
        (async () => {
            try {
                const res = await apiClient.get<PaginatedResponse<ErrorItem>>(
                    "/api/error-items/list?pageSize=1000",
                );
                setItems(res.items || []);
            } catch {
                setError("读取失败，请检查网络后重试");
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const summary = useMemo(() => summarizeMastery(items), [items]);
    const tags = useMemo(() => tagMastery(items as any), [items]);

    /** 首次载入后落到「有内容且最该看」的那一档：待攻克优先，其次未开始 */
    const pickedDefault = useRef(false);
    useEffect(() => {
        if (pickedDefault.current || loading) return;
        pickedDefault.current = true;
        setBand(summary.bands.weak > 0 ? "weak" : summary.bands.new > 0 ? "new" : null);
    }, [loading, summary]);

    const list = useMemo(() => {
        if (!band) return [];
        return items
            .filter((i) => !isArchived(i) && bandOf(i) === band)
            .sort(
                (a, b) =>
                    (b.wrongCount || 0) - (a.wrongCount || 0) ||
                    Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "") ||
                    0,
            );
    }, [items, band]);

    const archiveMastered = async () => {
        const ids = items.filter((i) => !isArchived(i) && bandOf(i) === "mastered").map((i) => i.id);
        if (!ids.length) return;
        if (!confirm(`把这 ${ids.length} 道连续答对 2 次以上的题归档？\n归档后不再进日常复习和今日卷，随时可以取消归档。`)) return;
        setBusy(true);
        try {
            await apiClient.post("/api/error-items/archive", { ids, archived: true });
            const set = new Set(ids);
            setItems((prev) => prev.map((i) => (set.has(i.id) ? { ...i, masteryLevel: 3 } : i)));
            setToast(`已归档 ${ids.length} 道`);
        } catch {
            setToast("归档失败，请重试");
        } finally {
            setBusy(false);
            setTimeout(() => setToast(""), 2600);
        }
    };

    const unarchiveAll = async () => {
        const ids = items.filter((i) => isArchived(i)).map((i) => i.id);
        if (!ids.length) return;
        setBusy(true);
        try {
            await apiClient.post("/api/error-items/archive", { ids, archived: false });
            const set = new Set(ids);
            setItems((prev) => prev.map((i) => (set.has(i.id) ? { ...i, masteryLevel: 0 } : i)));
            setToast(`已取消归档 ${ids.length} 道`);
        } catch {
            setToast("操作失败，请重试");
        } finally {
            setBusy(false);
            setTimeout(() => setToast(""), 2600);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground text-sm">正在算掌握度…</p>
            </div>
        );
    }

    const ratePct = Math.round(summary.masteryRate * 100);
    const activeTotal = summary.total - summary.archived;

    return (
        <div className="min-h-screen bg-slate-50/60 pb-16">
            <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b">
                <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
                    <BackButton fallbackUrl="/stats" />
                    <div className="flex-1 min-w-0">
                        <h1 className="text-base sm:text-lg font-bold leading-tight">掌握度</h1>
                        <p className="text-[11px] text-muted-foreground">
                            {activeTotal} 道在册 · 归档 {summary.archived} 道 · 平均每题错 {summary.avgWrong.toFixed(1)} 次
                        </p>
                    </div>
                    <Link
                        href="/review"
                        className="shrink-0 rounded-md bg-slate-900 text-white px-3 py-1.5 text-xs font-medium"
                    >
                        今日卷
                    </Link>
                </div>
            </div>

            <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
                {error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
                )}

                {/* 一道题都没批改过时，别让用户对着一屏 0 发呆 */}
                {summary.total > 0 && summary.bands.new === summary.total && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900 flex items-center gap-2">
                        <span className="flex-1 leading-relaxed">
                            这 {summary.total} 道题还没有作答记录，所以每个数字都是 0。
                            打印一份卷子、做完拍照批改，这里就会开始有变化。
                        </span>
                        <Link
                            href="/review"
                            className="shrink-0 rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white"
                        >
                            去今日卷
                        </Link>
                    </div>
                )}

                {/* 掌握率 + 四档 */}
                <div className="rounded-xl border bg-white p-4">
                    <div className="flex items-end gap-3">
                        <div>
                            <div className="text-3xl font-bold leading-none tabular-nums">{ratePct}%</div>
                            <div className="text-[11px] text-muted-foreground mt-1">
                                已学过题目的掌握率（连续对 ≥2 才算掌握）
                            </div>
                        </div>
                        <button
                            onClick={archiveMastered}
                            disabled={busy || summary.bands.mastered === 0}
                            className="ml-auto shrink-0 rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5 text-xs text-green-700 disabled:opacity-40"
                        >
                            归档已掌握 {summary.bands.mastered} 道
                        </button>
                    </div>

                    <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                        {BAND_ORDER.map((b) => {
                            const n = summary.bands[b];
                            const pct = activeTotal > 0 ? (n / activeTotal) * 100 : 0;
                            if (pct <= 0) return null;
                            return (
                                <div
                                    key={b}
                                    style={{ width: `${pct}%`, backgroundColor: BAND_META[b].color }}
                                    title={`${BAND_META[b].label} ${n} 道`}
                                />
                            );
                        })}
                    </div>

                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {BAND_ORDER.map((b) => {
                            const on = band === b;
                            const n = summary.bands[b];
                            return (
                                <button
                                    key={b}
                                    onClick={() => setBand(on ? null : b)}
                                    className={`rounded-lg border px-2.5 py-2 text-left transition ${
                                        on ? "ring-2 ring-slate-900 ring-offset-1" : ""
                                    } ${BAND_META[b].ring}`}
                                >
                                    <div className="text-lg font-bold leading-none tabular-nums">{n}</div>
                                    <div className="text-[11px] mt-1 font-medium">{BAND_META[b].label}</div>
                                    <div className="text-[10px] opacity-70 leading-tight mt-0.5">{BAND_META[b].hint}</div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 知识点掌握率：只列最薄弱的 8 个 */}
                {tags.length > 0 && (
                    <div className="rounded-xl border bg-white p-4">
                        <div className="flex items-baseline gap-2 mb-3">
                            <h2 className="text-sm font-bold">最薄弱的知识点</h2>
                            <span className="text-[11px] text-muted-foreground">至少 2 道题才会统计</span>
                        </div>
                        <div className="space-y-2">
                            {tags.slice(0, 8).map((t) => (
                                <Link
                                    key={t.name}
                                    href={`/print-preview?tag=${encodeURIComponent(t.name)}`}
                                    className="block group"
                                >
                                    <div className="flex items-center justify-between text-xs mb-1">
                                        <span className="truncate pr-2 group-hover:underline">{t.name}</span>
                                        <span className="shrink-0 tabular-nums text-muted-foreground">
                                            {t.mastered}/{t.total} · {Math.round(t.rate * 100)}%
                                        </span>
                                    </div>
                                    <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
                                        <div
                                            className="h-full rounded-full"
                                            style={{
                                                width: `${Math.max(2, Math.round(t.rate * 100))}%`,
                                                // 一道都没掌握时用灰色：0% 是自己还没练，不是「红色警报」
                                                backgroundColor:
                                                    t.mastered === 0
                                                        ? "#cbd5e1"
                                                        : t.rate >= 0.7
                                                          ? "#16a34a"
                                                          : t.rate >= 0.4
                                                            ? "#f59e0b"
                                                            : "#dc2626",
                                            }}
                                        />
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}

                {/* 分档题目清单 */}
                <div className="rounded-xl border bg-white overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b">
                        <h2 className="text-sm font-bold">
                            {band ? BAND_META[band].label : "全部题目"}
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">{list.length} 道</span>
                        </h2>
                        {band === "weak" && list.length > 0 && (
                            <Link
                                href="/review"
                                className="ml-auto rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600"
                            >
                                去今日卷
                            </Link>
                        )}
                    </div>

                    {!band && (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                            点上面的某一档查看题目
                        </div>
                    )}
                    {band && list.length === 0 && (
                        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                            {band === "mastered" ? "还没有连续答对 2 次的题，继续做几轮就有了" : "这一档没有题目"}
                        </div>
                    )}

                    <div className="divide-y">
                        {list.slice(0, 40).map((item, i) => {
                            const names = knowledgeNames(item as any);
                            return (
                                <Link
                                    key={item.id}
                                    href={`/item/${item.id}`}
                                    className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50"
                                >
                                    <span className="w-6 shrink-0 text-[11px] text-slate-400 tabular-nums pt-0.5">{i + 1}</span>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs leading-relaxed line-clamp-2">{brief(item.questionText || item.ocrText) || "（无题干文字）"}</p>
                                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-400">
                                            <span className="text-red-500">错 {item.wrongCount || 0}</span>
                                            <span className="text-green-600">对 {item.correctCount || 0}</span>
                                            {Number(item.correctStreak || 0) > 0 && (
                                                <span className="text-blue-600">连续 {item.correctStreak}</span>
                                            )}
                                            <span>· {relDays(item.lastAttemptAt)}</span>
                                            {names[0] && <span className="truncate">· {names[0]}</span>}
                                        </div>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                    {list.length > 40 && (
                        <div className="px-4 py-2 text-center text-[11px] text-muted-foreground">
                            仅显示前 40 道，完整清单去错题本按条件筛选
                        </div>
                    )}
                </div>

                {summary.archived > 0 && (
                    <button
                        onClick={unarchiveAll}
                        disabled={busy}
                        className="w-full rounded-lg border border-slate-200 bg-white py-2 text-xs text-slate-500 disabled:opacity-40"
                    >
                        取消归档全部 {summary.archived} 道
                    </button>
                )}
            </div>

            {toast && (
                <div className="fixed left-1/2 bottom-6 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-xs text-white shadow-lg">
                    {toast}
                </div>
            )}
        </div>
    );
}
