"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import { compressImage } from "@/lib/image-utils";
import { splitForScan, zoomCrop } from "@/lib/scan-split";
import { mergeHits, needsReview, planReview, VERDICT_TEXT, type MergedHit, type ScanHit, type Verdict } from "@/lib/scan-merge";
import { AttemptResult, ErrorItem } from "@/types/api";

const SCAN_KEY = "wq:scan-results";
/** 同时发几段。段数固定不超过 4，所以基本是一轮发完，墙钟≈最慢那一段 */
const CONCURRENCY = 4;
/** 低于这个置信度的题，会自动放大重读一次 */
const REVIEW_THRESHOLD = 0.62;
/** 复核最多重读几段、每段最多几道题：兜底不能变成第二遍全量识别 */
const REVIEW_MAX_STRIPS = 4;
const REVIEW_MAX_CODES = 6;

type ScanPhoto = { id: string; dataUrl: string };

type Strip = {
    key: string;
    pageId: string;
    index: number;
    dataUrl: string;
    /** 源图中的像素范围，复核时按这个范围重新放大裁切 */
    y0: number;
    y1: number;
    state: "wait" | "run" | "ok" | "err";
    ms?: number;
    found?: number;
};

type Row = MergedHit & {
    id: string;
    matched: boolean;
    label: string;
    /** 选择题字母集合本地定过，不再依赖模型 */
    localChecked: boolean;
    /** 用户手动改过判定 */
    overridden: boolean;
    /** 需要人看一眼：冲突或置信度低 */
    needsReview: boolean;
};

/** 接口返回的原始行 */
type ScanRow = {
    code: string;
    matched: boolean;
    verdict: AttemptResult;
    studentAnswer: string;
    confidence: number;
};

/**
 * 选择题本地复核：把「标准答案」和「学生答案」都归一成字母集合再比。
 * 模型对多选题漏选很不敏感（把 "AC" 判成与 "ACD" 等价），这一步是确定性的，
 * 只要两边都是 1-4 个字母就本地定论，不再依赖模型。
 */
function localChoiceVerdict(student: string, standard: string): AttemptResult | null {
    const pick = (s: string) => (s || "").toUpperCase().replace(/[^A-Z]/g, "");
    const std = pick(standard);
    const stu = pick(student);
    if (!std || !stu || std.length > 4 || stu.length > 4) return null;
    return [...std].sort().join("") === [...stu].sort().join("") ? "correct" : "wrong";
}

/** 把原始命中合并成页面要显示的行。列表与复核挑题都走这一条路径，避免两套判定 */
function buildRows(hits: ScanHit[], items: ErrorItem[], overrides: Record<string, Verdict>): Row[] {
    return mergeHits(hits).map((h) => {
        const item = items.find((i) => String(i.shortCode || "") === h.code);
        const local = item ? localChoiceVerdict(h.studentAnswer, String(item.answerText || "")) : null;
        const overridden = !!overrides[h.code];
        const verdict = overrides[h.code] ?? local ?? h.verdict;
        return {
            ...h,
            verdict,
            id: item?.id || "",
            matched: !!item,
            localChecked: !!local,
            overridden,
            label: item ? `第 ${items.findIndex((i) => i.id === item.id) + 1} 题` : "库里没有",
            // 手动改过的题不再提示，本地字母定过的也不提示
            needsReview: overridden ? false : needsReview(h, { localChecked: !!local, threshold: REVIEW_THRESHOLD }),
        };
    });
}

function ScanContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const fileRef = useRef<HTMLInputElement>(null);
    const camRef = useRef<HTMLInputElement>(null);

    const [items, setItems] = useState<ErrorItem[]>([]);
    const [pages, setPages] = useState<ScanPhoto[]>([]);
    const [strips, setStrips] = useState<Strip[]>([]);
    const [hits, setHits] = useState<ScanHit[]>([]);
    const [overrides, setOverrides] = useState<Record<string, Verdict>>({});
    const [preparing, setPreparing] = useState(false);
    const [elapsed, setElapsed] = useState<number | null>(null);
    const [error, setError] = useState("");
    const [hint, setHint] = useState("");
    const [reviewState, setReviewState] = useState<{ running: boolean; done: number; total: number } | null>(null);
    const [reviewedCount, setReviewedCount] = useState(0);
    const [onlyTodo, setOnlyTodo] = useState(false);

    // 重拍到第 N 张时，前面几张的结果还在路上，序号用来丢弃过期结果
    const seqRef = useRef(0);
    const startedRef = useRef(0);
    const itemsRef = useRef<ErrorItem[]>([]);
    itemsRef.current = items;
    const hitsRef = useRef<ScanHit[]>([]);
    const stripsRef = useRef<Strip[]>([]);
    const pagesRef = useRef<ScanPhoto[]>([]);
    const reviewedRef = useRef<Set<string>>(new Set());

    const idsParam = searchParams.get("ids") || "";
    const ids = useMemo(() => idsParam.split(",").filter(Boolean), [idsParam]);

    useEffect(() => {
        if (!ids.length) return;
        apiClient
            .get<{ items: ErrorItem[] }>(`/api/error-items/details?ids=${ids.join(",")}`)
            .then((res) => {
                // PostgREST 的 in.() 不保证顺序，这里按打印批次原顺序重排，
                // 否则「第 N 题」会和纸上印的题号对不上
                const byId = new Map((res.items || []).map((i) => [i.id, i]));
                setItems(ids.map((id) => byId.get(id)).filter(Boolean) as ErrorItem[]);
            })
            .catch(() => setError("题目加载失败"));
    }, [ids]);

    const addHits = useCallback((extra: ScanHit[]) => {
        if (!extra.length) return;
        hitsRef.current = [...hitsRef.current, ...extra];
        setHits(hitsRef.current);
    }, []);

    const rows = useMemo(() => buildRows(hits, items, overrides), [hits, items, overrides]);

    /**
     * 复核：把「把握不足」和「根本没识别出来」的题，从**原始整页**放大重裁后再读一次。
     *
     * 两条触发路径，一条靠模型自报置信度，一条不靠：
     *   1. 置信度低于阈值、或两处结论打架 → 重读那一块；
     *   2. 这一批里有题整条没出现 → 按它在这批里的位置估出所在段再读。
     *      实测模型对潦草笔迹会**很自信地**说「空白」，所以光看置信度会漏，
     *      必须有一条独立于置信度的补漏。
     *
     * 两条路径合计最多 4 段、每段 6 道，兜底不能变成第二遍全量识别。
     */
    const runReview = useCallback(
        async (seq: number) => {
            if (seq !== seqRef.current) return;
            const current = buildRows(hitsRef.current, itemsRef.current, {});

            // 1) 把握不足的题：用置信度最高的那一段作为重裁来源，它最可能把作答框拍全
            const uncertain = current
                .filter((r) => r.matched && !r.localChecked && r.needsReview && !reviewedRef.current.has(r.code))
                .map((r) => {
                    const src = [...r.sources]
                        .filter((s) => s.pass === 1)
                        .sort((a, b) => b.confidence - a.confidence)[0];
                    return { code: r.code, stripKey: src?.stripKey ?? null };
                });

            // 2) 补漏：整条都没出现的题，位置未知，按批内序号估段
            const seen = new Set(hitsRef.current.map((h) => h.code));
            const missing = itemsRef.current
                .map((item, order) => ({ code: String(item.shortCode || ""), order }))
                .filter((x) => x.code && !seen.has(x.code) && !reviewedRef.current.has(x.code));

            const tasks = planReview({
                uncertain,
                missing,
                strips: stripsRef.current.map((s) => ({ key: s.key })),
                itemCount: itemsRef.current.length,
                maxStrips: REVIEW_MAX_STRIPS,
                maxCodes: REVIEW_MAX_CODES,
            });
            const plan = tasks
                .map((t) => ({ strip: stripsRef.current.find((s) => s.key === t.stripKey), codes: t.codes }))
                .filter((p): p is { strip: Strip; codes: string[] } => !!p.strip);

            if (!plan.length) return;

            const total = plan.reduce((n, p) => n + p.codes.length, 0);
            setReviewState({ running: true, done: 0, total });
            setHint(`二次确认 ${total} 道把握不足或漏掉的题…`);

            const candidates = itemsRef.current
                .filter((i) => i.shortCode)
                .map((i) => ({ code: String(i.shortCode), answer: String(i.answerText || "") }));

            let done = 0;
            const worker = async (slot: { strip: Strip; codes: string[] }) => {
                for (const code of slot.codes) reviewedRef.current.add(code);
                try {
                    const page = pagesRef.current.find((p) => p.id === slot.strip.pageId);
                    if (!page) return;
                    const img = await zoomCrop(page.dataUrl, slot.strip.y0, slot.strip.y1);
                    const res = await apiClient.post<{ results: ScanRow[] }>(
                        "/api/grade-page",
                        { imageBase64: img, candidates, focusCodes: slot.codes },
                        { timeout: 120000 },
                    );
                    if (seq !== seqRef.current) return;
                    const want = new Set(slot.codes);
                    const second: ScanHit[] = (res.results || [])
                        .filter((r) => want.has(r.code))
                        .map((r) => ({
                            code: r.code,
                            verdict: r.verdict,
                            studentAnswer: r.studentAnswer,
                            confidence: r.confidence,
                            stripKey: `${slot.strip.key}:r2`,
                            pageId: slot.strip.pageId,
                            pass: 2 as const,
                        }));
                    addHits(second);
                    done += slot.codes.length;
                    setReviewedCount((n) => n + second.length);
                    setReviewState((prev) => (prev ? { ...prev, done } : prev));
                } catch {
                    // 复核失败不影响首轮结果，那几道题就留着「待确认」
                    done += slot.codes.length;
                    setReviewState((prev) => (prev ? { ...prev, done } : prev));
                }
            };

            // 复核最多 3 段，一次性全发：多等一轮就多 4 秒，而这本来就是兜底
            const queue = [...plan];
            await Promise.all(
                Array.from({ length: queue.length }, async () => {
                    for (;;) {
                        const slot = queue.shift();
                        if (!slot) return;
                        await worker(slot);
                    }
                }),
            );

            if (seq !== seqRef.current) return;
            setReviewState(null);
            setElapsed(Date.now() - startedRef.current);
            setHint("");
        },
        [addHits],
    );

    /** 并发跑一批段，边跑边把结果塞进列表 */
    const runStrips = useCallback(
        async (list: Strip[], seq: number) => {
            if (!list.length) return;
            const queue = [...list];
            const total = queue.length;
            let done = 0;
            const candidates = itemsRef.current
                .filter((i) => i.shortCode)
                .map((i) => ({ code: String(i.shortCode), answer: String(i.answerText || "") }));

            const worker = async () => {
                for (;;) {
                    const strip = queue.shift();
                    if (!strip) return;
                    if (seq !== seqRef.current) return;
                    const t0 = performance.now();
                    setStrips((prev) =>
                        prev.map((x) => (x.key === strip.key ? { ...x, state: "run" } : x)),
                    );
                    try {
                        const res = await apiClient.post<{ results: ScanRow[] }>(
                            "/api/grade-page",
                            { imageBase64: strip.dataUrl, candidates },
                            { timeout: 120000 },
                        );
                        if (seq !== seqRef.current) return;
                        const found = res.results || [];
                        addHits(
                            found.map((r) => ({
                                code: r.code,
                                verdict: r.verdict,
                                studentAnswer: r.studentAnswer,
                                confidence: r.confidence,
                                stripKey: strip.key,
                                pageId: strip.pageId,
                                pass: 1 as const,
                            })),
                        );
                        setStrips((prev) =>
                            prev.map((x) =>
                                x.key === strip.key
                                    ? { ...x, state: "ok", ms: Math.round(performance.now() - t0), found: found.length }
                                    : x,
                            ),
                        );
                    } catch (e) {
                        if (seq !== seqRef.current) return;
                        setStrips((prev) =>
                            prev.map((x) => (x.key === strip.key ? { ...x, state: "err", ms: Math.round(performance.now() - t0) } : x)),
                        );
                        setError(e instanceof Error ? e.message : "识别失败");
                    } finally {
                        done++;
                        if (seq === seqRef.current) {
                            setHint(`识别中 ${done}/${total} 段…`);
                        }
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
            if (seq !== seqRef.current) return;
            setElapsed(Date.now() - startedRef.current);
            setHint("");
            await runReview(seq);
        },
        [addHits, runReview],
    );

    /** 选到照片后立刻开始：压缩 → 切段 → 并发识别 */
    const addFiles = async (files: FileList | null) => {
        if (!files?.length) return;
        const picked = Array.from(files).slice(0, 4);
        setError("");
        setPreparing(true);
        setHint("正在切分试卷…");
        try {
            const seq = ++seqRef.current;
            startedRef.current = startedRef.current || Date.now();
            const fresh: ScanPhoto[] = [];
            const freshStrips: Strip[] = [];
            for (const file of picked) {
                const dataUrl = await compressImage(file, 2.2, 2000, 0.86);
                const page = { id: `${Date.now()}-${fresh.length}`, dataUrl };
                fresh.push(page);
                const parts = await splitForScan(dataUrl);
                parts.forEach((p, i) => {
                    freshStrips.push({
                        key: `${page.id}-${i}`,
                        pageId: page.id,
                        index: i,
                        dataUrl: p.dataUrl,
                        y0: p.y0,
                        y1: p.y1,
                        state: "wait",
                    });
                });
            }
            pagesRef.current = [...pagesRef.current, ...fresh];
            stripsRef.current = [...stripsRef.current, ...freshStrips];
            setPages(pagesRef.current);
            setStrips(stripsRef.current);
            setHint(`已切成 ${freshStrips.length} 段，并发识别中…`);
            // 只跑新加的段，之前几页的结果保持不变
            void runStrips(freshStrips, seq);
        } catch (e) {
            setError(e instanceof Error ? e.message : "图片处理失败");
            setHint("");
        } finally {
            setPreparing(false);
        }
    };

    const resetResults = () => {
        hitsRef.current = [];
        reviewedRef.current = new Set();
        setHits([]);
        setOverrides({});
        setElapsed(null);
        setReviewState(null);
        setReviewedCount(0);
        setOnlyTodo(false);
        setError("");
    };

    /** 整批重来：丢弃所有结果，重新切分所有页 */
    const rerunAll = async () => {
        if (!pagesRef.current.length) return;
        const seq = ++seqRef.current;
        startedRef.current = Date.now();
        resetResults();
        setStrips([]);
        setPreparing(true);
        setHint("重新切分…");
        try {
            const next: Strip[] = [];
            for (const page of pagesRef.current) {
                const parts = await splitForScan(page.dataUrl);
                parts.forEach((p, i) => {
                    next.push({
                        key: `${page.id}-${Date.now()}-${i}`,
                        pageId: page.id,
                        index: i,
                        dataUrl: p.dataUrl,
                        y0: p.y0,
                        y1: p.y1,
                        state: "wait",
                    });
                });
            }
            stripsRef.current = next;
            setStrips(next);
            setPreparing(false);
            setHint(`已切成 ${next.length} 段，并发识别中…`);
            await runStrips(next, seq);
        } catch {
            setPreparing(false);
            setError("处理失败，请重新拍照");
        }
    };

    const removePage = (id: string) => {
        seqRef.current++;
        pagesRef.current = pagesRef.current.filter((p) => p.id !== id);
        stripsRef.current = stripsRef.current.filter((s) => s.pageId !== id);
        setPages(pagesRef.current);
        setStrips(stripsRef.current);
        resetResults();
        setHint("");
    };

    const apply = () => {
        const usable = rows.filter((r) => r.id);
        if (!usable.length) return;
        const payload = usable.map((r) => ({
            id: r.id,
            result: r.verdict,
            confidence: r.confidence,
            studentAnswer: r.studentAnswer,
        }));
        try {
            sessionStorage.setItem(SCAN_KEY, JSON.stringify(payload));
        } catch {
            /* 隐私模式下不持久，仍可直接跳转 */
        }
        router.push(`/grade?ids=${items.map((i) => i.id).join(",")}`);
    };

    const running = strips.some((s) => s.state === "run" || s.state === "wait") || !!reviewState?.running;
    const okStrips = strips.filter((s) => s.state === "ok").length;
    const errStrips = strips.filter((s) => s.state === "err").length;
    const highConf = rows.filter((r) => r.matched && r.confidence >= REVIEW_THRESHOLD).length;
    const todo = rows.filter((r) => r.needsReview);
    const conflictCount = rows.filter((r) => r.conflict && !r.overridden).length;

    /**
     * 这批卷子里还没被识别出来的题。多半是作答框空白（模型容易整条跳过），
     * 也可能是那一页没拍到。不自动判，但给一个一键标记的入口，省得逐题点。
     */
    const missing = useMemo(() => {
        const seen = new Set(rows.map((r) => r.code));
        return items.filter((i) => i.shortCode && !seen.has(String(i.shortCode)));
    }, [items, rows]);

    const markMissingAsSkip = () => {
        const add: ScanHit[] = missing.map((i) => ({
            code: String(i.shortCode),
            verdict: "skip",
            studentAnswer: "",
            confidence: 1,
            stripKey: "manual",
            pageId: "manual",
            pass: 1,
        }));
        addHits(add);
    };

    const orderOf = useCallback(
        (code: string) => {
            const i = items.findIndex((x) => String(x.shortCode || "") === code);
            return i < 0 ? 9999 : i;
        },
        [items],
    );
    const sortedRows = useMemo(() => {
        const list = onlyTodo ? rows.filter((r) => r.needsReview) : rows;
        return [...list].sort((a, b) => orderOf(a.code) - orderOf(b.code));
    }, [rows, onlyTodo, orderOf]);

    const setVerdict = (code: string, v: Verdict) =>
        setOverrides((prev) => ({ ...prev, [code]: v }));

    /**
     * 标准答案也要摆出来。模型读错一个字母（D 读成 B）时置信度照样很高，
     * 只有把「学生写 B / 标准 D」并排放，人才一眼看得出是误读还是真错。
     */
    const standardOf = (code: string) => {
        const item = items.find((i) => String(i.shortCode || "") === code);
        const ans = (item?.answerText || "").replace(/\s+/g, " ").trim();
        if (!ans) return "";
        return ans.length > 60 ? `${ans.slice(0, 60)}…` : ans;
    };

    return (
        <div className="min-h-screen bg-slate-50 pb-28">
            <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b px-3 py-2 flex items-center gap-3">
                <BackButton fallbackUrl="/notebooks" />
                <div className="flex-1">
                    <div className="font-bold leading-tight">拍照批改</div>
                    <div className="text-[11px] text-muted-foreground">
                        拍整页试卷 · 自动切段并发识别
                    </div>
                </div>
            </div>

            <div className="max-w-3xl mx-auto px-3 py-3 space-y-3">
                {/* 拍照和选相册分开两个 input：带 capture 的 input 会强制调相机，multiple 会失效 */}
                <input
                    ref={camRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                        void addFiles(e.target.files);
                        e.currentTarget.value = "";
                    }}
                />
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        void addFiles(e.target.files);
                        e.currentTarget.value = "";
                    }}
                />

                {pages.length === 0 ? (
                    <div className="w-full rounded-xl border-2 border-dashed border-slate-300 bg-white py-10 px-4 flex flex-col items-center gap-3">
                        <span className="text-3xl">📷</span>
                        <span className="text-sm font-semibold text-slate-700">拍整页试卷，自动判分</span>
                        <span className="text-xs text-slate-400 text-center leading-relaxed">
                            拍正、光照均匀，编号和作答框都要看清。
                            整页会被切成几段并发识别，比一次读全页快一倍。
                        </span>
                        <div className="flex gap-2 w-full max-w-xs mt-1">
                            <button
                                onClick={() => camRef.current?.click()}
                                className="flex-1 rounded-lg bg-slate-900 text-white py-2.5 text-sm font-semibold"
                            >
                                拍照
                            </button>
                            <button
                                onClick={() => fileRef.current?.click()}
                                className="flex-1 rounded-lg border bg-white py-2.5 text-sm"
                            >
                                相册（可多页）
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-2">
                            {pages.map((p) => (
                                <div key={p.id} className="relative rounded-xl overflow-hidden border bg-white">
                                    <img src={p.dataUrl} alt="试卷" className="w-full h-40 object-cover object-top" />
                                    <button
                                        onClick={() => removePage(p.id)}
                                        aria-label="移除这页"
                                        className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/55 text-white text-xs leading-none"
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                            {pages.length < 4 && (
                                <button
                                    onClick={() => fileRef.current?.click()}
                                    disabled={preparing}
                                    className="rounded-xl border-2 border-dashed border-slate-300 bg-white h-40 flex flex-col items-center justify-center gap-1 text-slate-500 disabled:opacity-50"
                                >
                                    <span className="text-xl">＋</span>
                                    <span className="text-xs">再加一页</span>
                                </button>
                            )}
                        </div>

                        <div className="flex gap-2">
                            <button
                                onClick={() => camRef.current?.click()}
                                disabled={preparing}
                                className="flex-1 rounded-lg border bg-white py-2.5 text-sm disabled:opacity-50"
                            >
                                重拍
                            </button>
                            <button
                                onClick={rerunAll}
                                disabled={preparing || running}
                                className="flex-[2] rounded-lg bg-slate-900 text-white py-2.5 text-sm font-semibold disabled:opacity-50"
                            >
                                {preparing ? "处理中…" : running ? "识别中…" : "重新识别"}
                            </button>
                        </div>

                        {/* 分段进度：让用户看到「不是卡住了，是在并行跑」 */}
                        {strips.length > 0 && (
                            <div className="flex items-center gap-1.5 flex-wrap px-1">
                                {strips.map((s) => (
                                    <span
                                        key={s.key}
                                        title={s.state === "ok" ? `识别到 ${s.found ?? 0} 道 · ${s.ms}ms` : undefined}
                                        className={`h-1.5 rounded-full transition-all ${
                                            s.state === "ok"
                                                ? "w-6 bg-green-500"
                                                : s.state === "err"
                                                    ? "w-6 bg-red-400"
                                                    : s.state === "run"
                                                        ? "w-6 bg-slate-800 animate-pulse"
                                                        : "w-6 bg-slate-200"
                                        }`}
                                    />
                                ))}
                                <span className="text-[11px] text-slate-500 ml-1">
                                    {okStrips}/{strips.length} 段
                                    {errStrips > 0 ? ` · ${errStrips} 段失败` : ""}
                                    {elapsed ? ` · 用时 ${(elapsed / 1000).toFixed(1)} 秒` : ""}
                                    {reviewState?.running ? ` · 复核 ${reviewState.done}/${reviewState.total}` : ""}
                                </span>
                            </div>
                        )}
                    </>
                )}

                {(hint || error) && (
                    <p className={`text-xs px-1 ${error ? "text-red-600" : "text-muted-foreground"}`}>
                        {error || hint}
                    </p>
                )}

                {!running && rows.length > 0 && (
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                        识别到 {rows.length} 道题，{highConf} 道高置信
                        {reviewedCount > 0 ? ` · 复核过 ${reviewedCount} 道` : ""}
                        {conflictCount > 0 ? ` · ${conflictCount} 道两次判定不一致` : ""}
                    </div>
                )}

                {/* 待确认清单：低置信 + 冲突，一条条走完比事后在批改页发现错判省事 */}
                {!running && todo.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
                        <span className="flex-1 leading-relaxed">
                            {todo.length} 道需要你确认
                            {conflictCount > 0 ? `（${conflictCount} 道两次识别结论相反）` : "（识别把握不足）"}
                        </span>
                        <button
                            onClick={() => setOnlyTodo((v) => !v)}
                            className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 font-semibold"
                        >
                            {onlyTodo ? "看全部" : "只看这些"}
                        </button>
                    </div>
                )}

                {!running && rows.length > 0 && missing.length > 0 && (
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 flex items-center gap-2">
                        <span className="flex-1 leading-relaxed">
                            还有 {missing.length} 道没识别到：多半是作答框空白，也可能这页没拍到
                        </span>
                        <button
                            onClick={markMissingAsSkip}
                            className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 font-semibold"
                        >
                            标为没做
                        </button>
                    </div>
                )}

                {sortedRows.length > 0 && (
                    <div className="space-y-2">
                        <div className="text-xs text-muted-foreground px-1">
                            逐条核对，判定错了直接点按钮改，改完应用
                        </div>
                        {sortedRows.map((r, index) => (
                            <div
                                key={`${r.code}-${index}`}
                                className={`rounded-lg border bg-white p-2.5 ${
                                    r.needsReview ? "border-amber-300" : ""
                                }`}
                            >
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-[10px] text-slate-400">#{r.code}</span>
                                    <span className="text-xs font-semibold">{r.label}</span>
                                    {!r.matched && (
                                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                                            库里没有这个号
                                        </span>
                                    )}
                                    {r.localChecked && (
                                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                            选择题核对
                                        </span>
                                    )}
                                    {r.multiPage && (
                                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600">
                                            两页都有
                                        </span>
                                    )}
                                    {r.corrected && (
                                        <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] text-orange-700">
                                            复核改判
                                        </span>
                                    )}
                                    {r.verified && !r.conflict && (
                                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
                                            复核一致
                                        </span>
                                    )}
                                    {r.reviewedBlank && (
                                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                            复核确认空白
                                        </span>
                                    )}
                                    {r.needsReview && (
                                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                                            待确认
                                        </span>
                                    )}
                                    <span className={`ml-auto text-[10px] ${r.confidence >= REVIEW_THRESHOLD ? "text-slate-400" : "text-amber-600"}`}>
                                        置信 {Math.round(r.confidence * 100)}%
                                        {r.sources.length > 1 ? ` · ${r.sources.length} 处看到` : ""}
                                    </span>
                                </div>
                                {r.conflict && !r.overridden && (
                                    <p className="mt-1 text-[11px] text-red-600">
                                        两处识别结论相反（
                                        {[...new Set(r.sources.map((s) => VERDICT_TEXT[s.verdict]))].join(" / ")}
                                        ），请看一眼卷面再定
                                    </p>
                                )}
                                {r.studentAnswer && (
                                    <p className="mt-1 text-xs text-slate-600 line-clamp-2">学生写：{r.studentAnswer}</p>
                                )}
                                {standardOf(r.code) && (
                                    <p className="mt-0.5 text-[11px] text-slate-400 line-clamp-1">标准：{standardOf(r.code)}</p>
                                )}
                                <div className="mt-1.5 flex gap-1.5">
                                    {(["correct", "wrong", "skip"] as Verdict[]).map((v) => (
                                        <button
                                            key={v}
                                            onClick={() => setVerdict(r.code, v)}
                                            className={`flex-1 rounded-md border py-1.5 text-xs font-semibold ${
                                                r.verdict === v
                                                    ? v === "correct"
                                                        ? "bg-green-600 border-green-600 text-white"
                                                        : v === "wrong"
                                                            ? "bg-red-600 border-red-600 text-white"
                                                            : "bg-slate-700 border-slate-700 text-white"
                                                    : "bg-white text-slate-600"
                                            }`}
                                        >
                                            {VERDICT_TEXT[v]}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {rows.length > 0 && (
                <div className="fixed bottom-0 left-0 right-0 border-t bg-background px-3 py-2.5 pb-[calc(10px+env(safe-area-inset-bottom))]">
                    <div className="max-w-3xl mx-auto flex gap-2">
                        <div className="flex-1 text-xs text-slate-500 self-center">
                            可用 {rows.filter((r) => r.id).length} / {rows.length} 条
                            {todo.length > 0 ? ` · ${todo.length} 道待确认` : ""}
                        </div>
                        <button
                            onClick={apply}
                            disabled={!rows.some((r) => r.id)}
                            className="rounded-lg bg-slate-900 text-white px-5 py-2.5 text-sm font-semibold disabled:opacity-40"
                        >
                            应用到批改
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function ScanPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>}>
            <ScanContent />
        </Suspense>
    );
}
