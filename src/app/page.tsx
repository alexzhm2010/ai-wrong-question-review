"use client";

import { useState, Suspense, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { UploadZone } from "@/components/upload-zone";
import { ParsedQuestion } from "@/lib/ai";
import { UserWelcome } from "@/components/user-welcome";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook, AppConfig } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { Upload, BookOpen, Tags, LogOut, BarChart3, Images, ChevronRight } from "lucide-react";
import { BroadcastNotification } from "@/components/broadcast-notification";
import { VersionBadge } from "@/components/version-badge";
import { signOut } from "@/lib/supabase/session";

import type { ProgressStatus } from "@/components/ui/progress-feedback";
import { TopProgressBar } from "@/components/top-progress-bar";
import { parsePartialXml, type PartialParsed } from "@/lib/partial-parse";
import { frontendLogger } from "@/lib/frontend-logger";
import { toast } from "@/lib/toast";
import { ThinkingModeToggle, useThinkingMode } from "@/components/thinking-mode-toggle";
import { BatchBanner } from "@/components/batch-banner";
import { useActiveBatches } from "@/lib/batch-store";
import { BatchQuickConfirm } from "@/components/batch-quick-confirm";
import { BatchJobList } from "@/components/batch-job-list";
import { streamAnalyze } from "@/lib/stream-analyze";
import { inferSubjectFromName } from "@/lib/knowledge-tags";

/**
 * 首屏只需要「上传 + 导航」。这几个组件合计 150KB+ 源码（设置对话框 104KB、
 * 校对编辑器 42KB 且带 KaTeX），却都在解析完成/点击之后才用得到。
 * 改成动态 import 后不进首屏 chunk，静态导出冷启动要下载执行的 JS 明显变少。
 * loading 占位保证预渲染 HTML 里位置已占好，不会出现布局跳动。
 */
const Ghost = ({ className = "h-9 w-9 rounded-full" }: { className?: string }) => (
    <div className={`animate-pulse bg-muted ${className}`} aria-hidden="true" />
);

const SettingsDialog = dynamic(
    () => import("@/components/settings-dialog").then(m => m.SettingsDialog),
    { ssr: false, loading: () => <Ghost /> },
);
const CorrectionEditor = dynamic(
    () => import("@/components/correction-editor").then(m => m.CorrectionEditor),
    { ssr: false, loading: () => <Ghost className="h-64 w-full rounded-xl" /> },
);
const ImageCropper = dynamic(
    () => import("@/components/image-cropper").then(m => m.ImageCropper),
    { ssr: false, loading: () => <Ghost className="h-64 w-full rounded-xl" /> },
);
const StreamingReview = dynamic(
    () => import("@/components/streaming-review").then(m => m.StreamingReview),
    { ssr: false, loading: () => <Ghost className="h-64 w-full rounded-xl" /> },
);

