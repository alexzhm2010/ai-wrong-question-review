"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { ReferenceAnswer } from "@/components/reference-answer";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { imageSrc } from "@/lib/storage";
import { scoreMood } from "@/lib/paper-score";
import { MARK_HOME } from "@/lib/navigation";

type PaperItem = {
    errorItemId: string;
    orderIndex: number;
    shortCode: string;
    answer: string;
    imageUrl: string;
    questionText: string;
    verdict: string | null;
};
type Paper = {
    code: string;
    paperNo: string;
    subjectNames: string;
    itemCount: number;
    score: number | null;
    correctCount: number | null;
    submittedAt: string | null;
    items: PaperItem[];
};
type Verdict = "correct" | "wrong" | "blank";

const VERDICTS: { key: Verdict; label: string; active: string }[] = [
    { key: "correct", label: "对", active: "bg-emerald-600 border-emerald-600 text-white" },
    { key: "wrong", label: "错", active: "bg-rose-600 border-rose-600 text-white" },
    { key: "blank", label: "未做", active: "bg-slate-700 border-slate-700 text-white" },
];

function MarkContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const code = (searchParams.get("c") || "").trim();

    /** 批改流程的统一出口：返回箭头、出错态、结果页都回批改中心 */
    const backToCenter = () => router.push(MARK_HOME);

    const [paper, setPaper] = useState<Paper | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [choices, setChoices] = useState<Record<string, Verdict>>({});
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<{ score: number; correctCount: number; total: number } | null>(null);
    const [submitError, setSubmitError] = useState("");

    useEffect(() => {
        if (!code) {
            setLoadError("缺少试卷编号，请重新扫描卷子右上角的二维码。");
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        apiClient
            .get<Paper>(`/api/paper/read?c=${encodeURIComponent(code)}`)
            .then((p) => {
                if (cancelled) return;
                setPaper(p);
                // 若之前提交过，用上次的判定预填，方便二次批改只改错的
                const prefilled: Record<string, Verdict> = {};
                for (const it of p.items || []) {
                    if (it.verdict === "correct" || it.verdict === "wrong" || it.verdict === "blank") {
                        prefilled[it.errorItemId] = it.verdict as Verdict;
                    }
                }
                setChoices(prefilled);
                if (p.score !== null && p.score !== undefined) {
                    setResult({ score: p.score, correctCount: p.correctCount || 0, total: p.itemCount });
                }
            })
            .catch((e) => {
                if (cancelled) return;
                const msg = String(e?.message || "");
                setLoadError(
                    msg.includes("PAPER_NOT_FOUND")
                        ? "找不到这张试卷，可能编号有误或已被清理。请确认扫的是本卷的二维码。"
                        : "加载试卷失败，请检查网络后重试。",
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [code]);

    const items = paper?.items || [];
    const judgedCount = items.filter((it) => choices[it.errorItemId]).length;
    const allJudged = items.length > 0 && judgedCount === items.length;

    const pick = (id: string, v: Verdict) => {
        setSubmitError("");
        setChoices((prev) => ({ ...prev, [id]: v }));
    };

    const submit = async () => {
        if (!allJudged || submitting || !paper) return;
        setSubmitting(true);
        setSubmitError("");
        try {
            const res = await apiClient.post<{ score: number; correctCount: number; total: number }>(
                "/api/paper/submit",
                {
                    code: paper.code,
                    results: items.map((it) => ({
                        errorItemId: it.errorItemId,
                        verdict: choices[it.errorItemId] || "wrong",
                    })),
                },
            );
            setResult({ score: res.score, correctCount: res.correctCount, total: res.total });
            window.scrollTo({ top: 0, behavior: "smooth" });
        } catch {
            setSubmitError("提交失败，请稍后重试。");
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
                正在加载试卷…
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="text-4xl">📄</div>
                <p className="text-sm text-foreground/80">{loadError}</p>
                <button
                    type="button"
                    onClick={backToCenter}
                    className="rounded-lg border bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
                >
                    返回批改中心
                </button>
            </div>
        );
    }

    if (!paper) return null;

    const mood = result ? scoreMood(result.score) : null;

    return (
        <div className="min-h-screen bg-slate-50 pb-28">
            {/* 顶栏 */}
            <div className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
                <div className="max-w-2xl mx-auto px-3 py-2.5 flex items-center gap-2.5">
                    <BackButton fallbackUrl={MARK_HOME} />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold leading-tight">扫码批改</div>
                        <div className="text-[11px] text-muted-foreground leading-tight truncate">
                            卷号 {paper.paperNo || paper.code.slice(0, 12)}
                            {paper.subjectNames ? ` · ${paper.subjectNames}` : ""}
                        </div>
                    </div>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                        {judgedCount}/{items.length}
                    </span>
                </div>
            </div>

            <div className="max-w-2xl mx-auto px-3 py-4 space-y-3">
                <div className="rounded-lg border bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                    对照纸上的作答，逐题判断<span className="font-semibold">对 / 错 / 未做</span>
                    ，全部判完点底部提交。结果会自动记入错题本并更新掌握度。
                </div>

                {items.map((it, i) => {
                    const chosen = choices[it.errorItemId];
                    return (
                        <div key={it.errorItemId} className="rounded-xl border bg-white p-3 space-y-2.5">
                            <div className="flex items-center gap-2">
                                <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-white">
                                    第 {i + 1} 题
                                </span>
                                <span className="font-mono text-[11px] tracking-wide text-slate-500">
                                    #{it.shortCode || it.errorItemId.slice(-8)}
                                </span>
                                {chosen && (
                                    <span
                                        className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                            chosen === "correct"
                                                ? "bg-emerald-50 text-emerald-700"
                                                : chosen === "wrong"
                                                    ? "bg-rose-50 text-rose-700"
                                                    : "bg-slate-100 text-slate-600"
                                        }`}
                                    >
                                        {VERDICTS.find((v) => v.key === chosen)?.label}
                                    </span>
                                )}
                            </div>

                            {/* 题目截图 */}
                            {it.imageUrl ? (
                                <img
                                    src={imageSrc(it.imageUrl)}
                                    alt={`第 ${i + 1} 题`}
                                    className="w-full rounded border bg-white"
                                    loading="lazy"
                                />
                            ) : it.questionText ? (
                                <div className="rounded bg-slate-50 p-2 text-xs leading-relaxed whitespace-pre-wrap">
                                    {it.questionText}
                                </div>
                            ) : (
                                <div className="rounded bg-slate-50 p-3 text-center text-xs text-slate-400">
                                    该题无截图
                                </div>
                            )}

                            {/* 标准答案 */}
                            <div className="rounded-lg bg-amber-50/70 px-2.5 py-2">
                                <div className="mb-0.5 text-[10px] font-semibold text-amber-700">参考答案</div>
                                <div className="text-sm text-slate-800">
                                    <ReferenceAnswer text={it.answer || "（暂无答案）"} />
                                </div>
                            </div>

                            {/* 判定按钮 */}
                            <div className="grid grid-cols-3 gap-2">
                                {VERDICTS.map((v) => (
                                    <button
                                        key={v.key}
                                        type="button"
                                        onClick={() => pick(it.errorItemId, v.key)}
                                        className={`rounded-lg border py-2 text-sm font-semibold transition-colors ${
                                            chosen === v.key
                                                ? v.active
                                                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                        }`}
                                    >
                                        {v.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}

                {submitError && <p className="text-xs text-red-600 px-1">{submitError}</p>}
            </div>

            {/* 底部提交栏 */}
            <div className="fixed bottom-0 left-0 right-0 z-20 border-t bg-white/95 backdrop-blur">
                <div className="max-w-2xl mx-auto px-3 py-2.5 flex items-center gap-3">
                    <div className="flex-1 text-xs text-muted-foreground">
                        已判 {judgedCount}/{items.length}
                        {allJudged ? " · 可以提交了" : " · 还有题没判"}
                    </div>
                    <button
                        onClick={submit}
                        disabled={!allJudged || submitting}
                        className="rounded-lg bg-slate-900 text-white px-6 py-2.5 text-sm font-semibold disabled:opacity-40"
                    >
                        {submitting ? "提交中…" : result ? "重新提交" : "提交批改"}
                    </button>
                </div>
            </div>

            {/* 结果弹层：分数 + 评语 + 轻量撒花 */}
            {result && mood && (
                <ResultOverlay
                    score={result.score}
                    correctCount={result.correctCount}
                    total={result.total}
                    onBack={backToCenter}
                    onStay={() => setResult(null)}
                />
            )}
        </div>
    );
}

function ResultOverlay({
    score,
    correctCount,
    total,
    onBack,
    onStay,
}: {
    score: number;
    correctCount: number;
    total: number;
    onBack: () => void;
    onStay: () => void;
}) {
    const mood = scoreMood(score);
    const confetti = useMemo(
        () => (mood.tone === "keep" ? [] : Array.from({ length: 24 }, (_, i) => i)),
        [mood.tone],
    );
    const ring =
        mood.tone === "great" ? "from-emerald-400 to-teal-500" : mood.tone === "good" ? "from-sky-400 to-blue-500" : "from-amber-400 to-orange-500";

    return (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-5 backdrop-blur-sm">
            {confetti.length > 0 && (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                    {confetti.map((i) => (
                        <span
                            key={i}
                            className="confetti-piece absolute block h-2.5 w-1.5 rounded-sm"
                            style={{
                                left: `${(i * 37) % 100}%`,
                                backgroundColor: ["#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6"][i % 5],
                                animationDelay: `${(i % 8) * 0.12}s`,
                                animationDuration: `${2.2 + (i % 4) * 0.3}s`,
                            }}
                        />
                    ))}
                </div>
            )}
            <div className="relative w-full max-w-xs rounded-2xl bg-white p-6 text-center shadow-2xl">
                <div className="text-5xl">{mood.emoji}</div>
                <h2 className="mt-2 text-xl font-extrabold text-slate-800">{mood.title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">{mood.subtitle}</p>
                <div className={`mx-auto mt-4 flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-br ${ring} text-white shadow-lg`}>
                    <div>
                        <div className="text-4xl font-black leading-none">{score}</div>
                        <div className="text-[10px] font-semibold opacity-90">分</div>
                    </div>
                </div>
                <div className="mt-3 text-sm text-slate-600">
                    答对 <span className="font-bold text-emerald-600">{correctCount}</span> / {total} 题
                </div>
                <button
                    onClick={onBack}
                    className="mt-5 w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white"
                >
                    返回批改中心
                </button>
                <button
                    onClick={onStay}
                    className="mt-2 w-full py-1.5 text-xs text-slate-500 hover:text-slate-700"
                >
                    留在本页重新批改
                </button>
            </div>
        </div>
    );
}

export default function MarkPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>}>
            <MarkContent />
        </Suspense>
    );
}
