"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { PaperQuestionCard, type PaperQuestionItem } from "@/components/paper-question-card";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { scoreMood } from "@/lib/paper-score";
import { errorItemDetailHref, isSubmitted } from "@/lib/paper-archive";
import { PAPERS_HOME } from "@/lib/navigation";

type Paper = {
    code: string;
    paperNo: string;
    subjectNames: string;
    itemCount: number;
    score: number | null;
    correctCount: number | null;
    submittedAt: string | null;
    items: PaperQuestionItem[];
};
type Verdict = "correct" | "wrong" | "blank" | "mastered";

const VERDICTS: { key: Verdict; label: string; active: string }[] = [
    { key: "correct", label: "对", active: "bg-emerald-600 border-emerald-600 text-white" },
    { key: "wrong", label: "错", active: "bg-rose-600 border-rose-600 text-white" },
    { key: "blank", label: "未做", active: "bg-slate-700 border-slate-700 text-white" },
];

/** 完全掌握：等同于「对」，但会手动归档该题，之后不再出现在任何复习卷 */
const MASTERED: { key: Verdict; label: string; active: string } = {
    key: "mastered",
    label: "✓ 完全掌握（不再出现）",
    active: "bg-violet-600 border-violet-600 text-white",
};

function MarkContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const code = (searchParams.get("c") || "").trim();
    /** 来源：从「练习试卷」列表点进来时是「看对错」，扫码进来是「新批改」，两者文案不同 */
    const fromPapers = searchParams.get("from") === "papers";
    // 批改中心已并入练习试卷，无论扫码还是列表进入，出口一律回练习试卷
    const backHome = PAPERS_HOME;
    const backLabel = "返回练习试卷";

    /** 批改流程的统一出口：返回箭头、出错态、结果页都回练习试卷 */
    const backToCenter = () => router.push(backHome);

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
                    if (it.verdict === "correct" || it.verdict === "wrong" || it.verdict === "blank" || it.verdict === "mastered") {
                        prefilled[it.errorItemId] = it.verdict as Verdict;
                    }
                }
                setChoices(prefilled);
                // 从练习试卷进来是「看哪条做错了」，不弹分数层遮挡题目；
                // 扫码批改进来仍保留原有的已批改结果展示。
                if (!fromPapers && p.score !== null && p.score !== undefined) {
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
    }, [code, fromPapers]);

    const items = paper?.items || [];
    const judgedCount = items.filter((it) => choices[it.errorItemId]).length;
    const allJudged = items.length > 0 && judgedCount === items.length;
    /** 已批改的卷子判定明细用于计算熟悉度，只读锁定：不可改判、不可再次提交 */
    const locked = !!paper && isSubmitted(paper);

    const pick = (id: string, v: Verdict) => {
        if (locked) return;
        setSubmitError("");
        setChoices((prev) => ({ ...prev, [id]: v }));
    };

    const submit = async () => {
        if (locked || !allJudged || submitting || !paper) return;
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
                    {backLabel}
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
                    <BackButton fallbackUrl={backHome} />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold leading-tight">
                            {fromPapers ? "试卷批改结果" : "扫码批改"}
                        </div>
                        <div className="text-[11px] text-muted-foreground leading-tight truncate">
                            卷号 {paper.paperNo || paper.code.slice(0, 12)}
                            {paper.subjectNames ? ` · ${paper.subjectNames}` : ""}
                        </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${
                        locked ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"
                    }`}>
                        {locked ? "已批改 · 只读" : `${judgedCount}/${items.length}`}
                    </span>
                </div>
            </div>

            <div className="max-w-2xl mx-auto px-3 py-4 space-y-3">
                <div className="rounded-lg border bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                    {locked ? (
                        <>
                            这张卷<span className="font-semibold">已经批改过了</span>
                            ，下方是当时的对错判定（绿色为对、红色为错）。
                            <span className="font-semibold text-emerald-700">批改结果已锁定，不能再修改</span>
                            ——判定明细已用于更新掌握度。点击任意题目可查看完整解析。
                        </>
                    ) : fromPapers ? (
                        <>
                            这里是你上次批改的<span className="font-semibold">对错判定</span>
                            ，绿色为对、红色为错。需要更正可重新点选并提交。
                        </>
                    ) : (
                        <>
                            对照纸上的作答，逐题判断<span className="font-semibold">对 / 错 / 未做</span>
                            ，全部判完点底部提交。若某题已彻底掌握，可点
                            <span className="font-semibold text-violet-700">「完全掌握」</span>
                            ——等同答对，并手动归档，之后不再出现在复习卷。
                        </>
                    )}
                </div>

                {items.map((it, i) => {
                    const chosen = choices[it.errorItemId];
                    return (
                        <PaperQuestionCard
                            key={it.errorItemId}
                            item={it}
                            index={i}
                            verdict={chosen}
                            detailHref={errorItemDetailHref(
                                it.errorItemId,
                                `/mark?c=${encodeURIComponent(code)}${fromPapers ? "&from=papers" : ""}`,
                            )}
                        >
                            {/* 批改页专属判定按钮（已批改卷禁用）。
                                「完全掌握」在最前：等同答对，但会手动归档，之后不再出现在复习卷 */}
                            <div className="space-y-2">
                                <button
                                    type="button"
                                    disabled={locked}
                                    onClick={() => pick(it.errorItemId, MASTERED.key)}
                                    title="等同答对，并把这道题标记为已完全掌握、手动归档，之后不再出现在任何复习卷"
                                    className={`w-full rounded-lg border py-2 text-sm font-semibold transition-colors ${
                                        chosen === MASTERED.key
                                            ? MASTERED.active
                                            : "border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"
                                    } ${locked ? "cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent" : ""}`}
                                >
                                    {MASTERED.label}
                                </button>
                                <div className="grid grid-cols-3 gap-2">
                                    {VERDICTS.map((v) => (
                                        <button
                                            key={v.key}
                                            type="button"
                                            disabled={locked}
                                            onClick={() => pick(it.errorItemId, v.key)}
                                            className={`rounded-lg border py-2 text-sm font-semibold transition-colors ${
                                                chosen === v.key
                                                    ? v.active
                                                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                            } ${locked ? "cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent" : ""}`}
                                        >
                                            {v.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </PaperQuestionCard>
                    );
                })}

                {submitError && <p className="text-xs text-red-600 px-1">{submitError}</p>}
            </div>

            {/* 底部栏：已批改卷只读，隐去提交按钮，只留返回；未批改卷保留批改提交 */}
            {locked ? (
                <div className="fixed bottom-0 left-0 right-0 z-20 border-t bg-white/95 backdrop-blur">
                    <div className="max-w-2xl mx-auto px-3 py-2.5">
                        <button
                            onClick={backToCenter}
                            className="w-full rounded-lg border border-slate-300 bg-white py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                        >
                            {backLabel}
                        </button>
                    </div>
                </div>
            ) : (
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
            )}

            {/* 结果弹层：分数 + 评语 + 轻量撒花 */}
            {result && mood && (
                <ResultOverlay
                    score={result.score}
                    correctCount={result.correctCount}
                    total={result.total}
                    backLabel={backLabel}
                    stayLabel={locked ? "留在本页查看试卷" : "留在本页重新批改"}
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
    backLabel,
    stayLabel = "留在本页重新批改",
    onBack,
    onStay,
}: {
    score: number;
    correctCount: number;
    total: number;
    backLabel: string;
    stayLabel?: string;
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
                    {backLabel}
                </button>
                <button
                    onClick={onStay}
                    className="mt-2 w-full py-1.5 text-xs text-slate-500 hover:text-slate-700"
                >
                    {stayLabel}
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
