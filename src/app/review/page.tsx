"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { AutoCropImage } from "@/components/auto-crop-image";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { estimateMinutes, pickReview } from "@/lib/review-plan";
import { knowledgeNames } from "@/lib/mastery";
import { imageSrc } from "@/lib/storage";

const SIZE_KEY = "wq:review-size";
const PAPER_KEY = "wq:today-paper";

const SIZES = [6, 12, 20];

function todayKey(): string {
    const d = new Date();
    // 用本地日期，别用 toISOString（那是 UTC，晚上会串到第二天）
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function brief(text?: string | null, len = 54): string {
    const s = (text || "")
        .replace(/\$[^$]*\$/g, " ")
        .replace(/\\[a-zA-Z]+/g, " ")
        .replace(/[{}$\\^_]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return s.length > len ? `${s.slice(0, len)}…` : s;
}

export default function ReviewPage() {
    const router = useRouter();
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [size, setSize] = useState(12);
    const [seed, setSeed] = useState(0);
    const [doneToday, setDoneToday] = useState<string[] | null>(null);
    const [generating, setGenerating] = useState(false);

    useEffect(() => {
        try {
            const s = Number(localStorage.getItem(SIZE_KEY));
            if (SIZES.includes(s)) setSize(s);
            const paper = JSON.parse(localStorage.getItem(PAPER_KEY) || "null");
            if (paper?.date === todayKey() && Array.isArray(paper.ids)) setDoneToday(paper.ids);
        } catch {
            /* 隐私模式读不到就用默认 */
        }
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const res = await apiClient.get<PaginatedResponse<ErrorItem>>(
                    "/api/error-items/list?pageSize=1000",
                );
                setItems(res.items || []);
            } catch {
                setError("读取错题失败，请检查网络后重试");
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const picks = useMemo(() => pickReview(items as any, size, { seed }), [items, size, seed]);

    /** 缩略图：按 8 张一片补，加载失败就留文字版，不影响挑题 */
    useEffect(() => {
        if (loading || !picks.length) return;
        let cancelled = false;
        const ids = picks.map((p) => p.item.id);
        (async () => {
            for (let i = 0; i < ids.length; i += 8) {
                const chunk = ids.slice(i, i + 8);
                try {
                    const res = await apiClient.get<{ images: Array<{ id: string; originalImageUrl: string }> }>(
                        `/api/error-items/images?ids=${chunk.join(",")}`,
                    );
                    if (cancelled) return;
                    const byId = new Map((res.images || []).map((x) => [x.id, x.originalImageUrl]));
                    if (byId.size) {
                        setItems((prev) =>
                            prev.map((it) => (byId.has(it.id) ? { ...it, originalImageUrl: byId.get(it.id) } : it)),
                        );
                    }
                } catch {
                    /* 单片失败跳过 */
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loading, picks.map((p) => p.item.id).join(",")]);

    const changeSize = (n: number) => {
        setSize(n);
        try {
            localStorage.setItem(SIZE_KEY, String(n));
        } catch {
            /* 忽略 */
        }
    };

    const startPaper = () => {
        const ids = picks.map((p) => p.item.id);
        if (!ids.length) return;
        setGenerating(true);
        try {
            const payload = JSON.stringify({ date: todayKey(), ids, at: Date.now() });
            localStorage.setItem(PAPER_KEY, payload);
            localStorage.setItem("wq:last-print", JSON.stringify({ ids, at: Date.now() }));
        } catch {
            /* 写不进也能继续，打印页只是需要重新选 */
        }
        router.push(`/print-preview?ids=${ids.join(",")}`);
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground text-sm">正在排今天的卷子…</p>
            </div>
        );
    }

    const minutes = estimateMinutes(picks.length);
    // 一条作答记录都没有时，推荐理由只有「入库 X 天」，得跟用户说清楚这是暂时的
    const hasAttempts = items.some(
        (i) => (Number(i.wrongCount) || 0) + (Number(i.correctCount) || 0) > 0,
    );

    return (
        <div className="min-h-screen bg-slate-50/60 pb-28">
            <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b">
                <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
                    <BackButton fallbackUrl="/" />
                    <div className="flex-1 min-w-0">
                        <h1 className="text-base sm:text-lg font-bold leading-tight">今日复习卷</h1>
                        <p className="text-[11px] text-muted-foreground">
                            {picks.length} 道 · 约 {minutes} 分钟 · 按「错得多、放得久」挑的
                        </p>
                    </div>
                    <button
                        onClick={() => setSeed((s) => s + 1)}
                        className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600"
                    >
                        换一批
                    </button>
                </div>
            </div>

            <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
                {error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
                )}

                {doneToday && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-800 flex items-center gap-2">
                        <span>今天已经生成过一份 {doneToday.length} 道的卷子。</span>
                        <Link href={`/print-preview?ids=${doneToday.join(",")}`} className="underline font-medium">
                            继续打印那份
                        </Link>
                    </div>
                )}

                {!hasAttempts && picks.length > 0 && (
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                        还没有作答记录，现在按「入库时间」挑的是新题。做过几轮、在批改页标过对错之后，
                        这里会优先挑你真正没掌握的那几道。
                    </div>
                )}

                <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground mr-1">题量</span>
                    {SIZES.map((n) => (
                        <button
                            key={n}
                            onClick={() => changeSize(n)}
                            className={`rounded-full border px-3 py-1 transition ${
                                size === n
                                    ? "bg-slate-900 border-slate-900 text-white font-semibold"
                                    : "border-slate-200 bg-white text-slate-600"
                            }`}
                        >
                            {n} 道
                        </button>
                    ))}
                    <Link href="/mastery" className="ml-auto text-[11px] text-slate-500 underline">
                        看掌握度
                    </Link>
                </div>

                {picks.length === 0 ? (
                    <div className="rounded-xl border bg-white px-4 py-12 text-center">
                        <p className="text-sm text-slate-600">题库里还没有可复习的题</p>
                        <Link href="/notebook/add" className="mt-3 inline-block text-xs text-blue-600 underline">
                            去录入第一道错题
                        </Link>
                    </div>
                ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                        {picks.map((p, i) => {
                            const item = p.item as ErrorItem;
                            const names = knowledgeNames(item as any);
                            return (
                                <Link
                                    key={item.id}
                                    href={`/item/${item.id}`}
                                    className="flex gap-2.5 rounded-xl border bg-white p-2.5 hover:border-slate-300"
                                >
                                    <div className="w-20 h-24 shrink-0 rounded-lg bg-slate-100 overflow-hidden relative">
                                        {item.originalImageUrl ? (
                                            <AutoCropImage
                                                src={imageSrc(item.originalImageUrl)}
                                                maxWidth={200}
                                                enabled
                                                alt=""
                                                loading="lazy"
                                                className="w-full h-full object-contain bg-white"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-400 px-1 text-center">
                                                无图
                                            </div>
                                        )}
                                        <span className="absolute left-1 top-1 rounded bg-slate-900/80 px-1 py-0.5 text-[10px] font-bold text-white leading-none">
                                            {i + 1}
                                        </span>
                                    </div>
                                    <div className="min-w-0 flex-1 py-0.5">
                                        <p className="text-xs leading-relaxed line-clamp-3">
                                            {brief(item.questionText || item.ocrText) || "（无题干文字）"}
                                        </p>
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
                                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700 border border-amber-200">
                                                {p.reason}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
                                            <span className="text-red-500">错 {item.wrongCount || 0}</span>
                                            <span className="text-green-600">对 {item.correctCount || 0}</span>
                                            {names[0] && <span className="truncate">· {names[0]}</span>}
                                        </div>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 底部主操作：固定在拇指能碰到的地方 */}
            {picks.length > 0 && (
                <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-white/95 backdrop-blur px-4 py-3">
                    <div className="max-w-3xl mx-auto flex items-center gap-3">
                        <div className="min-w-0 text-[11px] text-muted-foreground leading-tight">
                            <div className="font-medium text-slate-700">{picks.length} 道 · 约 {minutes} 分钟</div>
                            <div>生成后可打印，做完拍照批改</div>
                        </div>
                        <button
                            onClick={startPaper}
                            disabled={generating}
                            className="ml-auto shrink-0 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                        >
                            {generating ? "正在生成…" : "生成今日卷"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