function HomeContent() {
    const [step, setStep] = useState<"upload" | "review">("upload");
    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>('idle');
    const [progress, setProgress] = useState(0);
    // subjectId：按学科自动匹配/创建的错题本 id，随解析结果一起下发，保证归档不落空
    const [parsedData, setParsedData] = useState<(ParsedQuestion & { subjectId?: string }) | null>(null);
    const [currentImage, setCurrentImage] = useState<string | null>(null);
    const [streamParsed, setStreamParsed] = useState<PartialParsed>({});
    const [isStreaming, setIsStreaming] = useState(false);
    const streamRawRef = useRef("");
    const lastFlushRef = useRef(0);
    const { t, language } = useLanguage();
    const searchParams = useSearchParams();
    const router = useRouter();
    const initialNotebookId = searchParams.get("notebook");
    const [notebooks, setNotebooks] = useState<{ id: string; name: string }[]>([]);
    const [autoSelectedNotebookId, setAutoSelectedNotebookId] = useState<string | null>(null);

    const [config, setConfig] = useState<AppConfig | null>(null);
    // 逐题的思考深度：默认沿用上次选择，提交前可就地切换
    const [thinkingMode, setThinkingMode] = useThinkingMode();

    // Cancellation + elapsed time for AI analysis
    const phaseStartedAtRef = useRef<number | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelRequestedRef = useRef(false);
    // 本次分析自动创建的错题本 id，用户取消校对时回收，避免留下空本
    const createdNotebookIdRef = useRef<string | null>(null);

    // Input mode: "image" for photo upload, "text" for AI solve, "direct" for manual entry
    const [inputMode, setInputMode] = useState<"image" | "batch">("image");

    // Cropper state
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);

    // 批量导入：上传区一次选到多张时，底部弹出轻确认条，确认后才建批次
    const [batchFiles, setBatchFiles] = useState<File[]>([]);
    // 批量 tab 上的琥珀色提示：有排队/解析/待确认/暂停的批次
    const activeBatches = useActiveBatches();
    const hasActiveBatchHint = activeBatches.length > 0;

    // Timeout Config
    const aiTimeout = config?.timeouts?.analyze || 180000;
    const safetyTimeout = aiTimeout + 10000;

    // Cleanup Blob URL to prevent memory leak
    useEffect(() => {
        return () => {
            if (croppingImage) {
                URL.revokeObjectURL(croppingImage);
            }
        };
    }, [croppingImage]);

    useEffect(() => {
        // Fetch notebooks for auto-selection
        apiClient.get<Notebook[]>("/api/notebooks")
            .then(data => setNotebooks(data))
            .catch(err => console.error("Failed to fetch notebooks:", err));

        // Fetch settings for timeouts
        apiClient.get<AppConfig>("/api/settings")
            .then(data => {
                setConfig(data);
                if (data.timeouts?.analyze) {
                    frontendLogger.info('[Config]', 'Loaded timeout settings', {
                        analyze: data.timeouts.analyze
                    });
                }
            })
            .catch(err => console.error("Failed to fetch config:", err));
    }, []);

    // Simulate progress for smoother UX with timeout protection
    useEffect(() => {
        let interval: NodeJS.Timeout;
        let timeout: NodeJS.Timeout;
        if (analysisStep !== 'idle') {
            setProgress(0);
            interval = setInterval(() => {
                setProgress(prev => {
                    if (prev >= 90) return prev; // Cap at 90% until complete
                    return prev + Math.random() * 10;
                });
            }, 500);

            // Safety timeout: auto-reset after configurable time to prevent stuck overlay
            timeout = setTimeout(() => {
                console.warn('[Progress] Safety timeout triggered - resetting analysisStep');
                setAnalysisStep('idle');
            }, safetyTimeout);
        }
        return () => {
            clearInterval(interval);
            clearTimeout(timeout);
        };
    }, [analysisStep, safetyTimeout]);

    const isAnalysisActive = analysisStep !== 'idle';

    // 已等待时长的计时已下沉到 TopProgressBar 内部（ref 直接更新 DOM）。
    // 旧实现每 100ms setState 一次会让整个首页组件树每秒重渲染 10 次。

    // 组件卸载时终止进行中的请求
    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();
            if (abortTimerRef.current) clearTimeout(abortTimerRef.current);
        };
    }, []);

    const beginAnalysisRequest = () => {
        abortControllerRef.current?.abort();
        if (abortTimerRef.current) clearTimeout(abortTimerRef.current);
        const controller = new AbortController();
        abortControllerRef.current = controller;
        cancelRequestedRef.current = false;
        abortTimerRef.current = setTimeout(() => controller.abort(), aiTimeout);
        return controller;
    };

    const finishAnalysisRequest = () => {
        if (abortTimerRef.current) {
            clearTimeout(abortTimerRef.current);
            abortTimerRef.current = null;
        }
        abortControllerRef.current = null;
    };

    const cancelAnalysis = () => {
        if (!abortControllerRef.current) return;
        cancelRequestedRef.current = true;
        abortControllerRef.current.abort();
        toast.info(language === 'zh' ? '已取消本次 AI 分析' : 'AI analysis cancelled');
    };

    const onImageSelect = (file: File) => {
        const imageUrl = URL.createObjectURL(file);
        setCroppingImage(imageUrl);
        setIsCropperOpen(true);
    };

    const handleCropComplete = async (croppedBlob: Blob) => {
        setIsCropperOpen(false);
        // Convert Blob to File
        const file = new File([croppedBlob], "cropped-image.jpg", { type: "image/jpeg" });
        handleAnalyze(file);
    };

    const handleAnalyze = async (file: File) => {
        const startTime = Date.now();
        frontendLogger.info('[HomeAnalyze]', 'Starting analysis flow', {
            timeoutSettings: {
                apiTimeout: aiTimeout,
                safetyTimeout
            }
        });

        const controller = beginAnalysisRequest();

        try {
            frontendLogger.info('[HomeAnalyze]', 'Step 1/5: Compressing image');
            setAnalysisStep('compressing');
            const base64Image = await processImageFile(file);
            if (controller.signal.aborted) return;
            setCurrentImage(base64Image);
            frontendLogger.info('[HomeAnalyze]', 'Image compressed successfully', {
                size: base64Image.length
            });

            frontendLogger.info('[HomeAnalyze]', 'Step 2/5: Calling API endpoint /api/analyze (stream)');
            phaseStartedAtRef.current = Date.now();
            setAnalysisStep('analyzing');
            // 立即进入 review 视图，字段随流式内容逐段填充
            streamRawRef.current = "";
            lastFlushRef.current = 0;
            setStreamParsed({});
            setIsStreaming(true);
            setParsedData(null);
            setStep("review");
            const apiStartTime = Date.now();
            let data: AnalyzeResponse = {} as AnalyzeResponse;

            const runStream = (mode: "deep" | "fast") => {
                streamRawRef.current = "";
                lastFlushRef.current = 0;
                setStreamParsed({});
                return streamAnalyze({
                    imageBase64: base64Image,
                    language: language,
                    subjectId: initialNotebookId || autoSelectedNotebookId || undefined,
                    reasoningMode: mode,
                    timeout: aiTimeout,
                    signal: controller.signal,
                    onDelta: (text) => {
                        streamRawRef.current += text;
                        const now = Date.now();
                        if (now - lastFlushRef.current > 80) {
                            lastFlushRef.current = now;
                            setStreamParsed(parsePartialXml(streamRawRef.current));
                        }
                    },
                    onDone: (result) => {
                        data = result;
                        setStreamParsed(parsePartialXml(streamRawRef.current));
                    },
                    onError: (msg) => { const e: any = new Error(msg); e.data = { message: msg }; throw e; },
                });
            };

            try {
                await runStream(thinkingMode);
            } catch (streamError: any) {
                // 快速模式（关闭思考）偶发漏输出 <question_text> 等必需标签，重跑同样大概率再漏，
                // 这里直接改用深度思考重试一次，避免用户白等一场还要自己再点一次。
                const message = String(streamError?.data?.message || streamError?.message || "");
                const missingTags = message.includes("Missing critical XML tags");
                if (!missingTags || thinkingMode !== "fast" || controller.signal.aborted) throw streamError;
                frontendLogger.warn('[HomeAnalyze]', 'Fast mode returned incomplete tags, retrying with deep thinking');
                toast.info(
                    language === "zh"
                        ? "快速模式输出不完整，已自动改用深度思考重试"
                        : "Fast mode returned incomplete output, retrying with deep thinking",
                );
                await runStream("deep");
            }
            const apiDuration = Date.now() - apiStartTime;
            frontendLogger.info('[HomeAnalyze]', 'API stream completed, validating data', {
                apiDuration
            });

            // Validate response data
            if (!data || typeof data !== 'object') {
                frontendLogger.error('[HomeAnalyze]', 'Validation failed - invalid response data', {
                    data
                });
                throw new Error('Invalid API response: data is null or not an object');
            }
            frontendLogger.info('[HomeAnalyze]', 'Response data validated successfully');

            frontendLogger.info('[HomeAnalyze]', 'Step 3/5: Setting processing state and progress to 100%');
            setAnalysisStep('processing');
            setProgress(100);
            frontendLogger.info('[HomeAnalyze]', 'Progress updated to 100%');

            frontendLogger.info('[HomeAnalyze]', 'Step 4/5: Setting parsed data and auto-selecting notebook');
            const dataSize = JSON.stringify(data).length;
            // 识别到学科就自动复用/新建对应错题本，并把选中的错题本直接写进结果，
            // 避免编辑器挂载时 autoSelectedNotebookId 尚未生效导致学科落空、被手填错。
            let subjectId: string | undefined;
            if (data.subject) {
                subjectId = await ensureNotebookForSubject(data.subject);
            }
            const setDataStart = Date.now();
            setParsedData(subjectId ? { ...data, subjectId } : data);
            const setDataDuration = Date.now() - setDataStart;
            frontendLogger.info('[HomeAnalyze]', 'Parsed data set successfully', {
                dataSize,
                setDataDuration
            });

            frontendLogger.info('[HomeAnalyze]', 'Step 5/5: Switching to review page');
            const setStepStart = Date.now();
            setIsStreaming(false);
            setStreamParsed({});
            setStep("review");
            const setStepDuration = Date.now() - setStepStart;
            frontendLogger.info('[HomeAnalyze]', 'Step switched to review', {
                setStepDuration
            });
            const totalDuration = Date.now() - startTime;
            frontendLogger.info('[HomeAnalyze]', 'Analysis completed successfully', {
                totalDuration
            });
        } catch (error: any) {
            if (cancelRequestedRef.current) {
                frontendLogger.info('[HomeError]', 'Analysis cancelled by user');
                setIsStreaming(false);
                setStreamParsed({});
                setStep("upload");
                return;
            }

            // 解析失败：退回上传页，避免停留在只有骨架的 review 视图
            setIsStreaming(false);
            setStreamParsed({});
            setStep("upload");

            const errorDuration = Date.now() - startTime;
            frontendLogger.error('[HomeError]', 'Analysis failed', {
                errorDuration,
                error: error.message || String(error)
            });

            // 安全的错误处理逻辑，防止在报错时二次报错
            try {
                let errorMessage = t.common?.messages?.analysisFailed || 'Analysis failed, please try again';

                // ApiError 的结构：error.data.message 包含后端返回的错误类型
                const backendErrorType = error?.data?.message;

                if (backendErrorType && typeof backendErrorType === 'string') {
                    // 检查是否是已知的 AI 错误类型
                    if (t.errors && typeof t.errors === 'object' && backendErrorType in t.errors) {
                        const mappedError = (t.errors as any)[backendErrorType];
                        if (typeof mappedError === 'string') {
                            errorMessage = mappedError;
                            frontendLogger.info('[HomeError]', `Matched error type: ${backendErrorType}`, {
                                errorMessage
                            });
                        }
                    } else {
                        // 使用后端返回的具体错误消息
                        errorMessage = backendErrorType;
                        frontendLogger.info('[HomeError]', 'Using backend error message', {
                            errorMessage
                        });
                    }
                } else if (error?.message) {
                    // Fallback：检查 error.message（用于非 API 错误）
                    if (error.message.includes('fetch') || error.message.includes('network')) {
                        errorMessage = t.errors?.AI_CONNECTION_FAILED || '网络连接失败';
                    } else if (typeof error.data === 'string') {
                        frontendLogger.info('[HomeError]', 'Raw error data', {
                            errorDataPreview: error.data.substring(0, 100)
                        });
                        errorMessage += ` (${error.status || 'Error'})`;
                    }
                }

                toast.error(errorMessage);
            } catch (innerError) {
                frontendLogger.error('[HomeError]', 'Failed to process error message', {
                    innerError: String(innerError)
                });
                toast.error('Analysis failed. Please try again.');
            }
        } finally {
            // Always reset analysis state, even if setState throws
            frontendLogger.info('[HomeAnalyze]', 'Finally: Resetting analysis state to idle');
            finishAnalysisRequest();
            setAnalysisStep('idle');
            frontendLogger.info('[HomeAnalyze]', 'Analysis state reset complete');
        }
    };

    /**
     * 按 AI 识别出的学科自动选中或创建错题本。
     * 已有相近名称（如「高中物理」）时复用，不重复创建。
     */
    const ensureNotebookForSubject = async (subject?: string | null): Promise<string | undefined> => {
        if (!subject) return undefined;
        // URL 里指定了错题本时尊重用户选择，不自动改
        if (initialNotebookId) return initialNotebookId;

        const findMatch = (list: { id: string; name: string }[]) => {
            const byName = list.find(n => n.name.includes(subject) || subject.includes(n.name));
            if (byName) return byName;
            const key = inferSubjectFromName(subject);
            if (!key) return undefined;
            return list.find(n => inferSubjectFromName(n.name) === key);
        };

        // 列表可能还没拉回来（分析比列表先完成），空列表会导致重复建同名错题本
        let pool: { id: string; name: string }[] = notebooks;
        if (!pool.length) {
            try {
                pool = await apiClient.get<Notebook[]>("/api/notebooks");
                setNotebooks(pool);
            } catch { /* 拉取失败则按空列表走创建流程 */ }
        }

        const existing = findMatch(pool);
        if (existing) {
            setAutoSelectedNotebookId(existing.id);
            return existing.id;
        }

        try {
            const created = await apiClient.post<Notebook>("/api/notebooks", { name: subject });
            createdNotebookIdRef.current = created.id;
            setNotebooks(prev => [{ id: created.id, name: created.name }, ...prev]);
            setAutoSelectedNotebookId(created.id);
            frontendLogger.info('[HomeAnalyze]', 'Auto-created notebook', { subject, id: created.id });
            return created.id;
        } catch (error: any) {
            // 同名冲突：并发或另一端已创建，重新拉列表复用
            if (error?.status === 409) {
                try {
                    const fresh = await apiClient.get<Notebook[]>("/api/notebooks");
                    setNotebooks(fresh);
                    const again = findMatch(fresh);
                    if (again) {
                        setAutoSelectedNotebookId(again.id);
                        return again.id;
                    }
                } catch { /* 走兜底，允许保存为未归档 */ }
            }
            frontendLogger.error('[HomeAnalyze]', 'Failed to auto-create notebook', { subject, error: String(error) });
            return undefined;
        }
    };

    /** 取消校对：回到上传页，并回收本次自动创建、尚未使用的空错题本 */
    const handleCancelReview = () => {
        const createdId = createdNotebookIdRef.current;
        createdNotebookIdRef.current = null;
        setAutoSelectedNotebookId(null);
        setParsedData(null);
        setCurrentImage(null);
        setStep("upload");
        if (createdId) {
            // DELETE 接口自带「含错题不可删」保护，不会误删已有数据
            apiClient.delete(`/api/notebooks/${createdId}`).catch(() => {});
        }
    };

    const handleSave = async (finalData: ParsedQuestion & { subjectId?: string }): Promise<void> => {
        frontendLogger.info('[HomeSave]', 'Starting save process', {
            hasQuestionText: !!finalData.questionText,
            hasAnswerText: !!finalData.answerText,
            subjectId: finalData.subjectId,
            knowledgePointsCount: finalData.knowledgePoints?.length || 0,
            hasImage: !!currentImage,
            imageSize: currentImage?.length || 0,
        });

        try {
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                ...finalData,
                originalImageUrl: currentImage || "",
            });

            // 检查是否是重复提交（后端去重返回）
            if (result.duplicate) {
                frontendLogger.info('[HomeSave]', 'Duplicate submission detected, using existing record');
            }

            frontendLogger.info('[HomeSave]', 'Save successful');
            // 本已被使用，取消逻辑不再回收它
            createdNotebookIdRef.current = null;
            setStep("upload");
            setParsedData(null);
            setCurrentImage(null);
            toast.success(t.common?.messages?.saveSuccess || 'Saved successfully!');

            // 保存后回到首页「录入新题」界面（清掉 ?notebook= 参数），不再跳进学科错题本
            router.replace("/");
        } catch (error: any) {
            frontendLogger.error('[HomeSave]', 'Save failed', {
                errorStatus: error?.status,
                errorMessage: error?.data?.message || error?.message || String(error),
                errorData: error?.data,
            });
            toast.error(t.common?.messages?.saveFailed || 'Failed to save');
        }
    };

    const getProgressMessage = () => {
        const isZh = language === 'zh';
        const analyzingElapsed = Date.now() - (phaseStartedAtRef.current ?? Date.now());
        let stage = "";
        switch (analysisStep) {
            case 'compressing':
                stage = isZh ? "正在压缩图片" : "Compressing image";
                break;
            case 'uploading':
                stage = isZh ? "正在上传" : "Uploading";
                break;
            case 'analyzing':
                stage = analyzingElapsed < 1000
                    ? (isZh ? "正在上传" : "Uploading")
                    : (isZh ? "AI 正在解析（通常 20–60 秒）" : "AI is analyzing (usually 20–60s)");
                break;
            case 'processing':
                stage = isZh ? "正在处理结果" : "Processing result";
                break;
            case 'saving':
                stage = isZh ? "正在保存" : "Saving";
                break;
            default:
                return "";
        }
        // 耗时由 TopProgressBar 自己显示（ref 更新，不触发首页重渲染）
        return stage;
    };

    return (
        <main className={`flex flex-col bg-background ${step === 'upload' ? 'h-[100dvh] overflow-hidden' : 'min-h-[100dvh]'}`}>
            <TopProgressBar
                status={analysisStep}
                progress={progress}
                message={getProgressMessage()}
                onCancel={['compressing', 'uploading', 'analyzing', 'processing'].includes(analysisStep) ? cancelAnalysis : undefined}
                cancelLabel={t.common?.cancel || '取消'}
            />

            <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3 p-3 pb-4 sm:gap-6 sm:p-4 sm:pb-8">
                {/* Header Section */}
                <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <UserWelcome />

                    <div className="flex w-full items-center justify-between gap-1 rounded-lg border bg-card p-2 shadow-sm sm:w-auto sm:shrink-0 sm:justify-end sm:gap-2">
                        <BroadcastNotification />
                        <SettingsDialog />
                        <VersionBadge />
                        <Button
                            variant="ghost"
                            size="icon"
                            className="rounded-full text-muted-foreground hover:text-destructive"
                            onClick={() => signOut({ callbackUrl: '/login' })}
                            title={t.app?.logout || 'Logout'}
                        >
                            <LogOut className="h-5 w-5" />
                        </Button>
                    </div>
                </div>

                <BatchBanner />

                {/* Action Center */}
                <div className={initialNotebookId ? "flex shrink-0 justify-center" : "grid shrink-0 grid-cols-2 gap-2 sm:gap-4 md:grid-cols-4"}>
                    <Button
                        size="lg"
                        className={`h-auto px-3 py-2.5 text-sm shadow-sm transition-all hover:shadow-md sm:px-8 sm:py-4 sm:text-base ${initialNotebookId ? "w-full max-w-md" : ""}`}
                        variant={step === "upload" ? "default" : "secondary"}
                        onClick={() => { setStep("upload"); setInputMode("image"); }}
                    >
                        <div className="flex items-center gap-2">
                            <Upload className="h-5 w-5" />
                            <span>{t.app.uploadNew}</span>
                        </div>
                    </Button>

                    {!initialNotebookId && (
                        <>
                            <Link href="/notebooks" className="w-full">
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto px-3 py-2.5 text-sm shadow-sm transition-all hover:shadow-md border hover:border-primary/50 hover:bg-accent/50 sm:px-8 sm:py-4 sm:text-base"
                                >
                                    <div className="flex items-center gap-2">
                                        <BookOpen className="h-5 w-5" />
                                        <span>{t.app.viewNotebook}</span>
                                    </div>
                                </Button>
                            </Link>

                            <Link href="/tags" className="w-full">
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto px-3 py-2.5 text-sm shadow-sm transition-all hover:shadow-md border hover:border-primary/50 hover:bg-accent/50 sm:px-8 sm:py-4 sm:text-base"
                                >
                                    <div className="flex items-center gap-2">
                                        <Tags className="h-5 w-5" />
                                        <span>{t.app?.tags || 'Tags'}</span>
                                    </div>
                                </Button>
                            </Link>

                            <Link href="/stats" className="w-full">
                                <Button
                                    variant="outline"
                                    size="lg"
                                    className="w-full h-auto px-3 py-2.5 text-sm shadow-sm transition-all hover:shadow-md border hover:border-primary/50 hover:bg-accent/50 sm:px-8 sm:py-4 sm:text-base"
                                >
                                    <div className="flex items-center gap-2">
                                        <BarChart3 className="h-5 w-5" />
                                        <span>{t.app?.stats || 'Stats'}</span>
                                    </div>
                                </Button>
                            </Link>
                        </>
                    )}
                </div>

                {step === "upload" && (
                    <div className="flex min-h-0 flex-1 flex-col gap-2 sm:gap-4">
                        {/* 两个 tab：拍照上传（唯一入口，多选自动转批量）/ 批量进展跟踪 */}
                        <div className="flex shrink-0 gap-1 border-b sm:gap-2">
                            <button
                                className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-2 text-xs font-medium transition-colors sm:flex-none sm:gap-2 sm:px-4 sm:py-2.5 sm:text-sm ${
                                    inputMode === "image"
                                        ? "border-primary text-primary"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("image")}
                            >
                                <Upload className="h-4 w-4 shrink-0" />
                                {t.app?.uploadImage || "拍照上传"}
                            </button>
                            <button
                                className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-2 text-xs font-medium transition-colors sm:flex-none sm:gap-2 sm:px-4 sm:py-2.5 sm:text-sm ${
                                    inputMode === "batch"
                                        ? "border-amber-500 text-amber-600 dark:text-amber-400"
                                        : hasActiveBatchHint
                                            ? "border-transparent text-amber-600 hover:text-amber-700 dark:text-amber-400"
                                            : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("batch")}
                            >
                                <Images className="h-4 w-4 shrink-0" />
                                {t.batch?.tab || "批量进展跟踪"}
                                {hasActiveBatchHint && (
                                    <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white">
                                        {activeBatches.length}
                                    </span>
                                )}
                            </button>
                        </div>

                        {/* 思考深度：单张与批量共用这一个设置；跟踪 tab 不涉及新批次参数，隐藏 */}
                        <div className={`${inputMode === "image" ? "flex" : "hidden"} shrink-0 items-center justify-between gap-2 rounded-lg border bg-card px-2.5 py-1.5 shadow-sm sm:px-3 sm:py-2`}>
                            <div className="min-w-0">
                                <p className="text-xs font-medium leading-tight">
                                    {t.app?.thinkingMode || "思考深度"}
                                </p>
                                <p className="truncate text-[10px] leading-tight text-muted-foreground sm:text-xs">
                                    {thinkingMode === "fast"
                                        ? (t.app?.thinkingFastHint || "关闭思考，约 10 秒；复杂题更容易算错")
                                        : (t.app?.thinkingDeepHint || "深度思考，约 40–80 秒；正确率更高")}
                                </p>
                            </div>
                            <ThinkingModeToggle
                                value={thinkingMode}
                                onChange={setThinkingMode}
                                disabled={isAnalysisActive}
                            />
                        </div>

                        {/* 拍照上传：保持挂载，切 tab 不丢已选图片 */}
                        <div className={`${inputMode === "image" ? "flex" : "hidden"} min-h-0 flex-1 flex-col ${batchFiles.length ? "pb-20" : ""}`}>
                            <UploadZone
                                onImageSelect={onImageSelect}
                                onImagesSelect={(files) => {
                                    // 多选 = 批量：轻确认，不直接开跑
                                    setBatchFiles(files);
                                }}
                                isAnalyzing={analysisStep !== 'idle'}
                                fill
                            />
                        </div>

                        {/* 批量进展跟踪：多任务视图 */}
                        <div className={inputMode === "batch" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}>
                            <BatchJobList
                                jobs={activeBatches.map((j) => ({
                                    id: j.id,
                                    status: j.status,
                                    reasoningMode: j.reasoningMode,
                                    totalCount: j.counts.total || j.totalCount,
                                    doneCount: (j.counts.done || 0) + (j.counts.saved || 0),
                                    failedCount: j.counts.failed || j.failedCount || 0,
                                    savedCount: j.counts.saved || 0,
                                    createdAt: j.createdAt,
                                }))}
                                onOpen={(id) => router.push(`/batch?id=${id}`)}
                            />
                            <Link
                                href="/batch"
                                className="mt-3 flex items-center justify-center gap-0.5 pb-2 text-[11px] text-muted-foreground hover:text-primary sm:text-xs"
                            >
                                {t.batch?.history || "查看全部批次"}
                                <ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                        </div>
                    </div>
                )}

                {croppingImage && (
                    <ImageCropper
                        imageSrc={croppingImage}
                        open={isCropperOpen}
                        onClose={() => setIsCropperOpen(false)}
                        onCropComplete={handleCropComplete}
                    />
                )}

                {step === "review" && (
                    isStreaming ? (
                        <StreamingReview data={streamParsed} imagePreview={currentImage} />
                    ) : parsedData ? (
                        <CorrectionEditor
                            initialData={parsedData}
                            onSave={handleSave}
                            onCancel={handleCancelReview}
                            imagePreview={currentImage}
                            initialSubjectId={initialNotebookId || autoSelectedNotebookId || undefined}
                            aiTimeout={aiTimeout}
                        />
                    ) : null
                )}

            </div>

            {/* 多选后的轻确认条：确认才建批次，避免手滑直接花钱 */}
            <BatchQuickConfirm files={batchFiles} onCancel={() => setBatchFiles([])} />
        </main>
    );
}

export default function Home() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <HomeContent />
        </Suspense>
    );
}
