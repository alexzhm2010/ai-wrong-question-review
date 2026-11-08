"use client";

import { useState, Suspense, useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { UploadZone } from "@/components/upload-zone";
import { CorrectionEditor } from "@/components/correction-editor";
import { ImageCropper } from "@/components/image-cropper";
import { ParsedQuestion } from "@/lib/ai";
import { UserWelcome } from "@/components/user-welcome";
import { apiClient } from "@/lib/api-client";
import { AnalyzeResponse, Notebook, AppConfig } from "@/types/api";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile } from "@/lib/image-utils";
import { Upload, BookOpen, Tags, LogOut, BarChart3, PenLine } from "lucide-react";
import { SettingsDialog } from "@/components/settings-dialog";
import { BroadcastNotification } from "@/components/broadcast-notification";
import { VersionBadge } from "@/components/version-badge";
import { signOut } from "next-auth/react";

import type { ProgressStatus } from "@/components/ui/progress-feedback";
import { TopProgressBar } from "@/components/top-progress-bar";
import { StreamingReview } from "@/components/streaming-review";
import { parsePartialXml, type PartialParsed } from "@/lib/partial-parse";
import { frontendLogger } from "@/lib/frontend-logger";
import { toast } from "@/lib/toast";
import { TextInputZone } from "@/components/text-input-zone";
import { DirectTextEditor } from "@/components/direct-text-editor";
import { streamAnalyze } from "@/lib/stream-analyze";

