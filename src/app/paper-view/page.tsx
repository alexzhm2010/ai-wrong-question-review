"use client";

/**
 * 试卷内容（只读）：从「练习试卷」归档点进来，查看某份卷的题目与标准答案。
 * 与 /mark（扫码批改）的区别：这里只读展示、不提供判定/提交，
 * 复用同一个 paper_read RPC（凭 code 读卷，含答案快照与历史判定）。
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { PaperQuestionCard, type PaperQuestionItem } from "@/components/paper-question-card";
import { apiClient } from "@/lib/api-client";
import { formatPaperTime } from "@/lib/paper-list";
import { errorItemDetailHref } from "@/lib/paper-archive";
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

function PaperViewContent() {
    const searchParams = useSearchParams();
    const code = (searchParams.get("c") || "").trim();
    const [paper, setPaper] = useState<Paper | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");

    useEffect(() => {
        if (!code) {
            setLoadError("缺少试卷编号，请从「练习试卷」列表重新进入。");
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        apiClient
            .get<Paper>(`/api/paper/read?c=${encodeURIComponent(code)}`)
            .then((p) => {
                if (!cancelled) setPaper(p);
            })
            .catch((e) => {
                if (cancelled) return;
                const msg = String(e?.message || "");
                setLoadError(
                    msg.includes("PAPER_NOT_FOUND")
                        ? "找不到这张试卷，可能已被删除。请回到列表重新选择。"
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

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">
                正在加载试卷内容…
            </div>
        );
    }

    if (loadError || !paper) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="text-4xl">📄</div>
                <p className="text-sm text-foreground/80">{loadError || "试卷不存在"}</p>
                <button
                    type="button"
                    onClick={() => routerBack()}
                    className="rounded-lg border bg-white px-4 py-2 text-sm font-medium hover:bg-slate-50"
                >
                    返回练习试卷
                </button>
            </div>
        );
    }

    const items = paper.items || [];

    return (
        <div className="min-h-screen bg-slate-50 pb-16">
            <div className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur">
                <div className="mx-auto flex max-w-2xl items-center gap-2.5 px-3 py-2.5">
                    <BackButton fallbackUrl={PAPERS_HOME} />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold leading-tight">试卷内容</div>
                        <div className="text-[11px] text-muted-foreground leading-tight truncate">
                            卷号 {paper.paperNo || paper.code.slice(0, 12)}
                            {paper.subjectNames ? ` · ${paper.subjectNames}` : ""}
                        </div>
                    </div>
                    {paper.score !== null && paper.score !== undefined && (
                        <span className="shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                            {paper.score} 分
                        </span>
                    )}
                </div>
            </div>

            <div className="mx-auto max-w-2xl px-3 py-4 space-y-3">
                <div className="rounded-lg border bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-600">
                    共 {items.length} 题
                    {paper.submittedAt ? ` · 批改于 ${formatPaperTime(paper.submittedAt)}` : " · 尚未批改"}
                    。下方为标准答案（出卷时的快照），供核对与复习。
                </div>

                {items.map((it, i) => (
                    <PaperQuestionCard
                        key={it.errorItemId}
                        item={it}
                        index={i}
                        detailHref={errorItemDetailHref(
                            it.errorItemId,
                            `/paper-view?c=${encodeURIComponent(code)}`,
                        )}
                    />
                ))}

                <button
                    type="button"
                    onClick={() => routerBack()}
                    className="w-full rounded-lg border bg-white py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                    返回练习试卷
                </button>
            </div>
        </div>
    );
}

/** 统一返回归档页（用 location.assign 兼容静态导出，避免 query 预取空壳） */
function routerBack() {
    if (typeof window === "undefined") return;
    window.location.assign(PAPERS_HOME);
}

export default function PaperViewPage() {
    return (
        <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-muted-foreground">加载中…</div>}>
            <PaperViewContent />
        </Suspense>
    );
}
