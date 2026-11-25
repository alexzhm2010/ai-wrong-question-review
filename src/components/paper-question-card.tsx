"use client";

/**
 * 试卷题目卡片——「练习试卷查看」与「扫码批卷」共用的内容呈现。
 *
 * 统一负责：题号徽章 + 卷面短码 + 判定标签 + 题图/题干 + 参考答案区。
 * 两个入口打开同一份卷子时，题目部分的观感完全一致。
 *
 * 差异只通过 props 注入，不各自复制样式：
 *  - verdict：当前要显示的判定（查看页传题面历史判定，批改页传用户当前选择）
 *  - children：批改页在答案区下方塞入「对/错/未做」判定按钮；查看页不传即只读
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ReferenceAnswer } from "@/components/reference-answer";
import { imageSrc } from "@/lib/storage";
import { hardNavigate } from "@/lib/navigation";

/** paper_read RPC 返回的单题结构（两个页面共用） */
export type PaperQuestionItem = {
    errorItemId: string;
    orderIndex: number;
    shortCode: string;
    answer: string;
    imageUrl: string;
    questionText: string;
    verdict: string | null;
};

export const VERDICT_LABEL: Record<string, string> = {
    correct: "对",
    wrong: "错",
    blank: "未做",
    mastered: "完全掌握",
};

/** 判定标签配色：以查看页为准，未做与答错同色系，完全掌握用紫色强调 */
function verdictTone(verdict: string): string {
    if (verdict === "mastered") return "bg-violet-100 text-violet-700 ring-1 ring-violet-200";
    if (verdict === "correct") return "bg-emerald-50 text-emerald-700";
    if (verdict === "wrong" || verdict === "blank") return "bg-rose-50 text-rose-700";
    return "";
}

export function PaperQuestionCard({
    item,
    index,
    verdict,
    detailHref,
    children,
}: {
    item: PaperQuestionItem;
    index: number;
    verdict?: string | null;
    /** 有值时，题目内容区可点击整页跳转到该题的错题详情（完整解析） */
    detailHref?: string;
    children?: ReactNode;
}) {
    const shown = verdict ?? item.verdict;
    const openDetail = () => {
        if (detailHref) hardNavigate(detailHref);
    };
    return (
        <div className="rounded-xl border bg-white p-3 space-y-2.5">
            {/*
             * 可点击区只包「题号 + 题图/题干 + 参考答案」——即用户理解的「题目本身」。
             * 判定按钮等 children 放在外层、此容器之外，点判定不会误触跳详情。
             */}
            <div
                role={detailHref ? "button" : undefined}
                tabIndex={detailHref ? 0 : undefined}
                aria-label={detailHref ? `查看第 ${index + 1} 题的完整解析` : undefined}
                onClick={openDetail}
                onKeyDown={(e) => {
                    if (!detailHref) return;
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail();
                    }
                }}
                className={detailHref
                    ? "space-y-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-slate-400 cursor-pointer"
                    : "space-y-2.5"}
            >
                <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-white">
                        第 {index + 1} 题
                    </span>
                    <span className="font-mono text-[11px] tracking-wide text-slate-500">
                        #{item.shortCode || item.errorItemId.slice(-8)}
                    </span>
                    {shown && (
                        <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${verdictTone(shown)}`}>
                            {VERDICT_LABEL[shown] || shown}
                        </span>
                    )}
                </div>

                {/* 题目截图 / 题干兜底 */}
                {item.imageUrl ? (
                    <img
                        src={imageSrc(item.imageUrl)}
                        alt={`第 ${index + 1} 题`}
                        className="w-full rounded border bg-white"
                        loading="lazy"
                    />
                ) : item.questionText ? (
                    <div className="rounded bg-slate-50 p-2 text-xs leading-relaxed whitespace-pre-wrap">
                        {item.questionText}
                    </div>
                ) : (
                    <div className="rounded bg-slate-50 p-3 text-center text-xs text-slate-400">
                        该题无截图
                    </div>
                )}

                {/* 参考答案区（两页一致） */}
                <div className="rounded-lg bg-amber-50/70 px-2.5 py-2">
                    <div className="mb-0.5 text-[10px] font-semibold text-amber-700">参考答案</div>
                    <div className="text-sm text-slate-800">
                        <ReferenceAnswer text={item.answer || "（暂无答案）"} />
                    </div>
                </div>

                {detailHref && (
                    <div className="flex items-center justify-center gap-0.5 pt-0.5 text-[10px] font-medium text-slate-400">
                        点击查看该题完整解析与错因
                        <ChevronRight className="h-3 w-3" />
                    </div>
                )}
            </div>

            {/* 批改页的判定按钮等内容从这里插入（在可点击区之外，不会误触跳详情） */}
            {children}
        </div>
    );
}
