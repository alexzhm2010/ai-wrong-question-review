"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Printer, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ReferenceAnswer } from "@/components/reference-answer";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import { autoCrop } from "@/lib/image-autocrop";

type SpaceKey = "none" | "sm" | "md" | "lg";

const SPACE_CM: Record<SpaceKey, number> = { none: 0, sm: 4, md: 6, lg: 9 };

/**
 * 错题本多选后把题目 id 放这里再跳过来。
 * 用 sessionStorage 而不是 URL：80 个 id 拼进 query 就是 2 KB 以上，
 * 几百道直接超浏览器上限；而且这批选择本来就只活这一次会话。
 */
export const PRINT_PAYLOAD_KEY = "wq:print-payload";

/** 排版设置沿用上次，否则每次进来都要重调图宽和作答区 */
const SETTINGS_KEY = "wq:print-settings";

/** 一次请求最多带多少个 id：再多 URL 就太长，分批并发 */
const ID_CHUNK = 40;

type PrintSettings = {
    showQuestionText: boolean;
    autoCropOn: boolean;
    showAnswers: boolean;
    showAnalysis: boolean;
    showTags: boolean;
    space: SpaceKey;
    imageScale: number;
};

const DEFAULT_SETTINGS: PrintSettings = {
    showQuestionText: false,
    autoCropOn: true,
    showAnswers: false,
    showAnalysis: false,
    showTags: false,
    space: "sm",
    imageScale: 60,
};

function loadSettings(): PrintSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<PrintSettings>;
            return { ...DEFAULT_SETTINGS, ...parsed };
        }
        // 兼容旧版本单独存的裁边开关
        if (localStorage.getItem("wq:autocrop") === "0") {
            return { ...DEFAULT_SETTINGS, autoCropOn: false };
        }
    } catch {
        /* 无痕模式读不到就用默认值 */
    }
    return DEFAULT_SETTINGS;
}

