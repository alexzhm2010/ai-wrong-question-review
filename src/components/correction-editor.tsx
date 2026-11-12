"use client";

import { useState, useEffect } from "react";
import { ParsedQuestion } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Save, RefreshCw, Loader2, ChevronDown, ChevronUp, Pencil, Undo2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { frontendLogger } from "@/lib/frontend-logger";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { ReferenceAnswer } from "@/components/reference-answer";
import { TagInput } from "@/components/tag-input";
import { NotebookSelector } from "@/components/notebook-selector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api-client";
import { UserProfile, Notebook } from "@/types/api";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { getMistakeStatusLabel, normalizeMistakeStatusForSave, type MistakeStatus } from "@/lib/mistake-status";
import type { ReanswerQuestionResult } from "@/lib/ai/types";
import { buildReanswerRequestBody } from "@/lib/reanswer-request";
import { ThinkingModeToggle, useThinkingMode } from "@/components/thinking-mode-toggle";
import { GeogebraDemo } from "@/components/geogebra-demo";
import { GeogebraEntry } from "@/components/geogebra-entry";
import { shouldShowGeogebra } from "@/lib/geogebra-subject";
import { toast } from "@/lib/toast";
import { GRADE_SEMESTER_OPTIONS, GRADE_SEMESTER_UNSET } from "@/lib/grade-options";
import { fetchLastGradeSemester } from "@/lib/last-grade";
import { reconcileMistakeFields, sanitizeMistakeText } from "@/lib/ai/response-guard";

interface ParsedQuestionWithSubject extends ParsedQuestion {
    subjectId?: string;
    gradeSemester?: string;
    geogebraCommands?: string;
    /** 人工纠错说明：随「重新解题」发给 AI，并保存在本题 */
    userGuidance?: string;
}

interface CorrectionEditorProps {
    initialData: ParsedQuestion;
    onSave: (data: ParsedQuestionWithSubject) => Promise<void>;
    onCancel: () => void;
    imagePreview?: string | null;
    initialSubjectId?: string;
    initialGuidance?: string;
    aiTimeout?: number;
    /** 保存按钮文案覆盖：批量确认场景只是「保存修改」，不是直接入库 */
    saveLabel?: string;
}

type ReanswerErrorMessages = {
    default?: string;
    authError?: string;
    connectionFailed?: string;
    responseError?: string;
    timeout?: string;
};

