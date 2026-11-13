"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Filter, ChevronDown, Printer, ListChecks, Trash2, X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/toast";
import { useRouter } from "next/navigation";
import { ErrorListSkeleton } from "@/components/page-skeleton";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KnowledgeFilter } from "@/components/knowledge-filter";
import { ErrorItem, PaginatedResponse } from "@/types/api";
import { apiClient } from "@/lib/api-client";
import { Pagination } from "@/components/ui/pagination";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants/pagination";
import { QuestionCard } from "@/components/question-card";
import {
    consumeReturnFocus,
    invalidateListSnapshots,
    isFreshSnapshot,
    listCacheKey,
    markListOrigin,
    markReturnFocus,
    readListSnapshot,
    readListState,
    readScrollPos,
    saveListState,
    saveScrollPos,
    writeListSnapshot,
} from "@/lib/list-cache";

/** SSR 阶段没有 layoutEffect，退回 useEffect（静态导出预渲染不会报 warning） */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface ErrorListProps {
    subjectId?: string;
    subjectName?: string;
}

type KnowledgeFilterChange = {
    gradeSemester?: string;
    chapter?: string;
    tag?: string | null;
};

export function ErrorList({ subjectId, subjectName }: ErrorListProps = {}) {
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [loading, setLoading] = useState(true);
    // 有缓存时后台静默刷新：不闪骨架、不清空，只顶栏转个圈
    const [refreshing, setRefreshing] = useState(false);
    const [search, setSearch] = useState("");
    // 输入即时反馈：按键当帧就给视觉状态，不必等 250ms 防抖 + 服务端请求
    const [searching, setSearching] = useState(false);
    const [masteryFilter, setMasteryFilter] = useState<"all" | "mastered" | "unmastered">("all");
    const [timeFilter, setTimeFilter] = useState<"all" | "week" | "month">("all");
    const [gradeFilter, setGradeFilter] = useState("");
    const [chapterFilter, setChapterFilter] = useState("");
    const [selectedTag, setSelectedTag] = useState<string | null>(null);
    // 分页状态
    const [page, setPage] = useState(1);
    const [pageSize] = useState(DEFAULT_PAGE_SIZE);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    // 多选模式状态
    const [isSelectMode, setIsSelectMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isDeleting, setIsDeleting] = useState(false);
    // 从详情页返回时，刚点开的那道题要高亮一下，否则用户还得自己再找
    const [focusId, setFocusId] = useState<string | null>(null);
    const { t } = useLanguage();
    const router = useRouter();
    // 请求并发控制：筛选条件快速变化时只保留最后一次结果
    const requestSeqRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);

    const scope = subjectId || "all";
    // 离开列表去详情时，路由会把滚动重置成 0；如果这时再保存一次，
    // 记住的位置就被 0 覆盖了 —— 返回自然回到顶部。用 ref 兜住这个坑。
    const leavingRef = useRef(false);
    const lastScrollRef = useRef(0);
    // 刚看过（60s 内）的列表直接复用，连后台刷新都省了
    const skipNextFetchRef = useRef(false);

    const cacheKey = useMemo(
        () =>
            listCacheKey(
                scope,
                {
                    search,
                    mastery: masteryFilter,
                    time: timeFilter,
                    tag: selectedTag,
                    grade: gradeFilter,
                    chapter: chapterFilter,
                },
                page,
            ),
        [scope, search, masteryFilter, timeFilter, selectedTag, gradeFilter, chapterFilter, page],
    );
    const cacheKeyRef = useRef(cacheKey);
    cacheKeyRef.current = cacheKey;

    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    /**
     * 首帧恢复：列表数据 + 滚动位置。
     *
     * 用 useLayoutEffect 而不是 useEffect —— 它在浏览器绘制前同步执行，
     * 所以用户看到的第一帧就是旧内容，不会先闪一下骨架屏再跳。
     */
    const restoredRef = useRef(false);
    const stateAppliedRef = useRef(false);
    useIsoLayoutEffect(() => {
        if (restoredRef.current) return;

        // 第一步：把上次的页码/筛选还回去（会触发一次重渲染，本 effect 再进来）
        if (!stateAppliedRef.current) {
            stateAppliedRef.current = true;
            const saved = readListState(scope);
            const differs =
                saved &&
                (saved.page !== page ||
                    saved.search !== search ||
                    saved.mastery !== masteryFilter ||
                    saved.time !== timeFilter ||
                    saved.tag !== selectedTag ||
                    saved.grade !== gradeFilter ||
                    saved.chapter !== chapterFilter);
            if (saved && differs) {
                setSearch(saved.search || "");
                setMasteryFilter((saved.mastery as typeof masteryFilter) || "all");
                setTimeFilter((saved.time as typeof timeFilter) || "all");
                setSelectedTag(saved.tag ?? null);
                setGradeFilter(saved.grade || "");
                setChapterFilter(saved.chapter || "");
                setPage(saved.page || 1);
                return;
            }
        }

        restoredRef.current = true;
        const snap = readListSnapshot<ErrorItem>(cacheKeyRef.current);
        if (snap) {
            setItems(snap.items);
            setTotal(snap.total);
            setTotalPages(snap.totalPages);
            setLoading(false);
            // 数据是几十秒内的，没必要再拉一次；更旧的话就在后台悄悄刷新
            if (isFreshSnapshot(snap)) skipNextFetchRef.current = true;
            else setRefreshing(true);
        }
        const y = readScrollPos(scope);
        lastScrollRef.current = y;
        if (y > 0) {
            // 关掉浏览器的自动回到顶部，否则我们刚滚下去又被它拉回来
            try {
                window.history.scrollRestoration = "manual";
            } catch {
                /* Safari 老版本不支持，忽略 */
            }
            /**
             * 恢复滚动位置。不能只滚一次：
             *   - 卡片是异步渲染的，前几百毫秒页面还不够高，scrollTo 会被浏览器夹到 0；
             *   - 路由切换后框架自己还会把滚动重置到顶部。
             * 所以每 120ms 校正一次，持续 2 秒；用户一动手（滚轮/触摸）立刻让位。
             */
            let stop = false;
            const onUser = () => {
                stop = true;
            };
            window.addEventListener("wheel", onUser, { passive: true, once: true });
            window.addEventListener("touchstart", onUser, { passive: true, once: true });
            const deadline = Date.now() + 2000;
            const tick = () => {
                if (stop) return;
                if (Math.abs(window.scrollY - y) > 4) window.scrollTo(0, y);
                if (Date.now() < deadline) window.setTimeout(tick, 120);
            };
            requestAnimationFrame(tick);
        }
        // cacheKey 变化要再进来一次：先把页码/筛选还原，才能读到对应那一页的快照
    }, [cacheKey]);

    // 返回高亮：只在「从详情页回来」时触发一次
    useIsoLayoutEffect(() => {
        const id = consumeReturnFocus();
        if (!id) return;
        setFocusId(id);
        const timer = window.setTimeout(() => {
            const el = document.getElementById(`qcard-${id}`);
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const inView = rect.top >= 80 && rect.bottom <= window.innerHeight - 40;
            if (!inView) el.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 260);
        const clear = window.setTimeout(() => setFocusId(null), 3200);
        return () => {
            window.clearTimeout(timer);
            window.clearTimeout(clear);
        };
    }, []);

    // 滚动位置打点（节流 180ms，卸载时补最后一次）
    useEffect(() => {
        let timer: number | undefined;
        const onScroll = () => {
            if (leavingRef.current) return;
            lastScrollRef.current = window.scrollY;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => saveScrollPos(scope, lastScrollRef.current), 180);
        };
        window.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            window.removeEventListener("scroll", onScroll);
            window.clearTimeout(timer);
            if (!leavingRef.current) saveScrollPos(scope, lastScrollRef.current);
        };
    }, [scope]);

    const handleExportPrint = () => {
        const params = new URLSearchParams();
        if (subjectId) params.append("subjectId", subjectId);
        if (search) params.append("query", search);
        if (masteryFilter !== "all") {
            params.append("mastery", masteryFilter === "mastered" ? "1" : "0");
        }
        if (timeFilter !== "all") {
            params.append("timeRange", timeFilter);
        }
        if (selectedTag) {
            params.append("tag", selectedTag);
        }
        if (gradeFilter) params.append("gradeSemester", gradeFilter);
        if (chapterFilter) params.append("chapter", chapterFilter); // 章节筛选

        router.push(`/print-preview?${params.toString()}`);
    };

    const handleTagClick = (tag: string) => {
        setSelectedTag(selectedTag === tag ? null : tag);
    };

    const handleFilterChange = ({ gradeSemester, chapter, tag }: KnowledgeFilterChange) => {
        if (gradeSemester !== undefined) setGradeFilter(gradeSemester);
        if (chapter !== undefined) setChapterFilter(chapter);
        setSelectedTag(tag === undefined ? null : tag);

        // Clear dependent filters and reset page
        if (!gradeSemester) {
            setGradeFilter("");
            setChapterFilter("");
            setSelectedTag(null);
        } else if (!chapter) {
            setChapterFilter("");
        }
        setPage(1); // 筛选变化时重置页码
    };

    const toggleSelectMode = () => {
        setIsSelectMode(!isSelectMode);
        setSelectedIds(new Set());
    };

    const toggleSelectItem = (id: string, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleBatchDelete = async () => {
        if (selectedIds.size === 0) return;

        const confirmMsg = (t.notebook?.confirmBatchDelete || "Delete {count} items?").replace(
            "{count}",
            selectedIds.size.toString(),
        );
        if (!confirm(confirmMsg)) return;

        setIsDeleting(true);
        try {
            await apiClient.post("/api/error-items/batch-delete", {
                ids: Array.from(selectedIds),
            });
            toast.success(t.notebook?.batchDeleteSuccess || "Deleted successfully");
            setIsSelectMode(false);
            setSelectedIds(new Set());
            invalidateListSnapshots();
            fetchItems();
        } catch (error) {
            console.error(error);
            toast.error(t.common?.messages?.deleteFailed || "Delete failed");
        } finally {
            setIsDeleting(false);
        }
    };

    // 追踪筛选条件是否变化（用于判断是否需要重置页码）
    const prevFiltersRef = useRef({
        search,
        masteryFilter,
        timeFilter,
        selectedTag,
        subjectId,
        gradeFilter,
        chapterFilter,
    });

    useEffect(() => {
        // 刚从详情页回来且缓存新鲜：不请求，直接用缓存
        if (skipNextFetchRef.current) {
            skipNextFetchRef.current = false;
            return;
        }
        // 250ms 防抖：避免输入每个字符都触发一次列表请求
        const timer = setTimeout(() => {
            const prevFilters = prevFiltersRef.current;
            const filtersChanged =
                prevFilters.search !== search ||
                prevFilters.masteryFilter !== masteryFilter ||
                prevFilters.timeFilter !== timeFilter ||
                prevFilters.selectedTag !== selectedTag ||
                prevFilters.subjectId !== subjectId ||
                prevFilters.gradeFilter !== gradeFilter ||
                prevFilters.chapterFilter !== chapterFilter;

            // 更新 ref
            prevFiltersRef.current = {
                search,
                masteryFilter,
                timeFilter,
                selectedTag,
                subjectId,
                gradeFilter,
                chapterFilter,
            };

            if (filtersChanged && page !== 1) {
                // 筛选条件变化且不在第一页，重置到第一页（会再次触发此 effect）
                setPage(1);
                return;
            }

            // 正常请求数据
            fetchItems();
        }, 250);

        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, search, masteryFilter, timeFilter, selectedTag, subjectId, gradeFilter, chapterFilter]);

    const fetchItems = async (opts: { background?: boolean } = {}) => {
        const seq = ++requestSeqRef.current;
        // 取消上一次仍在进行的请求
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        if (!opts.background) {
            // 命中缓存时不铺骨架屏，只在顶栏转圈，避免「返回即白屏」
            const hasSnapshot = readListSnapshot<ErrorItem>(cacheKeyRef.current);
            if (hasSnapshot) setRefreshing(true);
            else setLoading(true);
        }
        try {
            const params = new URLSearchParams();
            if (subjectId) params.append("subjectId", subjectId);
            if (search) params.append("query", search);
            if (masteryFilter !== "all") {
                params.append("mastery", masteryFilter === "mastered" ? "1" : "0");
            }
            if (timeFilter !== "all") {
                params.append("timeRange", timeFilter);
            }
            if (selectedTag) {
                params.append("tag", selectedTag);
            }
            if (gradeFilter) params.append("gradeSemester", gradeFilter);
            if (chapterFilter) params.append("chapter", chapterFilter); // 章节筛选
            // 分页参数
            params.append("page", page.toString());
            params.append("pageSize", pageSize.toString());

            const response = await apiClient.get<PaginatedResponse<ErrorItem>>(
                `/api/error-items/list?${params.toString()}`,
                { signal: controller.signal },
            );
            // 已被更新的请求取代，丢弃结果
            if (seq !== requestSeqRef.current) return;
            setItems(response.items);
            setTotal(response.total);
            setTotalPages(response.totalPages);
            writeListSnapshot<ErrorItem>(cacheKeyRef.current, {
                items: response.items,
                total: response.total,
                totalPages: response.totalPages,
                page,
            });
        } catch (error) {
            // 主动取消的请求不当作错误
            if (seq !== requestSeqRef.current || controller.signal.aborted) return;
            console.error(error);
            // 列表查询失败保留上一屏数据，不清成空态，并给出明确提示
            toast.error(t.notebook?.loadFailed || "加载失败，请重试");
        } finally {
            if (seq === requestSeqRef.current) {
                setLoading(false);
                setRefreshing(false);
                setSearching(false);
            }
        }
    };

    // 页码/筛选一变就记下来，供下次挂载还原
    useEffect(() => {
        saveListState(scope, {
            page,
            search,
            mastery: masteryFilter,
            time: timeFilter,
            tag: selectedTag,
            grade: gradeFilter,
            chapter: chapterFilter,
        });
    }, [scope, page, search, masteryFilter, timeFilter, selectedTag, gradeFilter, chapterFilter]);

    const openItem = (id: string) => {
        // 记住三件事：哪道题、从哪个列表来的、滚到哪儿了
        leavingRef.current = true;
        markReturnFocus(id);
        if (typeof window !== "undefined") {
            markListOrigin(window.location.pathname + window.location.search);
            lastScrollRef.current = window.scrollY;
            saveScrollPos(scope, window.scrollY);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative w-full sm:flex-1">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder={t.notebook.search}
                        className="pl-9 pr-9"
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            setSearching(!!e.target.value);
                        }}
                    />
                    {(searching || refreshing || (loading && items.length > 0)) && (
                        <span className="absolute right-3 top-3 h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                    )}
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline">
                            <Filter className="mr-2 h-4 w-4" />
                            {t.notebook.filter}
                            <ChevronDown className="ml-2 h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuLabel>{t.filter.masteryStatus || "Mastery Status"}</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => setMasteryFilter("all")}>
                            {masteryFilter === "all" && "✓ "}
                            {t.filter.all || "All"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMasteryFilter("unmastered")}>
                            {masteryFilter === "unmastered" && "✓ "}
                            {t.filter.review || "To Review"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setMasteryFilter("mastered")}>
                            {masteryFilter === "mastered" && "✓ "}
                            {t.filter.mastered || "Mastered"}
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />

                        <DropdownMenuLabel>{t.filter.timeRange || "Time Range"}</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => setTimeFilter("all")}>
                            {timeFilter === "all" && "✓ "}
                            {t.filter.allTime || "All Time"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setTimeFilter("week")}>
                            {timeFilter === "week" && "✓ "}
                            {t.filter.lastWeek || "Last Week"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setTimeFilter("month")}>
                            {timeFilter === "month" && "✓ "}
                            {t.filter.lastMonth || "Last Month"}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" onClick={handleExportPrint}>
                    <Printer className="mr-2 h-4 w-4" />
                    {t.notebook?.exportPrint || "导出打印"}
                </Button>
                <Button variant={isSelectMode ? "secondary" : "outline"} onClick={toggleSelectMode}>
                    <ListChecks className="mr-2 h-4 w-4" />
                    {isSelectMode ? (t.notebook?.cancelSelect || "取消") : (t.notebook?.selectMode || "多选")}
                </Button>
            </div>

            {/* Advanced Filters Row */}
            <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
                <div className="w-full sm:w-auto">
                    <KnowledgeFilter
                        gradeSemester={gradeFilter}
                        tag={selectedTag}
                        onFilterChange={handleFilterChange}
                        subjectName={subjectName}
                    />
                </div>
            </div>

            {selectedTag && (
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                    <span className="text-sm text-muted-foreground">
                        {t.filter.filteringByTag || "Filtering by tag"}:
                    </span>
                    <Badge variant="secondary" className="cursor-pointer" onClick={() => setSelectedTag(null)}>
                        {selectedTag}
                        <span className="ml-1 text-xs">×</span>
                    </Badge>
                </div>
            )}

            {loading && items.length === 0 && <ErrorListSkeleton rows={4} />}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {items.map((item) => (
                    <div key={item.id} id={`qcard-${item.id}`}>
                        <QuestionCard
                            item={item}
                            href={`/item?id=${item.id}`}
                            isSelectMode={isSelectMode}
                            selected={selectedIds.has(item.id)}
                            highlighted={focusId === item.id}
                            selectedTag={selectedTag}
                            onToggleSelect={(e) => toggleSelectItem(item.id, e)}
                            onOpen={() => openItem(item.id)}
                            onTagClick={handleTagClick}
                        />
                    </div>
                ))}
            </div>

            {!loading && items.length === 0 && (
                <div className="py-16 text-center text-sm text-muted-foreground">
                    {search || selectedTag || masteryFilter !== "all" || timeFilter !== "all" || gradeFilter || chapterFilter
                        ? "没有符合条件的题目，试试放宽筛选"
                        : t.notebooks?.empty || "这个错题本还没有题目"}
                </div>
            )}

            {/* 分页器 */}
            <Pagination
                page={page}
                totalPages={totalPages}
                total={total}
                pageSize={pageSize}
                onPageChange={setPage}
            />

            {/* 多选模式底部操作栏 */}
            {isSelectMode && (
                <div className="fixed bottom-0 left-0 right-0 bg-background border-t shadow-lg p-4 z-50">
                    <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
                        <span className="text-sm text-muted-foreground">
                            {(t.notebook?.selectedCount || "{count} selected").replace(
                                "{count}",
                                selectedIds.size.toString(),
                            )}
                        </span>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={toggleSelectMode}>
                                <X className="mr-2 h-4 w-4" />
                                {t.notebook?.cancelSelect || "取消"}
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={handleBatchDelete}
                                disabled={selectedIds.size === 0 || isDeleting}
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t.notebook?.deleteSelected || "删除选中"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