function readPayloadIds(): string[] {
    try {
        const raw = sessionStorage.getItem(PRINT_PAYLOAD_KEY);
        if (!raw) return [];
        const data = JSON.parse(raw) as { ids?: unknown; at?: number };
        // 半小时前的那批选择已经过时了，别让用户莫名其妙看到旧题
        if (typeof data?.at === "number" && Date.now() - data.at > 30 * 60 * 1000) return [];
        return Array.isArray(data?.ids) ? (data.ids as string[]).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/** URL 上是不是带着别的筛选条件（掌握度页按知识点进来就是 ?tag=） */
function hasUrlScope(sp: URLSearchParams): boolean {
    return ["tag", "subjectId", "gradeSemester", "chapter", "query", "mastery", "timeRange"].some(
        (k) => !!sp.get(k),
    );
}

function chunk<T>(list: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

function PrintPreviewContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [settings, setSettings] = useState<PrintSettings>(DEFAULT_SETTINGS);
    const [imageProgress, setImageProgress] = useState({ loaded: 0, total: 0 });
    const [printCrops, setPrintCrops] = useState<Record<string, string>>({});
    const [preparing, setPreparing] = useState(false);
    const [showFloatPrint, setShowFloatPrint] = useState(false);
    const imageLoadStarted = useRef(false);

    const topbarRef = useRef<HTMLDivElement>(null);
    const [topH, setTopH] = useState(88);

    const {
        showQuestionText,
        autoCropOn,
        showAnswers,
        showAnalysis,
        showTags,
        space,
        imageScale,
    } = settings;

    const patchSettings = (patch: Partial<PrintSettings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            try {
                localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
            } catch {
                /* 写不进去不影响本次使用 */
            }
            return next;
        });
    };

    /** 题目 id 来源之一：URL 上的（批改页 / 今日卷） */
    const urlIds = useMemo(() => {
        return (searchParams.get("ids") || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }, [searchParams]);

    useEffect(() => {
        setSettings(loadSettings());
    }, []);

    useEffect(() => {
        const el = topbarRef.current;
        if (!el) return;
        const sync = () => setTopH(el.offsetHeight);
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(el);
        return () => ro.disconnect();
    }, [loading]);

    useEffect(() => {
        const onScroll = () => setShowFloatPrint(window.scrollY > 700);
        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    /**
     * 取数。三条路：
     *   1. URL 带 ids（批改页「重做这 N 道」、今日卷）—— 只取这几道；
     *   2. 错题本多选后跳转，ids 在 sessionStorage 里 —— 同样只取这几道；
     *   3. 掌握度页按知识点进来，只有 tag —— 按 tag 取。
     * 没有选择也没有条件时给空态，不再默默打印整库。
     */
    const fetchItems = useCallback(async () => {
        // 带条件进来的（知识点 / 错题本筛选）就用条件，不要被上次残留的选题顶掉
        const ids = urlIds.length ? urlIds : hasUrlScope(searchParams) ? [] : readPayloadIds();
        try {
            let list: ErrorItem[] = [];
            if (ids.length) {
                const parts = chunk(ids, ID_CHUNK);
                const results = await Promise.all(
                    parts.map((part) => {
                        const q = new URLSearchParams();
                        q.set("ids", part.join(","));
                        q.set("page", "1");
                        q.set("pageSize", String(Math.max(part.length, 1)));
                        const extra = searchParams.get("subjectId");
                        if (extra) q.set("subjectId", extra);
                        return apiClient
                            .get<PaginatedResponse<ErrorItem>>(`/api/error-items/list?${q.toString()}`)
                            .then((r) => r.items)
                            .catch(() => [] as ErrorItem[]);
                    }),
                );
                list = results.flat();
            } else if (hasUrlScope(searchParams)) {
                const q = new URLSearchParams(searchParams.toString());
                q.delete("ids");
                q.delete("src");
                q.set("page", "1");
                q.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
                const res = await apiClient.get<PaginatedResponse<ErrorItem>>(
                    `/api/error-items/list?${q.toString()}`,
                );
                list = res.items;
            }
            // 既没有点名题目、也没有筛选条件：保持空态。
            // 以前这里会默默把整个库拉进来打印，用户根本不知道打了什么。
            setItems(list);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }, [searchParams, urlIds]);

    useEffect(() => {
        void fetchItems();
    }, [fetchItems]);

    /** 按选择时的顺序排，卷子顺序就是用户点选的顺序 */
    const orderedItems = useMemo(() => {
        if (!urlIds.length) return items;
        const rank = new Map(urlIds.map((id, i) => [id, i]));
        return items
            .slice()
            .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    }, [items, urlIds]);

    /** 文本就绪后按片补图：4 片并发，图片全到齐之前打印会缺图 */
    useEffect(() => {
        if (loading || imageLoadStarted.current || orderedItems.length === 0) return;
        imageLoadStarted.current = true;
        let cancelled = false;
        const ids = orderedItems.map((item) => item.id);
        const parts = chunk(ids, 8);
        let cursor = 0;
        let loaded = 0;
        setImageProgress({ loaded: 0, total: ids.length });
        (async () => {
            const worker = async () => {
                while (!cancelled) {
                    const idx = cursor++;
                    if (idx >= parts.length) return;
                    const part = parts[idx];
                    try {
                        const res = await apiClient.get<{
                            images: Array<{ id: string; originalImageUrl: string }>;
                        }>(`/api/error-items/images?ids=${part.join(",")}`);
                        const byId = new Map(
                            (res.images || []).map((x) => [x.id, x.originalImageUrl]),
                        );
                        if (!cancelled && byId.size) {
                            setItems((prev) =>
                                prev.map((it) =>
                                    byId.has(it.id)
                                        ? { ...it, originalImageUrl: byId.get(it.id) }
                                        : it,
                                ),
                            );
                        }
                    } catch {
                        /* 单片失败不影响其余 */
                    }
                    if (!cancelled) {
                        loaded += part.length;
                        setImageProgress({
                            loaded: Math.min(loaded, ids.length),
                            total: ids.length,
                        });
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(4, parts.length) }, () => worker()),
            );
        })();
        return () => {
            cancelled = true;
        };
    }, [loading, orderedItems.length]);

    const reserveSpace = !showAnswers && !showAnalysis;

    /**
     * 后台先把高清裁边图算好，进打印对话框前已经备好，
     * 用户看到的排版就是印出来的排版。每次只算一张并让出主线程。
     */
    const cropJobs = useRef<Set<string>>(new Set());
    const cropInflight = useRef<Set<string>>(new Set());
    const imageKey = orderedItems
        .map((i) => (i.originalImageUrl ? `${i.id}:${i.originalImageUrl.length}` : ""))
        .filter(Boolean)
        .join(",");
    useEffect(() => {
        if (!autoCropOn || !orderedItems.length) return;
        let cancelled = false;
        const byId = new Map(orderedItems.map((i) => [i.id, i]));
        const queue = orderedItems.map((i) => i.id).slice(0, 80);
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
    }, [autoCropOn, imageKey]);

    /**
     * 打印的同时把这批题目记到本地：用户做完卷子回来点「批改」，
     * 不用再从列表里一道道挑，直接就是刚才打印的这一批。
     */
    const handlePrint = async () => {
        try {
            localStorage.setItem(
                "wq:last-print",
                JSON.stringify({ ids: orderedItems.map((i) => i.id), at: Date.now() }),
            );
        } catch {
            /* 隐私模式下写不进去，不影响打印 */
        }

        if (autoCropOn && orderedItems.length) {
            setPreparing(true);
            const targets = orderedItems.filter((i) => i.originalImageUrl).slice(0, 60);
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
                await new Promise<void>((r) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => r())),
                );
            } finally {
                setPreparing(false);
            }
        }
        window.print();
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">加载中…</p>
            </div>
        );
    }

    const total = orderedItems.length;
    const gotImages = imageProgress.total > 0 && imageProgress.loaded < imageProgress.total;

    return (
        <>
            {/* 顶栏：只留「这是哪一批、怎么回去、开始打印」 */}
            <div
                ref={topbarRef}
                className="print:hidden sticky top-0 z-20 border-b bg-background/95 backdrop-blur"
            >
                <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2">
                    <div className="flex items-center gap-2.5">
                        <button
                            type="button"
                            onClick={() => router.back()}
                            aria-label="返回改选"
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100"
                        >
                            <ArrowLeft className="h-5 w-5" />
                        </button>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-[15px] font-bold leading-tight">
                                打印设置
                            </div>
                            <div className="truncate text-[11px] leading-tight text-muted-foreground">
                                共 {total} 道
                                {gotImages
                                    ? ` · 图 ${imageProgress.loaded}/${imageProgress.total}`
                                    : ""}
                                {total > 0 ? " · 左上角可返回" : ""}
                            </div>
                        </div>
                        <Button
                            onClick={handlePrint}
                            size="sm"
                            className="shrink-0 whitespace-nowrap"
                            disabled={total === 0 || preparing}
                        >
                            {preparing ? "准备图片…" : "打印 / PDF"}
                        </Button>
                    </div>
                </div>
            </div>

            {/* 设置条：滚到顶就吸住，预览在它下面滚动 */}
            <div
                className="print:hidden sticky z-10 border-b bg-background/95 backdrop-blur"
                style={{ top: topH }}
            >
                <div className="max-w-4xl mx-auto px-3 sm:px-4 py-1.5">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showQuestionText}
                                onChange={(e) =>
                                    patchSettings({ showQuestionText: e.target.checked })
                                }
                                className="rounded border-gray-300 accent-blue-600"
                            />
                            用文字（默认用原图）
                        </label>
                        <label
                            className="flex items-center gap-1.5 cursor-pointer"
                            title="去掉手机状态栏与四周白边，题会印得更大更清楚"
                        >
                            <input
                                type="checkbox"
                                checked={autoCropOn}
                                onChange={(e) => patchSettings({ autoCropOn: e.target.checked })}
                                className="rounded border-gray-300 accent-blue-600"
                            />
                            自动裁边
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showAnswers}
                                onChange={(e) => patchSettings({ showAnswers: e.target.checked })}
                                className="rounded border-gray-300 accent-blue-600"
                            />
                            附答案（放卷末）
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showAnalysis}
                                onChange={(e) =>
                                    patchSettings({ showAnalysis: e.target.checked })
                                }
                                className="rounded border-gray-300 accent-blue-600"
                            />
                            附解析
                        </label>
                        <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={showTags}
                                onChange={(e) => patchSettings({ showTags: e.target.checked })}
                                className="rounded border-gray-300 accent-blue-600"
                            />
                            知识点
                        </label>
                        <span className="flex items-center gap-1.5">
                            作答区
                            <select
                                value={space}
                                onChange={(e) =>
                                    patchSettings({ space: e.target.value as SpaceKey })
                                }
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
                            <input
                                type="range"
                                min={30}
                                max={100}
                                value={imageScale}
                                onChange={(e) =>
                                    patchSettings({ imageScale: Number(e.target.value) })
                                }
                                className="w-16 accent-blue-600"
                            />
                            {imageScale}%
                        </span>
                    </div>
                </div>
            </div>

            {/* 打印内容 */}
            <div className="max-w-4xl mx-auto px-4 py-6 print:p-0">
                {total === 0 ? (
                    <div className="py-16 text-center text-sm text-muted-foreground">
                        <p>还没有选题</p>
                        <p className="mt-1 text-xs text-slate-400">
                            回到错题本，点「多选」勾上要打印的题，再点「导出打印」
                        </p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {orderedItems.map((item, index) => {
                            let tags: string[] = [];
                            if (item.tags && item.tags.length > 0) tags = item.tags.map((t) => t.name);
                            else {
                                try {
                                    tags = JSON.parse(item.knowledgePoints || "[]");
                                } catch {
                                    tags = [];
                                }
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
                                            <span className="text-xs text-muted-foreground">
                                                {item.subject.name}
                                            </span>
                                        )}
                                        {showTags && tags.length > 0 && (
                                            <span className="text-xs text-muted-foreground">
                                                {tags.join(" · ")}
                                            </span>
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
                {showAnswers && orderedItems.some((i) => i.answerText) && (
                    <div className="mt-10 pt-6 border-t-2 border-dashed break-before-page print:break-before-page">
                        <h2 className="text-base font-bold mb-3 print:text-[12pt]">参考答案</h2>
                        <div className="space-y-2.5">
                            {orderedItems.map((item, index) => (
                                <div
                                    key={`ans-${item.id}`}
                                    className="flex gap-2 text-sm break-inside-avoid"
                                >
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

            {/* 几十道题滚到一半想打印，不必再滚回顶部 */}
            {showFloatPrint && total > 0 && (
                <button
                    type="button"
                    onClick={handlePrint}
                    disabled={preparing}
                    className="print:hidden fixed right-4 bottom-5 z-30 flex items-center gap-1.5 rounded-full bg-slate-900/90 px-3.5 py-2.5 text-xs font-medium text-white shadow-lg backdrop-blur transition active:scale-95 disabled:opacity-60"
                >
                    <Printer className="h-3.5 w-3.5" />
                    {preparing ? "准备中…" : "打印"}
                </button>
            )}
        </>
    );
}

export default function PrintPreviewPage() {
    return (
        <Suspense
            fallback={<div className="min-h-screen flex items-center justify-center">加载中…</div>}
        >
            <PrintPreviewContent />
        </Suspense>
    );
}
