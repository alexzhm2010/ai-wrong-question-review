"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import { AttemptResult, ErrorItem } from "@/types/api";

const LAST_PRINT_KEY = "wq:last-print";

/** 读出上一次打印的题目 id：优先 URL，其次本地记录 */
function resolveIds(fromUrl: string | null): string[] {
    const parse = (raw: string) =>
        raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (fromUrl) return parse(fromUrl);
    try {
        const saved = JSON.parse(localStorage.getItem(LAST_PRINT_KEY) || "null");
        if (saved && Array.isArray(saved.ids)) return saved.ids.map(String);
    } catch {
        /* 本地记录损坏就当没有 */
    }
    return [];
}

const OPTIONS: Array<{ key: AttemptResult; label: string; hint: string; cls: string; on: string }> = [
    { key: "correct", label: "做对了", hint: "连续答对 +1", cls: "border-green-300 text-green-700", on: "bg-green-600 border-green-600 text-white" },
    { key: "wrong", label: "做错了", hint: "连续答对归零", cls: "border-red-300 text-red-700", on: "bg-red-600 border-red-600 text-white" },
    { key: "skip", label: "没做", hint: "不计对错", cls: "border-slate-300 text-slate-600", on: "bg-slate-700 border-slate-700 text-white" },
];

function GradeContent() {
    const searchParams = useSearchParams();
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [results, setResults] = useState<Record<string, AttemptResult>>({});
    const [cur, setCur] = useState(0);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState<{ correct: number; wrong: number; skip: number } | null>(null);
    const [showAnswer, setShowAnswer] = useState(false);
    const [preFilled, setPreFilled] = useState(0);

    useEffect(() => {
        const ids = resolveIds(searchParams.get("ids"));
        if (!ids.length) {
            setError("没有找到要批改的题目。请先从「打印」页打印一批，或从错题列表进入。");
            setLoading(false);
            return;
        }
        (async () => {
            try {
                const res = await apiClient.get<{ items: ErrorItem[] }>(
                    `/api/error-items/details?ids=${ids.join(",")}`,
                );
                const byId = new Map((res.items || []).map((i) => [i.id, i]));
                // 保持打印时的顺序，缺失的跳过
                const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as ErrorItem[];
                setItems(ordered);
                if (!ordered.length) setError("这批题目已经不在库里了，可能被删除。");

                // 拍照识别结果预填：只认这批里的题，其余一律忽略
                try {
                    const raw = sessionStorage.getItem("wq:scan-results");
                    if (raw) {
                        const arr = JSON.parse(raw) as Array<{ id: string; result: AttemptResult }>;
                        const valid = new Set(ordered.map((i) => i.id));
                        const pre: Record<string, AttemptResult> = {};
                        for (const row of arr) {
                            if (valid.has(row.id) && ["correct", "wrong", "skip"].includes(row.result)) {
                                pre[row.id] = row.result;
                            }
                        }
                        const n = Object.keys(pre).length;
                        if (n) {
                            setResults(pre);
                            setPreFilled(n);
                            const firstUnmarked = ordered.findIndex((i) => !pre[i.id]);
                            if (firstUnmarked > 0) setCur(firstUnmarked);
                        }
                        sessionStorage.removeItem("wq:scan-results");
                    }
                } catch {
                    /* 预填失败不影响手动批改 */
                }
            } catch (e) {
                setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                setLoading(false);
            }
        })();
    }, [searchParams]);

    const current = items[cur];
    const markedCount = Object.keys(results).length;

    const stats = useMemo(() => {
        const s = { correct: 0, wrong: 0, skip: 0 };
        for (const r of Object.values(results)) s[r] += 1;
        return s;
    }, [results]);

    const nextUnmarked = (from: number) => {
        for (let step = 1; step <= items.length; step++) {
            const idx = (from + step) % items.length;
            if (!results[items[idx]?.id]) return idx;
        }
        return Math.min(from + 1, items.length - 1);
    };

    const mark = (result: AttemptResult) => {
        if (!current) return;
        setResults((prev) => ({ ...prev, [current.id]: result }));
        setShowAnswer(false);
        const idx = nextUnmarked(cur);
        if (idx !== cur) setTimeout(() => setCur(idx), 180);
    };

    const save = async () => {
        setSaving(true);
        try {
            const payload = Object.entries(results).map(([id, result]) => ({ id, result }));
            await apiClient.post<{ success: boolean; updated: number }>("/api/error-items/attempt-batch", { items: payload });
            setSaved(stats);
            try { localStorage.removeItem(LAST_PRINT_KEY); } catch { /* 忽略 */ }
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存失败，请重试");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>;
    }

    if (error) {
        return (
            <div className="min-h-screen">
                <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-3 py-2 flex items-center gap-3">
                    <BackButton fallbackUrl="/notebooks" />
                    <span className="font-bold">批改</span>
                </div>
                <div className="max-w-lg mx-auto px-6 py-16 text-center space-y-4">
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <Link href="/print-preview" className="inline-block text-sm text-blue-600 underline">
                        去打印页选题
                    </Link>
                </div>
            </div>
        );
    }

    if (saved) {
        const total = saved.correct + saved.wrong;
        const rate = total ? Math.round((saved.correct / total) * 100) : 0;
        return (
            <div className="min-h-screen">
                <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-3 py-2 flex items-center gap-3">
                    <BackButton fallbackUrl="/notebooks" />
                    <span className="font-bold">批改完成</span>
                </div>
                <div className="max-w-lg mx-auto px-5 py-10 space-y-6">
                    <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-lg border border-green-200 bg-green-50 py-3">
                            <div className="text-2xl font-bold text-green-700">{saved.correct}</div>
                            <div className="text-xs text-green-700/80 mt-0.5">做对</div>
                        </div>
                        <div className="rounded-lg border border-red-200 bg-red-50 py-3">
                            <div className="text-2xl font-bold text-red-700">{saved.wrong}</div>
                            <div className="text-xs text-red-700/80 mt-0.5">做错</div>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 py-3">
                            <div className="text-2xl font-bold text-slate-600">{saved.skip}</div>
                            <div className="text-xs text-slate-500 mt-0.5">没做</div>
                        </div>
                    </div>
                    <p className="text-center text-sm text-muted-foreground">
                        本次正确率 {rate}%（{saved.correct}/{total}）· 已经写回每道题的记录
                    </p>
                    <div className="space-y-2">
                        <Link href="/print-preview" className="block w-full text-center rounded-lg bg-slate-900 text-white py-3 text-sm font-semibold">
                            再打印一批
                        </Link>
                        <Link href="/mastery" className="block w-full text-center rounded-lg border py-3 text-sm">
                            看掌握度变化
                        </Link>
                        <Link href="/notebooks" className="block w-full text-center rounded-lg border py-3 text-sm">
                            返回错题本
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    if (!current) return null;

    const curResult = results[current.id];
    const unanswered = items.length - markedCount;

    return (
        <div className="min-h-screen flex flex-col bg-slate-50">
            {/* 顶栏 */}
            <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b px-3 py-2 flex items-center gap-3 shrink-0">
                <BackButton fallbackUrl="/notebooks" />
                <div className="flex-1 min-w-0">
                    <div className="font-bold leading-tight">批改</div>
                    <div className="text-[11px] text-muted-foreground">
                        {cur + 1} / {items.length} · 已标 {markedCount} 道{unanswered > 0 ? ` · 还剩 ${unanswered}` : " · 可以保存了"}
                        {preFilled > 0 ? ` · 扫描预填 ${preFilled}` : ""}
                    </div>
                </div>
                <Link
                    href={`/scan?ids=${items.map((i) => i.id).join(",")}`}
                    className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs text-blue-700 whitespace-nowrap"
                >
                    拍照识别
                </Link>
            </div>

            <div className="h-0.5 bg-slate-200 shrink-0">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${(markedCount / items.length) * 100}%` }} />
            </div>

            {/* 题目图 */}
            <div className="flex-1 overflow-auto px-2 py-2">
                <div className="max-w-3xl mx-auto">
                    <div className="flex items-center gap-2 mb-1.5 px-1">
                        <span className="font-mono text-[10px] tracking-wider text-slate-400">#{current.shortCode || "—"}</span>
                        <span className="text-xs text-slate-500">
                            错 {current.wrongCount || 0} · 对 {current.correctCount || 0}
                        </span>
                        {curResult && (
                            <span className={`ml-auto text-[11px] font-semibold ${
                                curResult === "correct" ? "text-green-600" : curResult === "wrong" ? "text-red-600" : "text-slate-500"
                            }`}>
                                已标：{curResult === "correct" ? "对" : curResult === "wrong" ? "错" : "没做"}
                            </span>
                        )}
                    </div>
                    {current.originalImageUrl ? (
                        <img
                            src={current.originalImageUrl}
                            alt="题目"
                            className="w-full h-auto rounded-lg border bg-white"
                        />
                    ) : (
                        <div className="rounded-lg border bg-white p-4 text-sm whitespace-pre-wrap">
                            {current.questionText}
                        </div>
                    )}

                    <button
                        onClick={() => setShowAnswer((v) => !v)}
                        className="mt-2 w-full rounded-lg border border-dashed border-slate-300 bg-white py-2 text-xs text-slate-600"
                    >
                        {showAnswer ? "收起答案" : "看答案"}
                    </button>
                    {showAnswer && (
                        <div className="mt-2 rounded-lg border bg-amber-50 p-3 text-sm whitespace-pre-wrap">
                            {current.answerText || "（这道题没有存答案）"}
                        </div>
                    )}
                </div>
            </div>

            {/* 底部操作 */}
            <div className="shrink-0 border-t bg-background px-3 pt-2 pb-[calc(10px+env(safe-area-inset-bottom))]">
                <div className="max-w-3xl mx-auto">
                    <div className="flex gap-2">
                        {OPTIONS.map((o) => (
                            <button
                                key={o.key}
                                onClick={() => mark(o.key)}
                                className={`flex-1 rounded-xl border py-3 text-sm font-semibold transition ${
                                    curResult === o.key ? o.on : `bg-white ${o.cls}`
                                }`}
                            >
                                {o.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                        <button
                            onClick={() => setCur((v) => Math.max(0, v - 1))}
                            disabled={cur === 0}
                            className="flex-1 rounded-lg border py-2 text-xs text-slate-600 disabled:opacity-40"
                        >
                            ‹ 上一题
                        </button>
                        <button
                            onClick={() => setCur((v) => Math.min(items.length - 1, v + 1))}
                            disabled={cur === items.length - 1}
                            className="flex-1 rounded-lg border py-2 text-xs text-slate-600 disabled:opacity-40"
                        >
                            下一题 ›
                        </button>
                        <button
                            onClick={save}
                            disabled={markedCount === 0 || saving}
                            className="flex-[1.4] rounded-lg bg-slate-900 text-white py-2 text-xs font-semibold disabled:opacity-40"
                        >
                            {saving ? "保存中…" : `保存 ${markedCount} 道`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function GradePage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>}>
            <GradeContent />
        </Suspense>
    );
}
