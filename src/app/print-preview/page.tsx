"use client";

import { useCallback, useEffect, useMemo, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ReferenceAnswer } from "@/components/reference-answer";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import { getSelectedPrintItems } from "@/lib/print-preview";
import { AutoCropImage } from "@/components/auto-crop-image";
import { autoCrop } from "@/lib/image-autocrop";

type FilterKey = "all" | "w2" | "w3" | "never" | "streak";
type SpaceKey = "none" | "sm" | "md" | "lg";

const SPACE_CM: Record<SpaceKey, number> = { none: 0, sm: 4, md: 6, lg: 9 };

const FILTERS: Array<{ key: FilterKey; label: string; test: (i: ErrorItem) => boolean }> = [
    { key: "all", label: "全部", test: () => true },
    { key: "w2", label: "错 2 次以上", test: (i) => (i.wrongCount || 0) >= 2 },
    { key: "w3", label: "错 3 次以上", test: (i) => (i.wrongCount || 0) >= 3 },
    { key: "never", label: "从没做对", test: (i) => (i.correctCount || 0) === 0 },
    { key: "streak", label: "连续对 ≥2", test: (i) => (i.correctStreak || 0) >= 2 },
];

function PrintPreviewContent() {
    const searchParams = useSearchParams();
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAnswers, setShowAnswers] = useState(false);
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [showTags, setShowTags] = useState(false);
    const [imageScale, setImageScale] = useState(60);
    const [showQuestionText, setShowQuestionText] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState<FilterKey>("all");
    const [space, setSpace] = useState<SpaceKey>("sm");
    const [previewAt, setPreviewAt] = useState<number | null>(null);
    const [imageProgress, setImageProgress] = useState({ loaded: 0, total: 0 });
    const [autoCropOn, setAutoCropOn] = useState(true);
    const [cropSum, setCropSum] = useState({ count: 0, saved: 0 });
    const [printCrops, setPrintCrops] = useState<Record<string, string>>({});
    const [preparing, setPreparing] = useState(false);
    const imageLoadStarted = useRef(false);

    useEffect(() => {
        try {
            const saved = localStorage.getItem("wq:autocrop");
            if (saved === "0") setAutoCropOn(false);
        } catch {
            /* 隐私模式读不到就用默认值 */
        }
    }, []);

    const toggleAutoCrop = (next: boolean) => {
        setAutoCropOn(next);
        setCropSum({ count: 0, saved: 0 });
        try {
            localStorage.setItem("wq:autocrop", next ? "1" : "0");
        } catch {
            /* 写不进去不影响本次使用 */
        }
    };

    const onCropDone = useCallback((saved: number) => {
        if (saved <= 0) return;
        setCropSum((s) => ({ count: s.count + 1, saved: s.saved + saved }));
    }, []);

    useEffect(() => {
        fetchItems();
    }, []);

    const fetchItems = async () => {
        try {
            const params = new URLSearchParams(searchParams.toString());
            params.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
            const response = await apiClient.get<PaginatedResponse<ErrorItem>>(
                `/api/error-items/list?${params.toString()}`,
            );
            // 带 ids 进来（今日卷 / 指定必刷）时按传入顺序排，卷子顺序就是推荐顺序
            const wanted = (searchParams.get("ids") || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            let list = response.items;
            if (wanted.length) {
                const rank = new Map(wanted.map((id, i) => [id, i]));
                list = list
                    .filter((i) => rank.has(i.id))
                    .sort((a, b) => (rank.get(a.id) || 0) - (rank.get(b.id) || 0));
            }
            setItems(list);
            setSelectedIds(new Set(list.map((item) => item.id)));
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    /** 文本就绪后按片补图：4 片并发，缩略图墙与打印区共用同一份数据 */
    useEffect(() => {
        if (loading || imageLoadStarted.current || items.length === 0) return;
        imageLoadStarted.current = true;
        let cancelled = false;
        const ids = items.map((item) => item.id);
        const BATCH = 8;
        const CONCURRENCY = 4;
        const chunks: string[][] = [];
        for (let i = 0; i < ids.length; i += BATCH) chunks.push(ids.slice(i, i + BATCH));
        let cursor = 0;
        let loaded = 0;
        setImageProgress({ loaded: 0, total: ids.length });
        (async () => {
            const worker = async () => {
                while (!cancelled) {
                    const idx = cursor++;
                    if (idx >= chunks.length) return;
                    const chunk = chunks[idx];
                    try {
                        const res = await apiClient.get<{ images: Array<{ id: string; originalImageUrl: string }> }>(
                            `/api/error-items/images?ids=${chunk.join(",")}`,
                        );
                        const byId = new Map((res.images || []).map((x) => [x.id, x.originalImageUrl]));
                        if (!cancelled && byId.size) {
                            setItems((prev) =>
                                prev.map((it) =>
                                    byId.has(it.id) ? { ...it, originalImageUrl: byId.get(it.id) } : it,
                                ),
                            );
                        }
                    } catch {
                        /* 单片失败不影响其余 */
                    }
                    if (!cancelled) {
                        loaded += chunk.length;
                        setImageProgress({ loaded: Math.min(loaded, ids.length), total: ids.length });
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()));
        })();
        return () => { cancelled = true; };
    }, [loading, items.length]);

    const visibleItems = useMemo(() => {
        const test = FILTERS.find((f) => f.key === filter)!.test;
        return items
            .filter(test)
            .slice()
            .sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0)
                || (a.correctCount || 0) - (b.correctCount || 0));
    }, [items, filter]);

    const selectedItems = getSelectedPrintItems(items, selectedIds);
    const selectedKey = selectedItems.map((i) => i.id).join(",");
    /**
     * 图片是分批补进来的，selectedKey 在补图前后都一样，
     * 所以这里要单独盯着「哪些题已经有图了」，否则第一轮跑完就再也不跑了。
     */
    const imageKey = items
        .map((i) => (i.originalImageUrl ? `${i.id}:${i.originalImageUrl.length}` : ""))
        .filter(Boolean)
        .join(",");
    const reserveSpace = !showAnswers && !showAnalysis;

    /**
     * 打印区的高清裁边图：选中后就在后台一张张算，进打印对话框前已经备好，
     * 用户看到的排版就是印出来的排版。每次只算一张并让出主线程，页面不会卡。
     */
    const cropJobs = useRef<Set<string>>(new Set());
    const cropInflight = useRef<Set<string>>(new Set());
    useEffect(() => {
        if (!autoCropOn || !selectedKey) return;
        let cancelled = false;
        const byId = new Map(items.map((i) => [i.id, i]));
        const queue = selectedKey.split(",").slice(0, 80);
        (async () => {
            for (const id of queue) {
                if (cancelled) return;
                const item = byId.get(id);
                const url = item?.originalImageUrl;
                if (!url || cropJobs.current.has(id) || cropInflight.current.has(id)) continue;
                cropInflight.current.add(id);
                const res = await autoCrop(url, 1200).catch(() => null);
                cropInflight.current.delete(id);
                if (!res) continue;
                if (res.changed) {
                    cropJobs.current.add(id);
                    setPrintCrops((prev) => ({ ...prev, [id]: res.url }));
                }
                await new Promise<void>((r) => setTimeout(r, 0));
            }
        })();
        return () => {
            cancelled = true;
        };
        // items 每次补图都会变，但这里只关心「有没有图、图换没换」
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedKey, autoCropOn, imageKey]);

    const toggle = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const toggleAt = (index: number) => {
        const item = visibleItems[index];
        if (item) toggle(item.id);
    };

    /**
     * 打印的同时把这批题目记到本地：用户做完卷子回来点「批改」，
     * 不用再从列表里一道道挑，直接就是刚才打印的这一批。
     */
    const handlePrint = async () => {
        try {
            localStorage.setItem(
                "wq:last-print",
                JSON.stringify({ ids: selectedItems.map((i) => i.id), at: Date.now() }),
            );
        } catch {
            /* 隐私模式下写不进去，不影响打印 */
        }

        /**
         * 打印前把这一批题的高清裁边图算好再进打印对话框。
         * 不放任 <img> 自己裁，是因为打印区默认全选会有七八十张，
         * 每张 1200px 重编码会白烧内存；只在真正要印的时候算这一次。
         */
        if (autoCropOn && selectedItems.length) {
            setPreparing(true);
            const targets = selectedItems.filter((i) => i.originalImageUrl).slice(0, 60);
            try {
                const results = await Promise.all(
                    targets.map((i) =>
                        autoCrop(i.originalImageUrl as string, 1200)
                            .then((r) => [i.id, r.changed ? r.url : ""] as const)
                            .catch(() => [i.id, ""] as const),
                    ),
                );
                const map: Record<string, string> = {};
                for (const [id, url] of results) if (url) map[id] = url;
                setPrintCrops(map);
                // 等 React 把新图刷进 DOM，否则打印出来还是原图
                await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
            } finally {
                setPreparing(false);
            }
        }
        window.print();
    };

    const previewItem = previewAt === null ? null : visibleItems[previewAt];

    useEffect(() => {
        if (previewAt === null) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setPreviewAt(null);
            if (e.key === "ArrowLeft") setPreviewAt((v) => (v === null ? v : Math.max(0, v - 1)));
            if (e.key === "ArrowRight")
                setPreviewAt((v) => (v === null ? v : Math.min(visibleItems.length - 1, v + 1)));
            if (e.key === " ") {
                e.preventDefault();
                if (previewAt !== null) toggleAt(previewAt);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [previewAt, visibleItems]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">加载中…</p>
            </div>
        );
    }

    return (
        <>
            {/* 控制区：打印时整体隐藏 */}
            <div className="print:hidden sticky top-0 z-20 bg-background/95 backdrop-blur border-b">
                <div className="max-w-6xl mx-auto px-3 sm:px-4 pt-3 pb-2 space-y-2">
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <div className="flex-1 min-w-0">
                            <div className="text-base sm:text-lg font-bold leading-tight">选择要打印的错题</div>
                            <div className="text-[11px] text-muted-foreground">
                                共 {visibleItems.length} 道 · 已选 {selectedItems.length} 道
                                {imageProgress.total > 0 && imageProgress.loaded < imageProgress.total
                                    ? ` · 图片 ${imageProgress.loaded}/${imageProgress.total}`
                                    : ""}
                                {cropSum.count > 0
                                    ? ` · 已裁边 ${cropSum.count} 张，省 ${Math.round((cropSum.saved / cropSum.count) * 100)}% 空白`
                                    : ""}
                            </div>
                        </div>
                        <Link
                            href="/review"
                            className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 whitespace-nowrap"
                        >
                            今日卷
                        </Link>
                        <Link
                            href={
                                selectedItems.length
                                    ? `/grade?ids=${selectedItems.map((i) => i.id).join(",")}`
                                    : "/grade"
                            }
                            className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 whitespace-nowrap"
                        >
                            批改
                        </Link>
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap" disabled={selectedItems.length === 0 || preparing}>
                            {preparing ? "准备图片…" : "打印 / PDF"}
                        </Button>
                    </div>

                    {/* 筛选 */}
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {FILTERS.map((f) => (
                            <button
                                key={f.key}
                                onClick={() => setFilter(f.key)}
                                className={`shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${
                                    filter === f.key
                                        ? f.key === "w2" || f.key === "w3"
                                            ? "bg-red-600 border-red-600 text-white font-semibold"
                                            : "bg-slate-900 border-slate-900 text-white font-semibold"
                                        : f.key === "w2" || f.key === "w3"
                                            ? "border-red-200 bg-red-50 text-red-700"
                                            : "border-slate-200 bg-white text-slate-600"
                                }`}
                            >
                                {f.label}
                            </button>
                        ))}
                        <span className="w-px shrink-0 bg-border mx-1" />
                        <button
                            onClick={() => setSelectedIds(new Set([...selectedIds, ...visibleItems.map((i) => i.id)]))}
                            className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600"
                        >
                            全选当前
                        </button>
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600"
                        >
                            清空
                        </button>
                    </div>

                    {/* 缩略图墙：限高滚动，否则 80 道题会把整页撑开、打印预览被挤没 */}
                    <div className="max-h-[52vh] overflow-y-auto overscroll-contain rounded-md border bg-white p-1.5">
                        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-6">
                            {visibleItems.map((item, index) => {
                                const on = selectedIds.has(item.id);
                                const wc = item.wrongCount || 0;
                                const cc = item.correctCount || 0;
                                const practiced = wc + cc > 0;
                                const tone = wc >= 3 ? "bg-red-100 text-red-700" : wc === 2 ? "bg-orange-100 text-orange-700" : "bg-white/90 text-slate-500";
                                const brief = (item.questionText || "")
                                    .replace(/\$[^$]*\$/g, " ")
                                    .replace(/\\[a-zA-Z]+/g, " ")
                                    .replace(/[{}$\\^_]/g, " ")
                                    .replace(/\s+/g, " ")
                                    .trim();
                                return (
                                    <div
                                        key={item.id}
                                        className={`relative h-28 sm:h-32 rounded-md overflow-hidden bg-slate-100 cursor-pointer transition ${
                                            on ? "ring-2 ring-blue-600 ring-offset-1" : "ring-1 ring-slate-200"
                                        }`}
                                        onClick={() => setPreviewAt(index)}
                                    >
                                        {item.originalImageUrl ? (
                                            <AutoCropImage
                                                src={item.originalImageUrl}
                                                maxWidth={420}
                                                enabled={autoCropOn}
                                                onCrop={onCropDone}
                                                alt=""
                                                loading="lazy"
                                                className={`w-full h-full object-contain bg-white transition-opacity ${on ? "opacity-80" : ""}`}
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-[10px] text-slate-400 p-1 text-center line-clamp-4">
                                                {brief.slice(0, 40) || "无图"}
                                            </div>
                                        )}

                                        {/* 题干摘要：整页截图缩略后认不出题，靠这行兜住 */}
                                        {brief && (
                                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/40 to-transparent px-1.5 pt-4 pb-1">
                                                <p className="text-[10px] leading-tight text-white line-clamp-1">{brief}</p>
                                            </div>
                                        )}

                                        <button
                                            aria-label={on ? "取消选择" : "选择"}
                                            onClick={(e) => { e.stopPropagation(); toggle(item.id); }}
                                            className={`absolute right-1 top-1 w-6 h-6 rounded-full flex items-center justify-center shadow-sm transition ${
                                                on ? "bg-blue-600 border-blue-600" : "bg-white/90 border border-slate-400"
                                            }`}
                                        >
                                            <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 ${on ? "opacity-100" : "opacity-0"}`}
                                                fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        </button>

                                        {practiced && (
                                            <span className={`absolute left-1 top-1 rounded px-1 py-0.5 text-[10px] font-bold leading-none shadow-sm ${tone}`}>
                                                错{wc}·对{cc}
                                            </span>
                                        )}
                                        {!practiced && (
                                            <span className="absolute left-1 top-1 rounded bg-white/85 px-1 py-0.5 text-[10px] leading-none text-slate-500 shadow-sm">
                                                未练
                                            </span>
                                        )}
                                    </div>
                                );
                            })}
                            {visibleItems.length === 0 && (
                                <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
                                    这个条件下没有题目
                                </div>
                            )}
                        </div>
                    </div>

                    {/* 排版选项 */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5 text-xs">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={showQuestionText} onChange={(e) => setShowQuestionText(e.target.checked)}
                                className="rounded border-gray-300 accent-blue-600" />
                            用文字（默认用原图）
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer" title="去掉手机状态栏与四周白边，题会印得更大更清楚">
                            <input type="checkbox" checked={autoCropOn} onChange={(e) => toggleAutoCrop(e.target.checked)}
                                className="rounded border-gray-300 accent-blue-600" />
                            自动裁边
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)}
                                className="rounded border-gray-300 accent-blue-600" />
                            附答案（放卷末）
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={showAnalysis} onChange={(e) => setShowAnalysis(e.target.checked)}
                                className="rounded border-gray-300 accent-blue-600" />
                            附解析
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={showTags} onChange={(e) => setShowTags(e.target.checked)}
                                className="rounded border-gray-300 accent-blue-600" />
                            知识点
                        </label>
                        <span className="flex items-center gap-1.5">
                            作答区
                            <select
                                value={space}
                                onChange={(e) => setSpace(e.target.value as SpaceKey)}
                                className="rounded border border-slate-200 bg-white px-1.5 py-0.5"
                            >
                                <option value="none">不留</option>
                                <option value="sm">小 4cm</option>
                                <option value="md">中 6cm</option>
                                <option value="lg">大 9cm</option>
                            </select>
                        </span>
                        <span className="flex items-center gap-1.5">
                            图宽
                            <input type="range" min={30} max={100} value={imageScale}
                                onChange={(e) => setImageScale(Number(e.target.value))}
                                className="w-16 accent-blue-600" />
                            {imageScale}%
                        </span>
                    </div>
                </div>
            </div>

            {/* 打印内容 */}
            <div className="max-w-4xl mx-auto px-4 py-6 print:p-0">
                {selectedItems.length === 0 ? (
                    <div className="text-center py-16 text-muted-foreground text-sm">
                        {items.length === 0 ? "没有符合条件的错题" : "还没有选择题目"}
                    </div>
                ) : (
                    <div className="space-y-8">
                        {selectedItems.map((item, index) => {
                            let tags: string[] = [];
                            if (item.tags && item.tags.length > 0) tags = item.tags.map((t) => t.name);
                            else {
                                try { tags = JSON.parse(item.knowledgePoints || "[]"); } catch { tags = []; }
                            }
                            return (
                                <div key={item.id} className="break-inside-avoid">
                                    {/* 题号：纸上唯一的身份标识，批改时靠它定位 */}
                                    <div className="flex items-baseline gap-2 mb-1">
                                        <span className="font-mono text-[11px] tracking-wider text-slate-500 print:text-[9pt]">
                                            #{item.shortCode || item.id.slice(-8)}
                                        </span>
                                        <span className="text-base font-bold print:text-[12pt]">
                                            第 {index + 1} 题
                                        </span>
                                        {item.subject && (
                                            <span className="text-xs text-muted-foreground">{item.subject.name}</span>
                                        )}
                                        {showTags && tags.length > 0 && (
                                            <span className="text-xs text-muted-foreground">{tags.join(" · ")}</span>
                                        )}
                                    </div>

                                    {showQuestionText && item.questionText ? (
                                        <MarkdownRenderer content={item.questionText} />
                                    ) : item.originalImageUrl ? (
                                        <img
                                            src={printCrops[item.id] || item.originalImageUrl}
                                            alt="题目"
                                            className="h-auto border rounded"
                                            style={{ maxWidth: `${imageScale}%` }}
                                        />
                                    ) : (
                                        <div className="h-16 flex items-center justify-center rounded border bg-muted/30 text-xs text-muted-foreground print:hidden">
                                            题目图片加载中…
                                        </div>
                                    )}

                                    {/* 作答框：把印刷体题干和学生手写隔开，扫描判分只看框内 */}
                                    {reserveSpace && SPACE_CM[space] > 0 && (
                                        <div
                                            className="mt-2 w-full rounded border border-dashed border-slate-300 print:border-slate-400"
                                            style={{ height: `${SPACE_CM[space]}cm` }}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* 答案区：统一放卷末，避免做题时瞄到下一题答案 */}
                {showAnswers && selectedItems.some((i) => i.answerText) && (
                    <div className="mt-10 pt-6 border-t-2 border-dashed break-before-page print:break-before-page">
                        <h2 className="text-base font-bold mb-3 print:text-[12pt]">参考答案</h2>
                        <div className="space-y-2.5">
                            {selectedItems.map((item, index) => (
                                <div key={`ans-${item.id}`} className="flex gap-2 text-sm break-inside-avoid">
                                    <span className="font-mono text-[10px] text-slate-400 pt-0.5 shrink-0">
                                        #{item.shortCode || item.id.slice(-8)}
                                    </span>
                                    <span className="font-semibold shrink-0">{index + 1}.</span>
                                    <div className="min-w-0 flex-1">
                                        <ReferenceAnswer text={item.answerText || "（无）"} />
                                        {showAnalysis && item.analysis && (
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                <MarkdownRenderer content={item.analysis} />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* 大图：点缩略图进来，可左右翻、可直接选中 */}
            {previewItem && (
                <div className="fixed inset-0 z-50 bg-slate-950/95 flex flex-col print:hidden" onClick={() => setPreviewAt(null)}>
                    <div className="flex items-center gap-3 px-4 py-3 text-white shrink-0" onClick={(e) => e.stopPropagation()}>
                        <span className="font-mono text-xs text-slate-400">#{previewItem.shortCode || "—"}</span>
                        <span className="text-xs text-slate-300">
                            {(previewAt || 0) + 1} / {visibleItems.length}
                        </span>
                        <span className="text-xs">
                            <span className="text-red-300 font-semibold">错 {previewItem.wrongCount || 0}</span>
                            <span className="text-slate-500"> · </span>
                            <span className="text-green-300 font-semibold">对 {previewItem.correctCount || 0}</span>
                        </span>
                        <button className="ml-auto w-8 h-8 rounded-full bg-white/10 text-white text-lg leading-none" onClick={() => setPreviewAt(null)}>
                            ×
                        </button>
                    </div>
                    <div className="flex-1 relative flex items-center justify-center overflow-auto px-2" onClick={(e) => e.stopPropagation()}>
                        <button
                            className="absolute left-2 w-10 h-10 rounded-full bg-white/10 text-white text-2xl disabled:opacity-25"
                            disabled={previewAt === 0}
                            onClick={() => setPreviewAt((v) => Math.max(0, (v || 0) - 1))}
                        >‹</button>
                        <img src={previewItem.originalImageUrl} alt="" className="max-w-full max-h-full object-contain bg-white rounded" />
                        <button
                            className="absolute right-2 w-10 h-10 rounded-full bg-white/10 text-white text-2xl disabled:opacity-25"
                            disabled={(previewAt || 0) >= visibleItems.length - 1}
                            onClick={() => setPreviewAt((v) => Math.min(visibleItems.length - 1, (v || 0) + 1))}
                        >›</button>
                    </div>
                    <div className="shrink-0 px-4 pb-5 pt-2" onClick={(e) => e.stopPropagation()}>
                        <p className="text-slate-300 text-xs line-clamp-3 mb-3">{previewItem.questionText || ""}</p>
                        <button
                            onClick={() => previewAt !== null && toggleAt(previewAt)}
                            className={`w-full rounded-xl py-3 text-sm font-semibold border ${
                                selectedIds.has(previewItem.id)
                                    ? "bg-blue-600 border-blue-600 text-white"
                                    : "border-white/30 text-white"
                            }`}
                        >
                            {selectedIds.has(previewItem.id) ? "✓ 已选中，点击取消" : "选中这道"}
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

export default function PrintPreviewPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center">加载中…</div>}>
            <PrintPreviewContent />
        </Suspense>
    );
}
