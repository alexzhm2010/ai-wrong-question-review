"use client";

/**
 * 错题卡片：正面是文字（题干 + 知识点），点右上角按钮翻到背面看**题目原图截图**。
 *
 * 为什么要有背面：
 *   很多题（几何图、表格、带下标的公式）纯文字根本还原不出来，
 *   光看 80 字摘要判断不出这是哪道题。截图才是最快的识别方式。
 *
 * 截图来源：列表接口为了体积刻意不返回 originalImageUrl，
 * 所以只有翻到背面时才按需拉这一道的详情，缩到 480px 后写进 IndexedDB。
 * 第二次翻同一张卡是本地秒开。
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import {
    CheckCircle2,
    Clock3,
    ImageIcon,
    Loader2,
    Maximize2,
    AlertTriangle,
    Type,
} from "lucide-react";
import { ErrorItem } from "@/types/api";
import { apiClient } from "@/lib/api-client";
import { cleanMarkdown } from "@/lib/markdown-utils";
import { bandOf, BAND_META, isArchived } from "@/lib/mastery";
import { ensureThumb, peekThumb } from "@/lib/image-cache";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

interface QuestionCardProps {
    item: ErrorItem;
    href: string;
    isSelectMode: boolean;
    selected: boolean;
    highlighted: boolean;
    selectedTag: string | null;
    /** 列表顶部的统一视图：true = 全部卡片显示截图 */
    globalFlipped?: boolean;
    /** 点一次顶部「翻转」按钮加 1，用来清掉单独翻过的卡片，让整页重新统一 */
    flipEpoch?: number;
    /** 整页模式的图片正在批量下发：这期间先别各自请求，等列表把图带回来 */
    photosPending?: boolean;
    onToggleSelect: (e: React.MouseEvent) => void;
    onOpen: () => void;
    onTagClick: (tag: string) => void;
}

/** 归档态单独给一套配色：它已退出日常复习，不该和「已掌握」混在一起 */
const ARCHIVED_META = {
    label: "已归档",
    hint: "手动标记，不再进日常复习",
    ring: "bg-slate-100 text-slate-700 border-slate-300",
};

function masteryView(item: ErrorItem) {
    if (isArchived(item)) {
        return { ...ARCHIVED_META, streak: Number(item.correctStreak || 0), archived: true };
    }
    const band = bandOf(item);
    return {
        label: BAND_META[band].label,
        hint: BAND_META[band].hint,
        ring: BAND_META[band].ring,
        streak: Number(item.correctStreak || 0),
        archived: false,
    };
}

