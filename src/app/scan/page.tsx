"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { apiClient } from "@/lib/api-client";
import { compressImage } from "@/lib/image-utils";
import { AttemptResult, ErrorItem } from "@/types/api";

const SCAN_KEY = "wq:scan-results";

type ScanRow = {
    code: string;
    matched: boolean;
    verdict: AttemptResult;
    studentAnswer: string;
    confidence: number;
};

type Row = ScanRow & { id: string; label: string; localChecked?: boolean };

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

function ScanContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const fileRef = useRef<HTMLInputElement>(null);
    const [items, setItems] = useState<ErrorItem[]>([]);
    const [image, setImage] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [rows, setRows] = useState<Row[]>([]);
    const [error, setError] = useState("");

    useEffect(() => {
        const ids = (searchParams.get("ids") || "").split(",").filter(Boolean);
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
    }, [searchParams]);

    const pickFile = async (file?: File | null) => {
        if (!file) return;
        setError("");
        setBusy(true);
        setStatus("正在压缩照片…");
        try {
            const base64 = await compressImage(file, 1.5, 2000, 0.85);
            setImage(base64);
            setRows([]);
            setStatus("");
        } catch (e) {
            setError(e instanceof Error ? e.message : "图片处理失败");
        } finally {
            setBusy(false);
        }
    };

    const recognize = async () => {
        if (!image) return;
        setBusy(true);
        setError("");
        setStatus("正在识别题号与作答，大约 10-20 秒…");
        try {
            const candidates = items
                .filter((i) => i.shortCode)
                .map((i) => ({ code: String(i.shortCode), answer: String(i.answerText || "") }));
            const res = await apiClient.post<{ results: ScanRow[] }>(
                "/api/grade-page",
                { imageBase64: image, candidates },
                { timeout: 150000 },
            );
            const byCode = new Map(items.map((i) => [String(i.shortCode || ""), i]));
            const mapped: Row[] = (res.results || []).map((r, index) => {
                const hit = byCode.get(r.code);
                // 选择题本地定论优先于模型判断
                const local = hit ? localChoiceVerdict(r.studentAnswer, String(hit.answerText || "")) : null;
                return {
                    ...r,
                    verdict: local ?? r.verdict,
                    localChecked: !!local,
                    id: hit?.id || "",
                    label: hit ? `第 ${items.findIndex((i) => i.id === hit.id) + 1} 题` : `未匹配 ${index + 1}`,
                };
            });
            setRows(mapped);
            setStatus(
                mapped.length
                    ? `识别到 ${mapped.length} 道题，其中 ${mapped.filter((r) => r.matched && r.confidence >= 0.6).length} 道高置信`
                    : "没有识别到题号，请确认照片里能看到 # 开头的编号",
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : "识别失败");
            setStatus("");
        } finally {
            setBusy(false);
        }
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
        const ids = items.map((i) => i.id).join(",");
        router.push(`/grade?ids=${ids}`);
    };

    return (
        <div className="min-h-screen bg-slate-50 pb-28">
            <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b px-3 py-2 flex items-center gap-3">
                <BackButton fallbackUrl="/notebooks" />
                <div className="flex-1">
                    <div className="font-bold leading-tight">拍照批改</div>
                    <div className="text-[11px] text-muted-foreground">
                        拍整页试卷，自动读题号与作答
                    </div>
                </div>
            </div>

            <div className="max-w-3xl mx-auto px-3 py-3 space-y-3">
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => pickFile(e.target.files?.[0])}
                />

                {!image ? (
                    <button
                        onClick={() => fileRef.current?.click()}
                        className="w-full rounded-xl border-2 border-dashed border-slate-300 bg-white py-16 flex flex-col items-center gap-2"
                    >
                        <span className="text-3xl">📷</span>
                        <span className="text-sm font-semibold text-slate-700">拍照 / 从相册选择</span>
                        <span className="text-xs text-slate-400 px-8 text-center leading-relaxed">
                            整页拍进去，尽量拍正、光照均匀；编号和作答框要都能看清
                        </span>
                    </button>
                ) : (
                    <>
                        <div className="rounded-xl overflow-hidden border bg-white">
                            <img src={image} alt="试卷" className="w-full h-auto max-h-[52vh] object-contain" />
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => fileRef.current?.click()}
                                className="flex-1 rounded-lg border bg-white py-2.5 text-sm"
                            >
                                重拍
                            </button>
                            <button
                                onClick={recognize}
                                disabled={busy}
                                className="flex-[2] rounded-lg bg-slate-900 text-white py-2.5 text-sm font-semibold disabled:opacity-50"
                            >
                                {busy ? "识别中…" : "开始识别"}
                            </button>
                        </div>
                    </>
                )}

                {status && <p className="text-xs text-muted-foreground px-1">{status}</p>}
                {error && <p className="text-xs text-red-600 px-1">{error}</p>}

                {rows.length > 0 && (
                    <div className="space-y-2">
                        <div className="text-xs text-muted-foreground px-1">
                            逐条核对，判定错了直接点按钮改，改完应用
                        </div>
                        {rows.map((r, index) => (
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
                                                    prev.map((x, i) => (i === index ? { ...x, verdict: v } : x)),
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
