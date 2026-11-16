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
const SUBJECT_KEY = "wq:review-subjects";

const SIZES = [6, 12, 20];

function subjectKeyOf(item: ErrorItem): string {
    return item.subjectId || item.subject?.id || "__none__";
}

function subjectNameOf(item: ErrorItem): string {
    return item.subject?.name || "未分类";
}

function todayKey(): string {
    const d = new Date();
    // 用本地日期，别用 toISOString（那是 UTC，晚上会串到第二天）
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    // null = 还没从存储里恢复（此时等价于全选）；[] = 用户主动清空
    const [selectedSubjects, setSelectedSubjects] = useState<string[] | null>(null);

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

    // 只列出题库里真正有题的学科，避免空选项
    const subjectOptions = useMemo(() => {
        const map = new Map<string, { id: string; name: string; count: number }>();
        for (const it of items) {
            const id = subjectKeyOf(it);
            const row = map.get(id);
            if (row) row.count += 1;
            else map.set(id, { id, name: subjectNameOf(it), count: 1 });
        }
        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }, [items]);

    // 学科列表就绪后恢复用户上次的选择；首次使用默认全选
    useEffect(() => {
        if (!subjectOptions.length || selectedSubjects !== null) return;
        let restored: string[] | null = null;
        try {
            const raw = localStorage.getItem(SUBJECT_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) restored = arr.filter((x) => subjectOptions.some((o) => o.id === x));
            }
        } catch {
            /* 隐私模式读不到就用全选 */
        }
        setSelectedSubjects(restored ?? subjectOptions.map((o) => o.id));
    }, [subjectOptions, selectedSubjects]);

    const filteredItems = useMemo(() => {
        if (!selectedSubjects) return items;
        const set = new Set(selectedSubjects);
        return items.filter((it) => set.has(subjectKeyOf(it)));
    }, [items, selectedSubjects]);

    const picks = useMemo(
        () => pickReview<ErrorItem>(filteredItems, size, { seed }),
        [filteredItems, size, seed],
    );

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

    /** 保存选择并即时生效；null 状态按全选处理 */
    const applySubjects = (next: string[]) => {
        setSelectedSubjects(next);
        try {
            localStorage.setItem(SUBJECT_KEY, JSON.stringify(next));
        } catch {
            /* 忽略 */
        }
    };

    const toggleSubject = (id: string) => {
        const cur = selectedSubjects ?? subjectOptions.map((o) => o.id);
        applySubjects(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
    };

    const setAllSubjects = (all: boolean) => {
        applySubjects(all ? subjectOptions.map((o) => o.id) : []);
    };

    const changeSize = (n: number) => {
        setSize(n);
        try {
            localStorage.setItem(SIZE_KEY, String(n));
        } catch {
            /* 忽略 */
        }
    };

    const startPaper = async () => {
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

        // 把题目快照写库，换一个凭证 code 供卷面二维码扫码批改。
        // 失败不阻断打印：老用户仍可打印卷子，只是这次没有二维码。
        let code = "";
        let paperNo = "";
        try {
            const res = await apiClient.post<{ code: string; paperNo: string }>("/api/paper/create", {
                subjectNames: picks.map((p) => subjectNameOf(p.item)).filter((v, i, a) => a.indexOf(v) === i).join("、"),
                items: ids.map((id, i) => ({
                    id,
                    orderIndex: i,
                    shortCode: picks[i].item.shortCode || "",
                })),
            });
            code = res?.code || "";
            paperNo = res?.paperNo || "";
        } catch {
            /* 出卷失败降级为无二维码打印 */
        }

        const paperParams = code
            ? `&paper=${encodeURIComponent(code)}&paperNo=${encodeURIComponent(paperNo)}`
            : "";
        const q = ids.length ? `?ids=${ids.join(",")}${paperParams}` : "";
        router.push(`/print-preview${q}`);
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
    const hasAttempts = filteredItems.some(
        (i) => (Number(i.wrongCount) || 0) + (Number(i.correctCount) || 0) > 0,
    );

    return (
        <div className="min-h-screen pb-28">
            <div className="sticky top-0 z-20 bg-card/90 backdrop-blur-xl border-b">
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
                        className="shrink-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground/80"
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
                    <div className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] leading-relaxed text-foreground/80">
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
                                    : "border-border bg-card text-foreground/80"
                            }`}
                        >
                            {n} 道
                        </button>
                    ))}
                    <Link href="/mastery" className="ml-auto text-[11px] text-muted-foreground underline">
                        看掌握度
                    </Link>
                </div>

                {/* 学科多选：默认全选，选择会记住；清空后提示用户重新选 */}
                {subjectOptions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground mr-1 shrink-0">科目</span>
                        {subjectOptions.map((o) => {
                            const active = !selectedSubjects || selectedSubjects.includes(o.id);
                            return (
                                <button
                                    key={o.id}
                                    onClick={() => toggleSubject(o.id)}
                                    aria-pressed={active}
                                    className={`rounded-full border px-2.5 py-1 transition ${
                                        active
                                            ? "bg-slate-900 border-slate-900 text-white font-semibold"
                                            : "border-border bg-card text-foreground/80"
                                    }`}
                                >
                                    {o.name} <span className="opacity-60">{o.count}</span>
                                </button>
                            );
                        })}
                        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                            <button onClick={() => setAllSubjects(true)} className="underline">
                                全选
                            </button>
                            <button onClick={() => setAllSubjects(false)} className="underline">
                                清空
                            </button>
                        </div>
                    </div>
                )}

                {picks.length === 0 ? (
                    <div className="rounded-xl border bg-card px-4 py-12 text-center">
                        {selectedSubjects && selectedSubjects.length === 0 ? (
                            <>
                                <p className="text-sm text-foreground/80">请先在上方选择要复习的科目</p>
                                <button
                                    onClick={() => setAllSubjects(true)}
                                    className="mt-3 text-xs text-blue-600 underline"
                                >
                                    选择全部科目
                                </button>
                            </>
                        ) : filteredItems.length > 0 ? (
                            <>
                                <p className="text-sm text-foreground/80">这些科目的题都连续答对 2 次，暂时不用练了</p>
                                <p className="mt-2 text-[11px] text-muted-foreground">
                                    想再练某道题，去错题详情把它标回“未掌握”即可；答错后也会自动重新加入。
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-sm text-foreground/80">这些科目里还没有可复习的题</p>
                                <Link href="/notebook/add" className="mt-3 inline-block text-xs text-blue-600 underline">
                                    去录入第一道错题
                                </Link>
                            </>
                        )}
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
                                    className="overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
                                >
                                    {/* 元信息压成一行：序号 · 错/对 · 知识点 · 推荐理由 */}
                                    <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] leading-none">
                                        <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-slate-900 px-1 text-[10px] font-bold leading-none text-white">
                                            {i + 1}
                                        </span>
                                        <span className="shrink-0 text-red-500">错 {item.wrongCount || 0}</span>
                                        <span className="shrink-0 text-green-600">对 {item.correctCount || 0}</span>
                                        {names[0] && (
                                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                                                · {names[0]}
                                            </span>
                                        )}
                                        <span className="ml-auto max-w-[48%] shrink-0 truncate rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                                            {p.reason}
                                        </span>
                                    </div>

                                    {/* 主体只放题图：整宽展示，竖长卷面按视口高度收口，不再和文字抢宽度 */}
                                    <div className="border-t bg-white">
                                        {item.originalImageUrl ? (
                                            <AutoCropImage
                                                src={imageSrc(item.originalImageUrl)}
                                                maxWidth={900}
                                                enabled
                                                alt=""
                                                loading="lazy"
                                                className="mx-auto block max-h-[65vh] w-full object-contain sm:max-h-[55vh]"
                                            />
                                        ) : (
                                            <div className="flex h-28 items-center justify-center text-[11px] text-muted-foreground">
                                                暂无题目截图
                                            </div>
                                        )}
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 底部主操作：固定在拇指能碰到的地方 */}
            {picks.length > 0 && (
                <div className="app-bottom-bar fixed inset-x-0 bottom-0 z-30 border-t bg-card/90 backdrop-blur-xl px-4 py-3">
                    <div className="max-w-3xl mx-auto flex items-center gap-3">
                        <div className="min-w-0 text-[11px] text-muted-foreground leading-tight">
                            <div className="font-medium text-slate-700">{picks.length} 道 · 约 {minutes} 分钟</div>
                            <div>生成后可打印，扫码批改不耗 AI 额度</div>
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
