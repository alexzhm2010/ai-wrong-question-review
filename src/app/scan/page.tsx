"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import { compressImage } from "@/lib/image-utils";
import { splitForScan } from "@/lib/scan-split";
import { AttemptResult, ErrorItem } from "@/types/api";

const SCAN_KEY = "wq:scan-results";
/** 同时发几段。段数固定不超过 4，所以基本是一轮发完，墙钟≈最慢那一段 */
const CONCURRENCY = 4;

type ScanRow = {
    code: string;
    matched: boolean;
    verdict: AttemptResult;
    studentAnswer: string;
    confidence: number;
};

type Row = ScanRow & { id: string; label: string; localChecked?: boolean };

type ScanPhoto = { id: string; dataUrl: string };

type Strip = {
    key: string;
    pageId: string;
    index: number;
    dataUrl: string;
    state: "wait" | "run" | "ok" | "err";
    ms?: number;
    found?: number;
};

const VERDICT_LABEL: Record<AttemptResult, string> = { correct: "对", wrong: "错", skip: "没做" };

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

/** 同一编号可能出现在两段的重叠区，也可能因为重拍出现两次：留置信度高的那条 */
function mergeRows(prev: Row[], incoming: Row[]): Row[] {
    const byCode = new Map<string, Row>();
    for (const r of [...prev, ...incoming]) {
        const old = byCode.get(r.code);
        if (!old || r.confidence > old.confidence) byCode.set(r.code, r);
    }
    return [...byCode.values()];
}

function ScanContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const fileRef = useRef<HTMLInputElement>(null);
    const camRef = useRef<HTMLInputElement>(null);

    const [items, setItems] = useState<ErrorItem[]>([]);
    const [pages, setPages] = useState<ScanPhoto[]>([]);
    const [strips, setStrips] = useState<Strip[]>([]);
    const [rows, setRows] = useState<Row[]>([]);
    const [preparing, setPreparing] = useState(false);
    const [elapsed, setElapsed] = useState<number | null>(null);
    const [error, setError] = useState("");
    const [hint, setHint] = useState("");

    // 重拍到第 N 张时，前面几张的结果还在路上，序号用来丢弃过期结果
    const seqRef = useRef(0);
    const startedRef = useRef(0);
    const itemsRef = useRef<ErrorItem[]>([]);
    itemsRef.current = items;

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

    const toRow = useCallback((r: ScanRow, index: number): Row => {
        const list = itemsRef.current;
        const hit = list.find((i) => String(i.shortCode || "") === r.code);
        // 选择题本地定论优先于模型判断
        const local = hit ? localChoiceVerdict(r.studentAnswer, String(hit.answerText || "")) : null;
        return {
            ...r,
            verdict: local ?? r.verdict,
            localChecked: !!local,
            id: hit?.id || "",
            label: hit ? `第 ${list.findIndex((i) => i.id === hit.id) + 1} 题` : `未匹配 ${index + 1}`,
        };
    }, []);

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
                        const mapped = (res.results || []).map((r, i) => toRow(r, i));
                        setRows((prev) => mergeRows(prev, mapped));
                        setStrips((prev) =>
                            prev.map((x) =>
                                x.key === strip.key
                                    ? { ...x, state: "ok", ms: Math.round(performance.now() - t0), found: mapped.length }
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
        },
        [toRow],
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
                        state: "wait",
                    });
                });
            }
            setPages((prev) => [...prev, ...fresh]);
            setStrips((prev) => [...prev, ...freshStrips]);
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

    /** 整批重来：丢弃所有结果，重新切分所有页 */
    const rerunAll = async () => {
        if (!pages.length) return;
        const seq = ++seqRef.current;
        startedRef.current = Date.now();
        setRows([]);
        setElapsed(null);
        setError("");
        setStrips([]);
        setPreparing(true);
        setHint("重新切分…");
        try {
            const next: Strip[] = [];
            for (const page of pages) {
                const parts = await splitForScan(page.dataUrl);
                parts.forEach((p, i) => {
                    next.push({ key: `${page.id}-${Date.now()}-${i}`, pageId: page.id, index: i, dataUrl: p.dataUrl, state: "wait" });
                });
            }
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
        setPages((prev) => prev.filter((p) => p.id !== id));
        setStrips((prev) => prev.filter((s) => s.pageId !== id));
        setRows([]);
        setElapsed(null);
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

    const running = strips.some((s) => s.state === "run" || s.state === "wait");
    const okStrips = strips.filter((s) => s.state === "ok").length;
    const errStrips = strips.filter((s) => s.state === "err").length;
    const highConf = rows.filter((r) => r.matched && r.confidence >= 0.6).length;

    /**
     * 这批卷子里还没被识别出来的题。多半是作答框空白（模型容易整条跳过），
     * 也可能是那一页没拍到。不自动判，但给一个一键标记的入口，省得逐题点。
     */
    const missing = useMemo(() => {
        const seen = new Set(rows.map((r) => r.code));
        return items.filter((i) => i.shortCode && !seen.has(String(i.shortCode)));
    }, [items, rows]);

    const markMissingAsSkip = () => {
        const add: Row[] = missing.map((i) => ({
            code: String(i.shortCode),
            matched: true,
            verdict: "skip",
            studentAnswer: "",
            confidence: 1,
            id: i.id,
            label: `第 ${items.findIndex((x) => x.id === i.id) + 1} 题`,
        }));
        setRows((prev) => mergeRows(prev, add));
    };

    const orderOf = useCallback(
        (code: string) => {
            const i = items.findIndex((x) => String(x.shortCode || "") === code);
            return i < 0 ? 9999 : i;
        },
        [items],
    );
    const sortedRows = useMemo(
        () => [...rows].sort((a, b) => orderOf(a.code) - orderOf(b.code)),
        [rows, orderOf],
    );

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
                        识别到 {rows.length} 道题，其中 {highConf} 道高置信；
                        识别不到的可以手动补，或直接在批改页点。
                    </div>
                )}

                {!running && rows.length > 0 && missing.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center gap-2">
                        <span className="flex-1 leading-relaxed">
                            还有 {missing.length} 道没识别到：多半是作答框空白，也可能这页没拍到
                        </span>
                        <button
                            onClick={markMissingAsSkip}
                            className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 font-semibold"
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
                            <div key={`${r.code}-${index}`} className="rounded-lg border bg-white p-2.5">
                                <div className="flex items-center gap-2">
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
                                    <span className={`ml-auto text-[10px] ${r.confidence >= 0.6 ? "text-slate-400" : "text-amber-600"}`}>
                                        置信 {Math.round(r.confidence * 100)}%
                                    </span>
                                </div>
                                {r.studentAnswer && (
                                    <p className="mt-1 text-xs text-slate-600 line-clamp-2">学生写：{r.studentAnswer}</p>
                                )}
                                <div className="mt-1.5 flex gap-1.5">
                                    {(["correct", "wrong", "skip"] as AttemptResult[]).map((v) => (
                                        <button
                                            key={v}
                                            onClick={() =>
                                                setRows((prev) =>
                                                    prev.map((x) => (x.code === r.code ? { ...x, verdict: v } : x)),
                                                )
                                            }
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
                                            {VERDICT_LABEL[v]}
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
