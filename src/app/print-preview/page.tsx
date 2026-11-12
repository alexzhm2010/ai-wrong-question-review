"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ReferenceAnswer } from "@/components/reference-answer";
import { apiClient } from "@/lib/api-client";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { PRINT_PREVIEW_PAGE_SIZE } from "@/lib/constants/pagination";
import {
    getPrintPreviewCountLabel,
    getPrintPreviewEmptyState,
    getSelectedPrintItems,
    shouldReserveAnswerSpace,
} from "@/lib/print-preview";

function PrintPreviewContent() {
    const searchParams = useSearchParams();
    const { t } = useLanguage();
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAnswers, setShowAnswers] = useState(false);
    const [showAnalysis, setShowAnalysis] = useState(false);
    const [showTags, setShowTags] = useState(false);
    const [imageScale, setImageScale] = useState(70);
    const [showQuestionText, setShowQuestionText] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    // 原图按需分批加载，不阻塞首屏
    const [imageProgress, setImageProgress] = useState({ loaded: 0, total: 0 });
    const imageLoadStarted = useRef(false);

    useEffect(() => {
        fetchItems();
    }, []);
    const fetchItems = async () => {
        try {
            const params = new URLSearchParams(searchParams.toString());
            // 打印预览需要所有符合条件的数据，设置较大的 pageSize。
            // 不再 includeImage=true：旧版一次拉回全库 7.65MB base64 原图，
            // 首屏要等 3.4 秒才出内容。现在先只取文本，页面立即可用。
            params.set("pageSize", String(PRINT_PREVIEW_PAGE_SIZE));
            const response = await apiClient.get<PaginatedResponse<ErrorItem>>(`/api/error-items/list?${params.toString()}`);
            setItems(response.items);
            setSelectedIds(new Set(response.items.map((item) => item.id)));
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    /**
     * 文本就绪后再按片补图：每片 8 张，后台渐进加载。
     * 用户先看到题目文字/占位骨架，图片陆续出现；总量不变但不再阻塞首屏，
     * 且只看文字（showQuestionText）时图片请求仍可在后台并行完成，打印不缺图。
     */
    useEffect(() => {
        if (loading || imageLoadStarted.current || items.length === 0) return;
        imageLoadStarted.current = true;
        let cancelled = false;
        const ids = items.map((item) => item.id);
        const BATCH = 8;
        const CONCURRENCY = 4; // 4 片并发，串行 10 片会把总耗时拖到 9 秒以上
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
                            setItems(prev => prev.map(it => (
                                byId.has(it.id) ? { ...it, originalImageUrl: byId.get(it.id) } : it
                            )));
                        }
                    } catch {
                        /* 单片失败不影响其余图片与文字内容 */
                    }
                    if (!cancelled) {
                        loaded += chunk.length;
                        setImageProgress({ loaded: Math.min(loaded, ids.length), total: ids.length });
                    }
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()),
            );
        })();
        return () => { cancelled = true; };
        // 只在首屏数据到达时启动一次；后续 setItems 不改长度，不会重跑
    }, [loading, items.length]);

    const handlePrint = () => {
        window.print();
    };

    const selectedItems = getSelectedPrintItems(items, selectedIds);
    const reserveAnswerSpace = shouldReserveAnswerSpace(showAnswers, showAnalysis);
    const countLabel = getPrintPreviewCountLabel(items.length, selectedItems.length);
    const emptyState = getPrintPreviewEmptyState(items.length, selectedItems.length);

    const toggleSelectedItem = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectAllItems = () => {
        setSelectedIds(new Set(items.map((item) => item.id)));
    };

    const clearSelectedItems = () => {
        setSelectedIds(new Set());
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    return (
        <>
            {/* Print Controls - Hidden when printing */}
            <div className="print:hidden sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="max-w-6xl mx-auto space-y-3">
                    {/* Header Row */}
                    <div className="flex items-center gap-3">
                        <BackButton fallbackUrl="/notebooks" />
                        <h1 className="text-lg sm:text-xl font-bold flex-1">
                            {t.printPreview?.title || 'Print Preview'} ({countLabel} {t.notebooks?.items || 'items'})
                        </h1>
                        {imageProgress.total > 0 && imageProgress.loaded < imageProgress.total && (
                            <span className="whitespace-nowrap text-xs text-muted-foreground print:hidden">
                                {t.printPreview?.imagesLoading || '图片'} {imageProgress.loaded}/{imageProgress.total}
                            </span>
                        )}
                        <Button onClick={handlePrint} size="sm" className="whitespace-nowrap" disabled={selectedItems.length === 0}>
                            {t.printPreview?.printButton || 'Print / Save PDF'}
                        </Button>
                    </div>

                    {/* Controls Row */}
                    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4">
                        {/* Image Scale Control */}
                        <div className="flex items-center gap-2 text-sm bg-muted/50 px-2 sm:px-3 py-1 rounded-md">
                            <span className="whitespace-nowrap text-xs sm:text-sm">{t.printPreview?.imageScale || 'Image Scale'}: {imageScale}%</span>
                            <input
                                type="range"
                                min="30"
                                max="100"
                                value={imageScale}
                                onChange={(e) => setImageScale(Number(e.target.value))}
                                className="w-16 sm:w-20 accent-primary"
                            />
                        </div>

                        {/* Toggle Options - Grid on Mobile */}
                        <div className="flex flex-wrap gap-x-3 gap-y-1 sm:gap-4">
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showQuestionText}
                                    onChange={(e) => setShowQuestionText(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showQuestionText || 'Question Text'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showAnswers}
                                    onChange={(e) => setShowAnswers(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showAnswers || 'Show Answers'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showAnalysis}
                                    onChange={(e) => setShowAnalysis(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showAnalysis || 'Show Analysis'}
                            </label>
                            <label className="flex items-center gap-1.5 text-xs sm:text-sm cursor-pointer whitespace-nowrap hover:text-primary transition-colors">
                                <input
                                    type="checkbox"
                                    checked={showTags}
                                    onChange={(e) => setShowTags(e.target.checked)}
                                    className="rounded border-gray-300 text-primary focus:ring-primary w-3.5 h-3.5 sm:w-4 sm:h-4"
                                />
                                {t.printPreview?.showTags || 'Show Tags'}
                            </label>
                        </div>
                    </div>

                    {/* Item Selection Row */}
                    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-medium">
                                {t.printPreview?.selectItems || 'Select Items'} ({selectedItems.length}/{items.length})
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={selectAllItems}>
                                    {t.printPreview?.selectAll || 'Select All'}
                                </Button>
                                <Button variant="outline" size="sm" onClick={clearSelectedItems}>
                                    {t.printPreview?.clearSelection || 'Clear Selection'}
                                </Button>
                            </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-44 overflow-y-auto pr-1">
                            {items.map((item, index) => (
                                <label
                                    key={item.id}
                                    className="flex items-start gap-2 rounded border bg-background p-2 text-xs cursor-pointer hover:border-primary/50"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.has(item.id)}
                                        onChange={() => toggleSelectedItem(item.id)}
                                        className="mt-0.5 rounded border-gray-300 text-primary focus:ring-primary"
                                    />
                                    <span className="line-clamp-2">
                                        <span className="font-semibold">
                                            {t.printPreview?.questionNumber?.replace('{num}', String(index + 1)) || `Question ${index + 1}`}
                                        </span>
                                        {item.questionText ? `：${item.questionText}` : ''}
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Print Content */}
            <div className="max-w-4xl mx-auto p-8 print:p-0">
                {selectedItems.map((item, index) => {
                    // 优先使用 tags 关联，回退到 knowledgePoints
                    let tags: string[] = [];
                    if (item.tags && item.tags.length > 0) {
                        tags = item.tags.map(t => t.name);
                    } else {
                        try {
                            tags = JSON.parse(item.knowledgePoints || "[]");
                        } catch (e) {
                            tags = [];
                        }
                    }

                    return (
                        <div
                            key={item.id}
                            className={`mb-4 border-b last:border-b-0 print:break-inside-avoid ${reserveAnswerSpace ? "pb-20 print:pb-16" : "pb-6"}`}
                        >
                            {/* Question Header */}
                            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 leading-7">
                                <span className="text-lg font-bold">
                                    {t.printPreview?.questionNumber?.replace('{num}', String(index + 1)) || `Question ${index + 1}`}
                                </span>
                                {item.subject && (
                                    <span className="text-sm text-muted-foreground">
                                        {item.subject.name}
                                    </span>
                                )}
                                {item.gradeSemester && (
                                    <span className="text-sm text-muted-foreground">
                                        {item.gradeSemester}
                                    </span>
                                )}
                                {showTags && tags.length > 0 && (
                                    <>
                                        <span className="font-semibold">
                                            {t.printPreview?.knowledgePoints || 'Knowledge Points'}:
                                        </span>
                                        {tags.map((tag, tagIndex) => (
                                            <span
                                                key={`${tag}-${tagIndex}`}
                                                className="px-2 py-1 bg-muted rounded text-sm"
                                            >
                                                {tag}
                                            </span>
                                        ))}
                                    </>
                                )}
                            </div>

                            {/* Original Image or Text */}
                            {showQuestionText && item.questionText ? (
                                <div className="mb-4">
                                    <MarkdownRenderer content={item.questionText} />
                                </div>
                            ) : item.originalImageUrl ? (
                                <div className="mb-4">
                                    <img
                                        src={item.originalImageUrl}
                                        alt={t.detail?.originalProblem || 'Question Image'}
                                        className="h-auto border rounded"
                                        style={{ maxWidth: `${imageScale}%` }}
                                    />
                                </div>
                            ) : (
                                <div className="mb-4 flex h-20 items-center justify-center rounded border bg-muted/30 text-xs text-muted-foreground print:hidden">
                                    {t.printPreview?.imageLoading || '题目图片加载中…'}
                                </div>
                            )}



                            {/* Answer */}
                            {showAnswers && item.answerText && (
                                <div className="mb-4">
                                    <h3 className="font-semibold mb-2">{t.printPreview?.referenceAnswer || 'Reference Answer'}:</h3>
                                    <ReferenceAnswer text={item.answerText} />
                                </div>
                            )}

                            {/* Analysis */}
                            {showAnalysis && item.analysis && (
                                <div className="mb-4">
                                    <h3 className="font-semibold mb-2">{t.printPreview?.analysis || 'Analysis'}:</h3>
                                    <MarkdownRenderer content={item.analysis} />
                                </div>
                            )}
                        </div>
                    );
                })}

                {emptyState && (
                    <div className="text-center py-12 text-muted-foreground">
                        {emptyState === 'noSelection'
                            ? (t.printPreview?.noSelection || 'No items selected')
                            : (t.printPreview?.noItems || 'No matching error items')}
                    </div>
                )}
            </div>
        </>
    );
}

export default function PrintPreviewPage() {
    const { t } = useLanguage();
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center">{t.common.loading}</div>}>
            <PrintPreviewContent />
        </Suspense>
    );
}
