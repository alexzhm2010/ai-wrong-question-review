"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";
import { getMistakeStatusLabel } from "@/lib/mistake-status";
import type { PartialParsed } from "@/lib/partial-parse";

interface StreamingReviewProps {
    data: PartialParsed;
    imagePreview?: string | null;
}

function Skeleton({ rows = 3 }: { rows?: number }) {
    return (
        <div className="space-y-2">
            {Array.from({ length: rows }).map((_, i) => (
                <div
                    key={i}
                    className="h-3.5 animate-pulse rounded bg-muted"
                    style={{ width: `${[92, 100, 74, 88, 60][i % 5]}%` }}
                />
            ))}
        </div>
    );
}

function StreamText({ text, caret }: { text?: string; caret?: boolean }) {
    if (!text) return <Skeleton />;
    return (
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {text}
            {caret && (
                <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-primary align-middle" />
            )}
        </div>
    );
}

/**
 * 解析进行中的「逐字段填充」视图：题目内容 / 参考答案 / 解析思路 / 作答判定
 * 边接收边显示，尚未生成的字段以骨架屏占位。
 */
export function StreamingReview({ data, imagePreview }: StreamingReviewProps) {
    const { t, language } = useLanguage();

    // 当前正在生成的字段（按输出顺序判断最后一个已出现的）
    const active: "question" | "answer" | "analysis" =
        data.analysis !== undefined
            ? "analysis"
            : data.answerText !== undefined
                ? "answer"
                : "question";

    return (
        <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                {language === "zh"
                    ? "AI 正在解析，内容会逐段填充（可继续等待，也可点右上角取消）"
                    : "AI is analyzing — content fills in progressively (you can cancel at top right)"}
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-3">
                    {imagePreview && (
                        <Card>
                            <CardContent className="p-2">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={imagePreview} alt="Original" className="w-full rounded-md" />
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader className="py-3">
                            <CardTitle className="text-base">
                                {t.editor.preview?.question || "题目内容"}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <StreamText text={data.questionText} caret={active === "question"} />
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-3">
                    <Card>
                        <CardHeader className="py-3">
                            <CardTitle className="text-base">
                                {t.editor.preview?.answer || "参考答案"}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <StreamText text={data.answerText} caret={active === "answer"} />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="py-3">
                            <CardTitle className="text-base">
                                {t.editor.preview?.analysis || "解析思路"}
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <StreamText text={data.analysis} caret={active === "analysis"} />
                        </CardContent>
                    </Card>

                    {data.mistakeStatus && (
                        <Card>
                            <CardHeader className="py-3">
                                <CardTitle className="text-base">
                                    {t.editor.mistakeStatus || "作答状态"}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="text-muted-foreground">
                                    {getMistakeStatusLabel(data.mistakeStatus, language)}
                                </div>
                                {data.mistakeStatus !== "correct" && data.mistakeAnalysis && (
                                    <div className="whitespace-pre-wrap break-words">{data.mistakeAnalysis}</div>
                                )}
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