/** 从题干里取一小段纯文本做摘要 */
function excerpt(item: ErrorItem, max = 90): string {
    const raw = (item.questionText || item.ocrText || "").split("\n\n")[0];
    const text = cleanMarkdown(raw || "").replace(/\s+/g, " ").trim();
    if (!text) return "（暂无题干文字，点右上角看原图）";
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function itemTags(item: ErrorItem): string[] {
    if (item.tags && item.tags.length > 0) {
        return [...new Set(item.tags.map((t) => (t.name || "").trim()).filter(Boolean))];
    }
    try {
        const parsed = JSON.parse(item.knowledgePoints || "[]");
        if (Array.isArray(parsed)) {
            return [
                ...new Set(
                    parsed
                        .map((x) => (typeof x === "string" ? x : x?.name))
                        .map((x) => String(x || "").trim())
                        .filter(Boolean),
                ),
            ];
        }
    } catch {
        /* 不是 JSON 就当没有 */
    }
    return [];
}

export function QuestionCard({
    item,
    href,
    isSelectMode,
    selected,
    highlighted,
    selectedTag,
    globalFlipped = false,
    flipEpoch = 0,
    photosPending = false,
    onToggleSelect,
    onOpen,
    onTagClick,
}: QuestionCardProps) {
    const { t } = useLanguage();
    /**
     * 翻面状态分两层：
     *   override —— 用户单独翻这一张的结果（null 表示「跟随列表统一视图」）；
     *   globalFlipped —— 顶部「看截图 / 看文字」按钮决定的整页模式。
     * 点全局按钮时 flipEpoch 变化，把 override 清空，整页重新对齐。
     */
    const [override, setOverride] = useState<boolean | null>(null);
    const flipped = override ?? globalFlipped;
    const [thumb, setThumb] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    const [tagsOpen, setTagsOpen] = useState(false);

    useEffect(() => {
        setOverride(null);
    }, [flipEpoch]);

    /**
     * 整页翻到截图态时，18 张卡同时要图 = 18 次详情请求，
     * 每张还要解码一张 2000px 的原图，屏幕外的等了也是白等。
     * 这里只让快要进入视口（提前 500px）的卡片去拉图。
     */
    const rootRef = useRef<HTMLDivElement>(null);
    const [nearView, setNearView] = useState(false);
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        if (typeof IntersectionObserver === "undefined") {
            setNearView(true);
            return;
        }
        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setNearView(true);
                    io.disconnect();
                }
            },
            { rootMargin: "500px 0px" },
        );
        io.observe(el);
        return () => io.disconnect();
    }, []);

    const tags = itemTags(item);
    const mastery = masteryView(item);

    // 翻到背面才去拿截图。列表若已把原图带回来（整页截图态），就只做本地缩放。
    const sig = 0;
    const listPhoto = item.originalImageUrl || null;
    useEffect(() => {
        if (!flipped || !nearView || thumb) return;
        /**
         * 这里刻意**不看 loading**。
         * loading 是 state，依赖变化导致 effect 重跑时它往往还是 true，
         * 一旦据此提前 return，旧任务的结果又已被 cleanup 标成作废，
         * 卡片就会永久停在「正在加载截图」。
         * 重复调用是安全的：ensureThumb 内部有 inflight 去重 + 内存缓存。
         */
        // 本会话算过的图直接拿来用：返回列表、来回翻转不该再等网络
        const local = peekThumb(item.id);
        if (local) {
            setThumb(local);
            setLoading(false);
            return;
        }
        // 整页模式正在批量取图：等它，别让每张卡自己去拉一次详情
        if (photosPending && !listPhoto) return;
        let alive = true;
        setLoading(true);
        setFailed(false);
        ensureThumb(
            item.id,
            () =>
                listPhoto
                    ? Promise.resolve({ originalImageUrl: listPhoto })
                    : apiClient.get<ErrorItem>(`/api/error-items/${item.id}`),
            sig,
        )
            .then((url) => {
                if (!alive) return;
                if (url) setThumb(url);
                else setFailed(true);
            })
            .catch(() => alive && setFailed(true))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flipped, item.id, sig, nearView, photosPending, listPhoto]);

    // 放大层打开时锁滚动，避免背景跟着滑
    useEffect(() => {
        if (!zoomed) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = prev;
        };
    }, [zoomed]);

    const stop = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const flip = (e: React.MouseEvent) => {
        stop(e);
        setOverride(!flipped);
    };

    const openZoom = (e: React.MouseEvent) => {
        stop(e);
        if (thumb) setZoomed(true);
    };

    const shownTags = tagsOpen ? tags : tags.slice(0, 3);

    return (
        <div
            ref={rootRef}
            className="relative"
            style={{ height: "19.5rem" }}
            data-flipped={flipped ? "1" : "0"}
        >
            {highlighted && (
                <span className="pointer-events-none absolute -top-2 right-3 z-20 rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground shadow-sm">
                    刚看过
                </span>
            )}

            {isSelectMode && (
                <div className="absolute top-2 left-2 z-20" onClick={(e) => onToggleSelect(e)}>
                    <Checkbox checked={selected} className="h-5 w-5 border-2 bg-background shadow-sm" />
                </div>
            )}

            <Link
                href={isSelectMode ? "#" : href}
                onClick={(e) => {
                    if (isSelectMode) {
                        e.preventDefault();
                        return;
                    }
                    onOpen();
                }}
                className="block h-full"
                aria-label="题目详情"
            >
                <div
                    className={cn(
                        "h-full rounded-xl transition-shadow",
                        highlighted && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                    )}
                    style={{ perspective: "1600px" }}
                >
                    <div
                        className="relative h-full w-full transition-transform duration-500 ease-out will-change-transform"
                        style={{
                            transformStyle: "preserve-3d",
                            transform: flipped ? "rotateY(180deg)" : undefined,
                        }}
                    >
                        {/* ── 正面：文字 */}
                        <div
                            className="absolute inset-0"
                            style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
                        >
                            <Card className="flex h-full flex-col gap-0 overflow-hidden py-0 bg-card">
                                <div className="flex items-center justify-between gap-2 px-4 pt-3">
                                    <Badge variant="outline" className={cn("text-xs font-medium", mastery.ring)}>
                                        {mastery.archived ? (
                                            <CheckCircle2 className="mr-1 h-3 w-3" />
                                        ) : mastery.streak > 1 ? (
                                            <CheckCircle2 className="mr-1 h-3 w-3" />
                                        ) : (
                                            <Clock3 className="mr-1 h-3 w-3" />
                                        )}
                                        {mastery.label}
                                    </Badge>
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs text-muted-foreground">
                                            {format(new Date(item.createdAt), "MM/dd")}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 gap-1 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
                                            title={t.notebook?.showImage || "看题目截图"}
                                            onClick={flip}
                                        >
                                            <ImageIcon className="h-3.5 w-3.5" />
                                            {t.notebook?.showImage || "看截图"}
                                        </Button>
                                    </div>
                                </div>

                                <div className="min-h-0 flex-1 px-4 pt-2">
                                    <p className="text-sm leading-relaxed line-clamp-5">{excerpt(item)}</p>
                                </div>

                                <div className="px-4 pb-3">
                                    <div className="mb-1.5 text-[11px] text-muted-foreground">
                                        {mastery.hint}
                                        {Number(item.wrongCount || 0) > 0 && (
                                            <span className="ml-2">错过 {item.wrongCount} 次</span>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {shownTags.map((tag) => (
                                            <Badge
                                                key={tag}
                                                variant={selectedTag === tag ? "default" : "outline"}
                                                className="max-w-full cursor-pointer truncate text-[11px] transition-colors hover:bg-primary/10"
                                                onClick={(e) => {
                                                    stop(e);
                                                    onTagClick(tag);
                                                }}
                                            >
                                                {tag}
                                            </Badge>
                                        ))}
                                        {tags.length > 3 && (
                                            <Badge
                                                variant="secondary"
                                                className="cursor-pointer text-[11px]"
                                                onClick={(e) => {
                                                    stop(e);
                                                    setTagsOpen((v) => !v);
                                                }}
                                            >
                                                {tagsOpen ? "收起" : `+${tags.length - 3}`}
                                            </Badge>
                                        )}
                                        {tags.length === 0 && (
                                            <span className="text-[11px] text-muted-foreground">未标知识点</span>
                                        )}
                                    </div>
                                </div>
                            </Card>
                        </div>

                        {/* ── 背面：截图 2/3 + 知识点 1/3 */}
                        <div
                            className="absolute inset-0"
                            style={{
                                backfaceVisibility: "hidden",
                                WebkitBackfaceVisibility: "hidden",
                                transform: "rotateY(180deg)",
                            }}
                        >
                            <Card className="flex h-full flex-col gap-0 overflow-hidden py-0 bg-card">
                                <div
                                    className="relative h-2/3 w-full cursor-zoom-in bg-white"
                                    onClick={openZoom}
                                    role="button"
                                    aria-label={t.notebook?.magnify || "放大查看"}
                                >
                                    {thumb ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={thumb}
                                            alt={t.notebook?.showImage || "题目截图"}
                                            className="absolute inset-0 h-full w-full object-contain"
                                        />
                                    ) : (
                                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 text-muted-foreground">
                                            {loading || !nearView || (photosPending && !thumb) ? (
                                                <>
                                                    <Loader2 className="h-5 w-5 animate-spin" />
                                                    <span className="text-xs">
                                                        {t.notebook?.imageLoading || "正在加载截图…"}
                                                    </span>
                                                </>
                                            ) : failed ? (
                                                <>
                                                    <AlertTriangle className="h-5 w-5" />
                                                    <span className="text-xs">
                                                        {t.notebook?.noImage || "这道题没有原图"}
                                                    </span>
                                                </>
                                            ) : (
                                                <>
                                                    <ImageIcon className="h-5 w-5" />
                                                    <span className="text-xs">点击查看截图</span>
                                                </>
                                            )}
                                        </div>
                                    )}
                                    {thumb && (
                                        <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                                            <Maximize2 className="h-3 w-3" />
                                            {t.notebook?.magnify || "放大"}
                                        </span>
                                    )}

                                    {/*
                                     * 翻回文字：必须是**看得见的按钮**。
                                     * 之前只放了个 Type 小图标在底部日期旁边，手机上像排版符号，
                                     * 用户根本找不到，翻过去就回不来了。
                                     */}
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="absolute top-2 right-2 h-7 gap-1 px-2 text-[11px] shadow-sm ring-1 ring-black/5"
                                        title={t.notebook?.showText || "看文字"}
                                        onClick={flip}
                                    >
                                        <Type className="h-3.5 w-3.5" />
                                        {t.notebook?.showText || "看文字"}
                                    </Button>
                                </div>

                                <div className="flex h-1/3 flex-col justify-between overflow-hidden px-3 py-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <Badge variant="outline" className={cn("text-xs font-medium", mastery.ring)}>
                                            {mastery.label}
                                        </Badge>
                                        <span className="text-[11px] text-muted-foreground">
                                            {format(new Date(item.createdAt), "MM/dd")}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5 overflow-hidden">
                                        {tags.slice(0, 4).map((tag) => (
                                            <Badge key={tag} variant="secondary" className="max-w-full truncate text-[11px]">
                                                {tag}
                                            </Badge>
                                        ))}
                                        {tags.length === 0 && (
                                            <span className="text-[11px] text-muted-foreground">未标知识点</span>
                                        )}
                                        {tags.length > 4 && (
                                            <span className="text-[11px] text-muted-foreground">+{tags.length - 4}</span>
                                        )}
                                    </div>
                                </div>
                            </Card>
                        </div>
                    </div>
                </div>
            </Link>

            {/* 放大看原图：卡片里的截图只有 480px，细节还得靠这层 */}
            {zoomed && thumb && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3"
                    onClick={(e) => {
                        stop(e);
                        setZoomed(false);
                    }}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={thumb} alt="题目截图" className="max-h-full max-w-full object-contain" />
                    <span className="absolute top-4 right-4 rounded-full bg-white/15 px-3 py-1 text-xs text-white">
                        点击任意处关闭
                    </span>
                </div>
            )}
        </div>
    );
}