export function CorrectionEditor({ initialData, onSave, onCancel, imagePreview, initialSubjectId, initialGuidance, aiTimeout, saveLabel }: CorrectionEditorProps) {
    // 重新解题同样按「这一题」的思考深度走，默认沿用首页选择
    const [thinkingMode, setThinkingMode] = useThinkingMode();
    const [data, setData] = useState<ParsedQuestionWithSubject>(() => {
        // 入口统一走判定裁决层，历史脏数据/自定义提示词产生的自我纠错文本在这里被清掉
        const mistake = reconcileMistakeFields({
            answerText: initialData.answerText,
            wrongAnswerText: initialData.wrongAnswerText,
            mistakeAnalysis: initialData.mistakeAnalysis,
            mistakeStatus: initialData.mistakeStatus,
        });
        return {
            ...initialData,
            wrongAnswerText: mistake.wrongAnswerText,
            mistakeAnalysis: mistake.mistakeAnalysis,
            mistakeStatus: mistake.mistakeStatus,
            // 优先用解析结果里已经定好的错题本（后端按学科自动匹配/创建），
            // 其次才用挂载后到达的 initialSubjectId，避免学科落空被手填错。
            subjectId: (initialData as ParsedQuestionWithSubject).subjectId ?? initialSubjectId,
            gradeSemester: ""
        };
    });
    const { t, language } = useLanguage();
    const [isReanswering, setIsReanswering] = useState(false);
    // 本次重新解题是否因深度思考超时降级成了快速模式（结果需人工核对）
    const [reanswerDegraded, setReanswerDegraded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isAnalyzingGeogebra, setIsAnalyzingGeogebra] = useState(false);
    const [geogebraError, setGeogebraError] = useState<string | null>(null);
    const [imageExpanded, setImageExpanded] = useState(false);
    const [mistakePreviewExpanded, setMistakePreviewExpanded] = useState(false);

    // —— 人工接管：题干 / 答案 / 解析可直接编辑，并保留上一版可撤销 ——
    const [editingField, setEditingField] = useState<"questionText" | "answerText" | "analysis" | null>(null);
    const [fieldDraft, setFieldDraft] = useState("");
    const [manualFields, setManualFields] = useState<Set<"questionText" | "answerText" | "analysis">>(new Set());
    const [undoSnapshot, setUndoSnapshot] = useState<
        { questionText: string; answerText: string; analysis: string } | null
    >(null);
    // —— 给 AI 的纠错说明 / 锁定答案 ——
    const [guidance, setGuidance] = useState(initialGuidance || "");
    const [lockAnswer, setLockAnswer] = useState(false);

    // 参考答案由后端经「反向代入验算」自动定夺，前端不再做答案/解析一致性的人工判断 UI。
    const [educationStage, setEducationStage] = useState<string | undefined>(undefined);

    const [notebooks, setNotebooks] = useState<Notebook[]>([]);

    // 错题本列表（学科推断）、学段（标签建议）、上次保存时用的年级
    useEffect(() => {
        apiClient.get<Notebook[]>("/api/notebooks")
            .then(setNotebooks)
            .catch(err => console.error("Failed to fetch notebooks:", err));

        apiClient.get<UserProfile>("/api/user")
            .then(user => {
                if (user?.educationStage) setEducationStage(user.educationStage);
            })
            .catch(err => console.error("Failed to fetch user info:", err));

        // 默认年级：沿用数据库里最近一次手选的有效年级，不调用 AI、不按资料推算
        fetchLastGradeSemester().then(last => {
            if (last) setData(prev => ({ ...prev, gradeSemester: last }));
        });
    }, []);

    // 自动建/选的错题本可能晚于挂载到达；只在尚未选择时补齐，不覆盖用户手选
    useEffect(() => {
        if (!initialSubjectId) return;
        setData(prev => prev.subjectId ? prev : { ...prev, subjectId: initialSubjectId });
    }, [initialSubjectId]);

    // 「人可以直接改」：题干 / 参考答案 / 解析都支持手动编辑，并保留上一版可撤销
    type EditableField = "questionText" | "answerText" | "analysis";

    const startEditing = (field: EditableField) => {
        setEditingField(field);
        setFieldDraft(String(data[field] || ""));
    };

    const commitEditing = () => {
        if (!editingField) return;
        const field = editingField;
        setUndoSnapshot({ questionText: data.questionText, answerText: data.answerText, analysis: data.analysis });
        setData(prev => ({ ...prev, [field]: fieldDraft }));
        setManualFields(prev => new Set(prev).add(field));
        setEditingField(null);
        setFieldDraft("");
    };

    const undoManualEdit = () => {
        if (!undoSnapshot) return;
        setData(prev => ({ ...prev, ...undoSnapshot }));
        setManualFields(new Set());
        setUndoSnapshot(null);
        toast.info(t.editor.undoDone || "已恢复上一版答案与解析");
    };

    // 重新解题函数
    const handleReanswer = async () => {
        if (!data.questionText.trim()) {
            toast.info(t.editor.enterQuestionFirst || 'Please enter question text first');
            return;
        }
        // 重解会覆盖答案/解析；已经人工改过就先确认，避免一句话丢掉手工成果
        const willOverwrite = manualFields.has("analysis") || (!lockAnswer && manualFields.has("answerText"));
        if (willOverwrite && !window.confirm(t.editor.overwriteManualConfirm || "重新解题会覆盖你手动修改的答案/解析，继续吗？")) {
            return;
        }

        setIsReanswering(true);
        setReanswerDegraded(false);
        try {
            const requestBody = buildReanswerRequestBody({
                questionText: data.questionText,
                language,
                subject: data.subject,
                imagePreview,
                gradeSemester: data.gradeSemester,
                reasoningMode: thinkingMode,
                guidance,
                lockedAnswerText: lockAnswer ? data.answerText : undefined,
            });

            if (requestBody.imageBase64) {
                console.log("[Reanswer] Sending image + text (Image available for mistake analysis)");
            } else {
                console.log("[Reanswer] Sending text only (No image available)");
            }

            frontendLogger.info('[Reanswer]', 'Sending request', { timeout: aiTimeout });

            const result = await apiClient.post<ReanswerQuestionResult>("/api/reanswer", requestBody, { timeout: aiTimeout || 180000 });

            // 覆盖前留一版快照，重解结果不满意时可一键退回
            setUndoSnapshot({ questionText: data.questionText, answerText: data.answerText, analysis: data.analysis });
            setManualFields(new Set());
            setData(prev => {
                const mistake = reconcileMistakeFields({
                    answerText: result.answerText,
                    wrongAnswerText: result.wrongAnswerText,
                    mistakeAnalysis: result.mistakeAnalysis,
                    mistakeStatus: result.mistakeStatus,
                });
                return {
                    ...prev,
                    // 锁定答案时只接受解析，答案永远以用户当前值为准
                    answerText: lockAnswer ? prev.answerText : result.answerText,
                    analysis: result.analysis,
                    knowledgePoints: result.knowledgePoints,
                    wrongAnswerText: mistake.wrongAnswerText,
                    mistakeAnalysis: mistake.mistakeAnalysis,
                    mistakeStatus: mistake.mistakeStatus,
                };
            });

            if (result.degraded) {
                setReanswerDegraded(true);
                toast.warning(t.editor.reanswerDegraded || '深度思考超过 95 秒，已自动改用快速模式重新解题（解析会略简）');
            } else {
                toast.success(t.editor.reanswerSuccess || '✅ Answer and analysis updated!');
            }
        } catch (error: unknown) {
            console.error("Reanswer failed:", error);
            const apiError = error as { status?: number; data?: { message?: string; code?: string } };
            const msg = apiError.data?.message || '';
            const code = apiError.data?.code || '';

            const reanswerErrors: ReanswerErrorMessages = t.errors?.reanswer || {};
            let errorText = reanswerErrors.default || 'Reanswer failed';

            if (
                apiError.status === 546 ||
                apiError.status === 504 ||
                code === 'WORKER_RESOURCE_LIMIT' ||
                msg.includes('WORKER_RESOURCE_LIMIT') ||
                msg.includes('AI_TIMEOUT_ERROR')
            ) {
                errorText = reanswerErrors.timeout || t.errors?.AI_TIMEOUT_ERROR || errorText;
            } else if (msg.includes('AI_AUTH_ERROR')) {
                errorText = reanswerErrors.authError || t.errors?.AI_AUTH_ERROR || errorText;
            } else if (msg.includes('AI_QUOTA_BLOCKED')) {
                errorText = t.errors?.AI_QUOTA_BLOCKED || errorText;
            } else if (msg.includes('AI_CONNECTION_FAILED')) {
                errorText = reanswerErrors.connectionFailed || t.errors?.AI_CONNECTION_FAILED || errorText;
            } else if (msg.includes('AI_RESPONSE_ERROR')) {
                errorText = reanswerErrors.responseError || t.errors?.AI_RESPONSE_ERROR || errorText;
            }

            toast.error(errorText);

        } finally {
            setIsReanswering(false);
        }
    };

    // 学科以错题本名优先：文字录入 / AI 解题路径会把 subject 硬编码成「数学」。
    // 非理科直接不渲染入口，避免每次识别完都占一块无用的版面。
    const geogebraSubjectName = notebooks.find(n => n.id === data.subjectId)?.name || null;
    const showGeogebraEntry = shouldShowGeogebra(geogebraSubjectName, data.subject);

    // previousErrors 来自 <GeogebraDemo> 里执行失败的命令列表，用于让 AI 定向修正
    const handleAnalyzeGeogebra = async (previousErrors?: string) => {
        if (!data.questionText.trim()) {
            toast.info(t.editor.enterQuestionFirst || '请先输入题目文本');
            return;
        }
        if (!data.answerText.trim()) {
            toast.info('请先生成或输入答案');
            return;
        }

        setIsAnalyzingGeogebra(true);
        setGeogebraError(null);
        try {
            const response = await fetch("/api/geogebra-analyze", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    questionText: data.questionText,
                    answerText: data.answerText,
                    analysis: data.analysis,
                    subjectName: geogebraSubjectName || data.subject || "",
                    previousErrors: typeof previousErrors === "string" ? previousErrors : "",
                }),
            });

            if (!response.ok) {
                throw new Error("Analysis failed");
            }

            const result = await response.json();
            if (result.suitable && result.commands?.length > 0) {
                setData(prev => ({
                    ...prev,
                    geogebraCommands: JSON.stringify(result.commands),
                }));
            } else {
                setGeogebraError(result.description || "该题目不适合用 GeoGebra 演示");
            }
        } catch (error: any) {
            console.error("GeoGebra analysis failed:", error);
            setGeogebraError("分析失败，请稍后重试");
        } finally {
            setIsAnalyzingGeogebra(false);
        }
    };

    const handleSaveClick = async () => {
        if (isSaving) return;
        setIsSaving(true);
        try {
            const status = normalizeMistakeStatusForSave(
                data.mistakeStatus,
                data.wrongAnswerText
            );
            await onSave({
                ...data,
                userGuidance: guidance.trim() || undefined,
                mistakeStatus: status,
                // 答对时不保留「错误解答 / 错因」，避免把正确答案误标为错误
                wrongAnswerText: status === 'correct' ? '' : data.wrongAnswerText,
                mistakeAnalysis: status === 'correct' ? '' : data.mistakeAnalysis,
            });
        } finally {
            setIsSaving(false);
        }
    };

    // 展示前再清洗一次，历史脏记录不会把标签和自我纠错文本渲染出来
    const cleanWrongAnswerText = sanitizeMistakeText(data.wrongAnswerText);
    const cleanMistakeAnalysis = sanitizeMistakeText(data.mistakeAnalysis);
    const mistakeSummary = cleanMistakeAnalysis || cleanWrongAnswerText;

    return (
        <div className="space-y-4 sm:space-y-6">
            <h2 className="text-xl font-bold sm:text-2xl">{t.editor.title}</h2>

            {/* 归档信息：与保存按钮放在同一张卡里，避免被题目原图隔开 */}
            <Card className="border-primary/30">
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">归档信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>{t.editor.selectNotebook || "选择错题本"}</Label>
                        <NotebookSelector
                            value={data.subjectId}
                            onChange={(id) => setData({ ...data, subjectId: id })}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>{t.editor.gradeSemester || "年级/学期"}</Label>
                        <Select
                            value={data.gradeSemester || GRADE_SEMESTER_UNSET}
                            onValueChange={(val) => setData({
                                ...data,
                                gradeSemester: val === GRADE_SEMESTER_UNSET ? "" : val,
                            })}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={GRADE_SEMESTER_UNSET}>未设置</SelectItem>
                                {GRADE_SEMESTER_OPTIONS.map(grade => (
                                    <SelectItem key={grade} value={grade}>{grade}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex gap-2 border-t pt-4">
                        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onCancel}>
                            {t.editor.cancel}
                        </Button>
                        <Button className="flex-1 sm:flex-none" onClick={handleSaveClick} disabled={isSaving}>
                            {isSaving ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Save className="mr-2 h-4 w-4" />
                            )}
                            {isSaving ? (t.common?.pleaseWait || "请稍候...") : (saveLabel || t.editor.save)}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
                {/* 左侧：编辑区 */}
                <div className="space-y-6">
                    {imagePreview && (
                        <Card>
                            <CardContent className="p-3">
                                <button
                                    type="button"
                                    onClick={() => setImageExpanded(v => !v)}
                                    className="flex w-full items-center gap-3 rounded-md text-left transition-colors hover:bg-accent/50"
                                >
                                    <img src={imagePreview} alt="Original" className="h-14 w-14 shrink-0 rounded object-cover" />
                                    <span className="flex-1 text-sm font-medium">题目原图</span>
                                    <span className="text-xs text-muted-foreground">
                                        {imageExpanded ? "收起" : "展开"}
                                    </span>
                                    {imageExpanded
                                        ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                                        : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                                </button>
                                {imageExpanded && (
                                    <img src={imagePreview} alt="Original" className="mt-3 w-full rounded-md" />
                                )}
                            </CardContent>
                        </Card>
                    )}

                    <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5">
                        <span className="text-xs text-muted-foreground">
                            {t.app?.thinkingMode || "思考深度"}
                        </span>
                        <ThinkingModeToggle
                            value={thinkingMode}
                            onChange={setThinkingMode}
                            disabled={isReanswering}
                        />
                    </div>

                    <Button
                        variant="default"
                        size="sm"
                        onClick={handleReanswer}
                        disabled={isReanswering || !data.questionText.trim()}
                        className="w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-medium"
                    >
                        {isReanswering ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                {t.editor.reanswering || 'AI solving...'}
                            </>
                        ) : (
                            <>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                {t.editor.reanswer || 'Reanswer (based on corrected question)'}
                            </>
                        )}
                    </Button>

                    {/* 人给 AI 的约束：说明为什么错 / 正确答案是什么；锁答案后只让它补解析 */}
                    <div className="space-y-2 rounded-lg border bg-muted/20 p-2.5">
                        <div className="flex items-center justify-between">
                            <Label className="text-xs">{t.editor.guidanceLabel || "给 AI 的补充说明（可选）"}</Label>
                            <span className="text-[10px] text-muted-foreground">保存在本题</span>
                        </div>
                        <Textarea
                            value={guidance}
                            onChange={(e) => setGuidance(e.target.value)}
                            rows={3}
                            className="text-sm"
                            placeholder={t.editor.guidancePlaceholder || "例：正确答案是偏低——俯视量筒读数偏大，实际取液偏少；请按这个结论写解析"}
                        />
                        <div className="flex items-center justify-between gap-2 pt-1">
                            <div>
                                <div className="text-xs font-medium">{t.editor.lockAnswer || "锁定当前答案，只重写解析"}</div>
                                <div className="text-[10px] text-muted-foreground">AI 不得改动上面的参考答案</div>
                            </div>
                            <Switch
                                checked={lockAnswer}
                                onCheckedChange={setLockAnswer}
                                disabled={!data.answerText.trim()}
                            />
                        </div>
                    </div>

                    {undoSnapshot && (
                        <Button variant="outline" size="sm" className="w-full" onClick={undoManualEdit}>
                            <Undo2 className="mr-2 h-4 w-4" />
                            {t.editor.undoEdit || "恢复上一版答案与解析"}
                        </Button>
                    )}

                    {thinkingMode === 'deep' && !reanswerDegraded && (
                        <p className="text-xs text-muted-foreground">
                            {t.editor.deepBudgetHint || '⏳ 深度思考最长约 95 秒，超时会自动改用快速模式'}
                        </p>
                    )}
                    {reanswerDegraded && (
                        <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                            {t.editor.reanswerDegradedNote || '⚠️ 本次结果由快速模式生成，建议核对关键结论后再入库'}
                        </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                        {t.editor.reanswerHint || '💡 If the question was misrecognized, correct it and click to regenerate answer'}
                    </p>

                    <div className="space-y-2">
                        <Label>{t.editor.tags}</Label>
                        <TagInput
                            value={data.knowledgePoints}
                            onChange={(tags) => setData({ ...data, knowledgePoints: tags })}
                            placeholder={t.editor.tagsPlaceholder || "Enter knowledge tags..."}
                            enterHint={t.editor.createTagHint}
                            subject={inferSubjectFromName(notebooks.find(n => n.id === data.subjectId)?.name || null) || inferSubjectFromName(data.subject || null) || undefined}
                            gradeStage={educationStage}
                        />
                        <p className="text-xs text-muted-foreground">
                            {t.editor.tagsHint || "💡 Tag suggestions will appear as you type"}
                        </p>
                    </div>

                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0">
                            <CardTitle>{t.editor.mistakeAnalysisTitle || "错因分析"}</CardTitle>
                            {(data.wrongAnswerText || data.mistakeAnalysis) && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setData(prev => ({
                                        ...prev,
                                        wrongAnswerText: "",
                                        mistakeAnalysis: "",
                                        mistakeStatus: "unknown",
                                    }))}
                                >
                                    清空错因
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>{t.editor.mistakeStatus || "作答状态"}</Label>
                                <Select
                                    value={data.mistakeStatus || "unknown"}
                                    onValueChange={(val) => setData({ ...data, mistakeStatus: val as MistakeStatus })}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="correct">{t.editor.mistakeStatuses?.correct || "答对了"}</SelectItem>
                                        <SelectItem value="not_attempted">{t.editor.mistakeStatuses?.notAttempted || "不会做"}</SelectItem>
                                        <SelectItem value="wrong_attempt">{t.editor.mistakeStatuses?.wrongAttempt || "做错了"}</SelectItem>
                                        <SelectItem value="unknown">{t.editor.mistakeStatuses?.unknown || "未判断"}</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    AI 的判定只是建议，判不准请以你手选的为准。
                                </p>
                            </div>
                            {data.mistakeStatus === 'correct' ? (
                                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                                    ✅ 已判定该题作答正确，无需填写「错误解答原文」与「错因分析」。
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-2">
                                        <Label>{t.editor.wrongAnswerText || "错误解答原文"}</Label>
                                        <Textarea
                                            value={data.wrongAnswerText || ""}
                                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setData({
                                                ...data,
                                                wrongAnswerText: e.target.value,
                                            })}
                                            className="min-h-[80px] font-mono text-sm"
                                            placeholder={t.editor.wrongAnswerPlaceholder || "如果图片里没有错误解答，可留空"}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>{t.editor.mistakeAnalysis || "错因分析"}</Label>
                                        <Textarea
                                            value={data.mistakeAnalysis || ""}
                                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setData({
                                                ...data,
                                                mistakeAnalysis: e.target.value,
                                            })}
                                            className="min-h-[110px] font-mono text-sm"
                                            placeholder={"错在第几步 / 原因类型 / 下次提醒（三行，≤150 字）"}
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            建议三行：① 错在解析思路第几步 ② 原因类型（概念/计算/审题/方法/跳步）③ 下次提醒；不要复述解题过程。
                                            {data.mistakeAnalysis && data.mistakeAnalysis.length > 150 && (
                                                <span className="ml-1 text-amber-600">当前 {data.mistakeAnalysis.length} 字</span>
                                            )}
                                        </p>
                                    </div>
                                </>
                            )}
                        </CardContent>
                    </Card>
                </div>

                {/* 右侧：预览区（题干 / 答案 / 解析都可以手动改，改过会标「人工修正」） */}
                <div className="space-y-6">
                    <Card className={manualFields.has("questionText") ? "border-amber-300" : undefined}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0">
                            <CardTitle className="flex items-center gap-2">
                                {t.editor.preview?.question || "题目内容"}
                                {manualFields.has("questionText") && (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-800">人工修正</span>
                                )}
                            </CardTitle>
                            {editingField !== "questionText" && (
                                <Button variant="ghost" size="sm" onClick={() => startEditing("questionText")}>
                                    <Pencil className="mr-1 h-4 w-4" />
                                    {t.common?.edit || "编辑"}
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent>
                            {editingField === "questionText" ? (
                                <div className="space-y-2">
                                    <Textarea
                                        value={fieldDraft}
                                        onChange={(e) => setFieldDraft(e.target.value)}
                                        rows={10}
                                        className="font-mono text-sm"
                                        placeholder="支持 Markdown / LaTeX"
                                    />
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={commitEditing}>
                                            <Save className="mr-1 h-4 w-4" />{t.common?.save || "保存"}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => setEditingField(null)}>
                                            {t.common?.cancel || "取消"}
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <MarkdownRenderer content={data.questionText} />
                            )}
                        </CardContent>
                    </Card>

                    {/* GeoGebra Dynamic Demo：已生成的演示照常展示；未生成时只给一行折叠小入口，非理科直接隐藏 */}
                    {data.geogebraCommands ? (
                        <GeogebraDemo commands={data.geogebraCommands} height={350} onRegenerate={handleAnalyzeGeogebra} />
                    ) : showGeogebraEntry && data.questionText.trim() && data.answerText.trim() ? (
                        <GeogebraEntry
                            onGenerate={() => handleAnalyzeGeogebra()}
                            isAnalyzing={isAnalyzingGeogebra}
                            error={geogebraError}
                        />
                    ) : null}

                    <Card className={manualFields.has("answerText") ? "border-amber-300" : undefined}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0">
                            <CardTitle className="flex items-center gap-2">
                                {t.editor.preview?.answer || "参考答案"}
                                {manualFields.has("answerText") && (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-800">人工修正</span>
                                )}
                            </CardTitle>
                            {editingField !== "answerText" && (
                                <Button variant="ghost" size="sm" onClick={() => startEditing("answerText")}>
                                    <Pencil className="mr-1 h-4 w-4" />
                                    {t.common?.edit || "编辑"}
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent>
                            {editingField === "answerText" ? (
                                <div className="space-y-2">
                                    <Textarea
                                        value={fieldDraft}
                                        onChange={(e) => setFieldDraft(e.target.value)}
                                        rows={4}
                                        className="font-mono text-sm"
                                        placeholder="支持 Markdown / LaTeX"
                                    />
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={commitEditing}>
                                            <Save className="mr-1 h-4 w-4" />{t.common?.save || "保存"}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => setEditingField(null)}>
                                            {t.common?.cancel || "取消"}
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <ReferenceAnswer text={data.answerText} />
                            )}
                        </CardContent>
                    </Card>

                    <Card className={manualFields.has("analysis") ? "border-amber-300" : undefined}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0">
                            <CardTitle className="flex items-center gap-2">
                                {t.editor.preview?.analysis || "解析思路"}
                                {manualFields.has("analysis") && (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-800">人工修正</span>
                                )}
                            </CardTitle>
                            {editingField !== "analysis" && (
                                <Button variant="ghost" size="sm" onClick={() => startEditing("analysis")}>
                                    <Pencil className="mr-1 h-4 w-4" />
                                    {t.common?.edit || "编辑"}
                                </Button>
                            )}
                        </CardHeader>
                        <CardContent>
                            {editingField === "analysis" ? (
                                <div className="space-y-2">
                                    <Textarea
                                        value={fieldDraft}
                                        onChange={(e) => setFieldDraft(e.target.value)}
                                        rows={14}
                                        className="font-mono text-sm"
                                        placeholder="支持 Markdown / LaTeX，行间公式用 $$...$$"
                                    />
                                    <div className="flex gap-2">
                                        <Button size="sm" onClick={commitEditing}>
                                            <Save className="mr-1 h-4 w-4" />{t.common?.save || "保存"}
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => setEditingField(null)}>
                                            {t.common?.cancel || "取消"}
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <MarkdownRenderer content={data.analysis} />
                            )}
                        </CardContent>
                    </Card>

                    {data.mistakeStatus === 'wrong_attempt' && mistakeSummary && (
                        <Card>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0">
                                <CardTitle>{t.editor.preview?.mistakeAnalysis || "错因分析预览"}</CardTitle>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setMistakePreviewExpanded(v => !v)}
                                >
                                    {mistakePreviewExpanded ? "收起" : "展开"}
                                </Button>
                            </CardHeader>
                            <CardContent className="space-y-3 text-sm">
                                <div className="text-muted-foreground">
                                    {t.editor.mistakeStatus || "作答状态"}：{getMistakeStatusLabel(data.mistakeStatus, language)}
                                </div>
                                {!mistakePreviewExpanded ? (
                                    <div className="text-muted-foreground">
                                        {mistakeSummary.slice(0, 60)}{mistakeSummary.length > 60 ? "…" : ""}
                                    </div>
                                ) : (
                                    <>
                                        {cleanWrongAnswerText && (
                                            <div>
                                                <div className="font-medium mb-1">{t.editor.wrongAnswerText || "错误解答原文"}</div>
                                                <MarkdownRenderer content={cleanWrongAnswerText} />
                                            </div>
                                        )}
                                        {cleanMistakeAnalysis && (
                                            <div>
                                                <div className="font-medium mb-1">{t.editor.mistakeAnalysis || "错因分析"}</div>
                                                <MarkdownRenderer content={cleanMistakeAnalysis} />
                                            </div>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