function HomeContent() {
    const [step, setStep] = useState<"upload" | "review">("upload");
    const [analysisStep, setAnalysisStep] = useState<ProgressStatus>('idle');
    const [progress, setProgress] = useState(0);
    const [parsedData, setParsedData] = useState<ParsedQuestion | null>(null);
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

    // Cancellation + elapsed time for AI analysis
    const [elapsedMs, setElapsedMs] = useState(0);
    const analysisStartedAtRef = useRef<number | null>(null);
    const phaseStartedAtRef = useRef<number | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelRequestedRef = useRef(false);

    // Input mode: "image" for photo upload, "text" for AI solve, "direct" for manual entry
    const [inputMode, setInputMode] = useState<"image" | "text" | "direct">("image");

    // Cropper state
    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const [isCropperOpen, setIsCropperOpen] = useState(false);

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

    // 每 100ms 更新已等待时长（整个 AI 流程累计，不随阶段重置）
    useEffect(() => {
        if (!isAnalysisActive) {
            analysisStartedAtRef.current = null;
            setElapsedMs(0);
            return;
        }
        if (analysisStartedAtRef.current === null) {
            analysisStartedAtRef.current = Date.now();
        }
        const interval = setInterval(() => {
            setElapsedMs(Date.now() - (analysisStartedAtRef.current ?? Date.now()));
        }, 100);
        return () => clearInterval(interval);
    }, [isAnalysisActive]);

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
            await streamAnalyze({
                imageBase64: base64Image,
                language: language,
                subjectId: initialNotebookId || autoSelectedNotebookId || undefined,
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
            // Auto-select notebook based on subject
            if (data.subject) {
                const matchedNotebook = notebooks.find(n =>
                    n.name.includes(data.subject!) || data.subject!.includes(n.name)
                );
                if (matchedNotebook) {
                    setAutoSelectedNotebookId(matchedNotebook.id);
                    frontendLogger.info('[HomeAnalyze]', 'Auto-selected notebook', {
                        notebook: matchedNotebook.name,
                        subject: data.subject
                    });
                }
            }
            const setDataStart = Date.now();
            setParsedData(data);
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
            setStep("upload");
            setParsedData(null);
            setCurrentImage(null);
            toast.success(t.common?.messages?.saveSuccess || 'Saved successfully!');

            // Redirect to notebook page if subjectId is present
            if (finalData.subjectId) {
                router.push(`/notebooks/${finalData.subjectId}`);
            }
        } catch (error: any) {
            frontendLogger.error('[HomeSave]', 'Save failed', {
                errorStatus: error?.status,
                errorMessage: error?.data?.message || error?.message || String(error),
                errorData: error?.data,
            });
            toast.error(t.common?.messages?.saveFailed || 'Failed to save');
        }
    };

    const handleTextSubmit = async (questionText: string) => {
        const startTime = Date.now();
        frontendLogger.info('[HomeTextSubmit]', 'Starting text-based analysis', { textLength: questionText.length });

        const controller = beginAnalysisRequest();

        try {
            phaseStartedAtRef.current = Date.now();
            setAnalysisStep('analyzing');
            // 先进入 review 视图：题目已知，答案/解析以骨架等待填充
            setStreamParsed({ questionText });
            setIsStreaming(true);
            setParsedData(null);
            setStep("review");

            // Infer subject from auto-selected notebook
            const targetNotebookId = initialNotebookId || autoSelectedNotebookId;
            const matchedNotebook = targetNotebookId
                ? notebooks.find(n => n.id === targetNotebookId)
                : undefined;

            const result = await apiClient.post<{
                answerText: string;
                analysis: string;
                knowledgePoints: string[];
                wrongAnswerText: string;
                mistakeAnalysis: string;
                mistakeStatus: string;
            }>("/api/reanswer", {
                questionText,
                language,
                subject: matchedNotebook?.name || undefined,
            }, { timeout: aiTimeout, signal: controller.signal });

            setAnalysisStep('processing');
            setProgress(100);

            const parsed: ParsedQuestion = {
                questionText,
                answerText: result.answerText,
                analysis: result.analysis,
                knowledgePoints: result.knowledgePoints || [],
                wrongAnswerText: result.wrongAnswerText || "",
                mistakeAnalysis: result.mistakeAnalysis || "",
                mistakeStatus: (result.mistakeStatus as any) || "unknown",
                subject: "数学", // Default, will be overridden by notebook selection
                requiresImage: false,
            };

            setCurrentImage(null); // No image for text input
            setIsStreaming(false);
            setStreamParsed({});
            setParsedData(parsed);
            setStep("review");

            const totalDuration = Date.now() - startTime;
            frontendLogger.info('[HomeTextSubmit]', 'Text analysis completed', { totalDuration });
        } catch (error: any) {
            if (cancelRequestedRef.current) {
                frontendLogger.info('[HomeTextSubmit]', 'Analysis cancelled by user');
                setIsStreaming(false);
                setStreamParsed({});
                setStep("upload");
                return;
            }

            setIsStreaming(false);
            setStreamParsed({});
            setStep("upload");

            const errorDuration = Date.now() - startTime;
            frontendLogger.error('[HomeTextSubmit]', 'Analysis failed', {
                errorDuration,
                error: error.message || String(error)
            });

            try {
                let errorMessage = t.common?.messages?.analysisFailed || 'Analysis failed, please try again';
                const backendErrorType = error?.data?.message;
                if (backendErrorType && typeof backendErrorType === 'string') {
                    if (t.errors && typeof t.errors === 'object' && backendErrorType in t.errors) {
                        const mappedError = (t.errors as any)[backendErrorType];
                        if (typeof mappedError === 'string') errorMessage = mappedError;
                    } else {
                        errorMessage = backendErrorType;
                    }
                }
                toast.error(errorMessage);
            } catch {
                toast.error('Analysis failed. Please try again.');
            }
        } finally {
            finishAnalysisRequest();
            setAnalysisStep('idle');
        }
    };

    const handleDirectSave = async (data: {
        questionText: string;
        answerText: string;
        analysis: string;
        wrongAnswerText: string;
        mistakeAnalysis: string;
        mistakeStatus: string;
        knowledgePoints: string[];
        subjectId: string;
        gradeSemester?: string;
        paperLevel?: string;
    }): Promise<void> => {
        frontendLogger.info('[HomeDirectSave]', 'Starting direct save', {
            hasQuestionText: !!data.questionText,
            hasAnswerText: !!data.answerText,
            subjectId: data.subjectId,
        });

        try {
            setAnalysisStep('saving');
            const result = await apiClient.post<{ id: string; duplicate?: boolean }>("/api/error-items", {
                questionText: data.questionText,
                answerText: data.answerText,
                analysis: data.analysis,
                wrongAnswerText: data.wrongAnswerText || null,
                mistakeAnalysis: data.mistakeAnalysis || null,
                mistakeStatus: data.mistakeStatus || "unknown",
                knowledgePoints: data.knowledgePoints,
                subjectId: data.subjectId,
                gradeSemester: data.gradeSemester,
                paperLevel: data.paperLevel,
                originalImageUrl: "",
            });

            if (result.duplicate) {
                frontendLogger.info('[HomeDirectSave]', 'Duplicate detected');
            }

            frontendLogger.info('[HomeDirectSave]', 'Save successful');
            setAnalysisStep('idle');
            toast.success(t.common?.messages?.saveSuccess || 'Saved successfully!');

            if (data.subjectId) {
                router.push(`/notebooks/${data.subjectId}`);
            }
        } catch (error: any) {
            frontendLogger.error('[HomeDirectSave]', 'Save failed', {
                errorStatus: error?.status,
                errorMessage: error?.data?.message || error?.message || String(error),
            });
            setAnalysisStep('idle');
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
        const seconds = (elapsedMs / 1000).toFixed(1);
        return `${stage} · ${isZh ? `已等待 ${seconds} 秒` : `${seconds}s elapsed`}`;
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
                        {/* Input mode tabs */}
                        <div className="flex shrink-0 gap-1 overflow-x-auto border-b sm:gap-2">
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
                                    inputMode === "text"
                                        ? "border-primary text-primary"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("text")}
                            >
                                <PenLine className="h-4 w-4 shrink-0" />
                                {t.app?.manualInput || "AI解题"}
                            </button>
                            <button
                                className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-2 text-xs font-medium transition-colors sm:flex-none sm:gap-2 sm:px-4 sm:py-2.5 sm:text-sm ${
                                    inputMode === "direct"
                                        ? "border-primary text-primary"
                                        : "border-transparent text-muted-foreground hover:text-foreground"
                                }`}
                                onClick={() => setInputMode("direct")}
                            >
                                <PenLine className="h-4 w-4 shrink-0" />
                                直接录入
                            </button>
                        </div>

                        {inputMode === "image" ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                                <UploadZone onImageSelect={onImageSelect} isAnalyzing={analysisStep !== 'idle'} fill />
                            </div>
                        ) : inputMode === "text" ? (
                            <div className="min-h-0 flex-1 overflow-y-auto">
                                <TextInputZone
                                    onSubmit={handleTextSubmit}
                                    isAnalyzing={analysisStep !== 'idle'}
                                    defaultNotebookName={
                                        (initialNotebookId || autoSelectedNotebookId)
                                            ? notebooks.find(n => n.id === (initialNotebookId || autoSelectedNotebookId))?.name
                                            : undefined
                                    }
                                />
                            </div>
                        ) : (
                            <div className="min-h-0 flex-1 overflow-y-auto">
                                <DirectTextEditor
                                    onSubmit={handleDirectSave}
                                    defaultNotebookId={initialNotebookId || autoSelectedNotebookId || undefined}
                                    defaultNotebookName={
                                        (initialNotebookId || autoSelectedNotebookId)
                                            ? notebooks.find(n => n.id === (initialNotebookId || autoSelectedNotebookId))?.name
                                            : undefined
                                    }
                                    isSaving={analysisStep === 'saving'}
                                />
                            </div>
                        )}
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
                            onCancel={() => setStep("upload")}
                            imagePreview={currentImage}
                            initialSubjectId={initialNotebookId || autoSelectedNotebookId || undefined}
                            aiTimeout={aiTimeout}
                        />
                    ) : null
                )}

            </div>
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
