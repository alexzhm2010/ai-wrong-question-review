import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { calculateGradeNumber, inferSubjectFromName } from "@/lib/knowledge-tags";
import { calculateGrade } from "@/lib/grade-calculator";
import { normalizeGradeSemester } from "@/lib/grade-options";
import { prisma } from "@/lib/prisma";
import { badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAppConfig } from "@/lib/config";
import { withoutMistakeAnalysis } from "@/lib/ai/response-guard";

const logger = createLogger('api:analyze');

// Vercel 函数最大执行时长（Hobby 上限 60s；Docker 部署不受此限制）
export const maxDuration = 60;

export const dynamic = 'force-dynamic';

// 已知 AI 错误类型映射：将异常 message 归一化为前端可识别的错误码
function normalizeAIErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (
        message === 'AI_CONNECTION_FAILED' ||
        message === 'AI_RESPONSE_ERROR' ||
        message.includes('AI_AUTH_ERROR') ||
        message === 'AI_TIMEOUT_ERROR' ||
        message === 'AI_QUOTA_EXCEEDED' ||
        message === 'AI_PERMISSION_DENIED' ||
        message === 'AI_NOT_FOUND' ||
        message === 'AI_SERVICE_UNAVAILABLE' ||
        message === 'AI_UNKNOWN_ERROR'
    ) {
        return message.includes('AI_AUTH_ERROR') ? 'AI_AUTH_ERROR' : message;
    }
    if (message?.includes('Zod') || message?.includes('validate')) {
        return 'AI_RESPONSE_ERROR';
    }
    return message;
}

export async function POST(req: Request) {
    logger.info('Analyze API called');

    const session = await getServerSession(authOptions);

    // 认证检查
    if (!session) {
        logger.warn('Unauthorized access attempt');
        return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        let { imageBase64, mimeType, language, subjectId } = body;

        logger.debug({
            imageLength: imageBase64?.length,
            mimeType,
            language,
            subjectId
        }, 'Request received');

        if (!imageBase64) {
            logger.warn('Missing image data');
            return badRequest("Missing image data");
        }

        // Parse Data URL if present
        if (imageBase64.startsWith('data:')) {
            const matches = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
                mimeType = matches[1];
                imageBase64 = matches[2];
                logger.debug({ mimeType, base64Length: imageBase64.length }, 'Parsed Data URL');
            }
        }

        // 先获取用户年级信息，用于动态生成 AI prompt 中的标签列表
        let userGrade: 7 | 8 | 9 | 10 | 11 | 12 | null = null;
        let userGradeSemester: string | null = null;
        let subjectName: 'math' | 'physics' | 'chemistry' | 'biology' | 'english' | 'chinese' | 'history' | 'geography' | 'politics' | null = null;

        if (session?.user?.email) {
            try {
                // 获取用户信息
                const user = await prisma.user.findUnique({
                    where: { email: session.user.email },
                    select: { educationStage: true, enrollmentYear: true }
                });

                if (user) {
                    userGrade = calculateGradeNumber(user.educationStage, user.enrollmentYear);
                    if (user.educationStage && user.enrollmentYear) {
                        // 只把标准年级注入提示词，避免「已毕业上」这类脏值干扰模型
                        userGradeSemester = normalizeGradeSemester(
                            calculateGrade(user.educationStage, user.enrollmentYear, new Date(), 'zh')
                        ) || null;
                    }
                    logger.debug({ userGrade, userGradeSemester }, 'Calculated user grade');
                }

                // 获取错题本信息以推断学科
                if (subjectId) {
                    const subject = await prisma.subject.findUnique({
                        where: { id: subjectId },
                        select: { name: true }
                    });

                    if (subject) {
                        subjectName = inferSubjectFromName(subject.name);
                        logger.debug({ subjectName, subjectDisplayName: subject.name }, 'Inferred subject');
                    }
                }
            } catch (error) {
                logger.error({ error }, 'Error fetching user/subject info');
                // 继续执行，不传递年级参数（会返回所有年级的标签）
            }
        }

        // 将内部科目名称转换为中文科目名称
        const subjectNameMapping: Record<string, string> = {
            'math': '数学',
            'physics': '物理',
            'chemistry': '化学',
            'biology': '生物',
            'english': '英语',
            'chinese': '语文',
            'history': '历史',
            'geography': '地理',
            'politics': '政治',
        };
        const subjectChinese = subjectName ? subjectNameMapping[subjectName] : null;

        logger.info({ userGrade, userGradeSemester, subject: subjectChinese }, 'Calling AI service for image analysis (streaming)');
        const aiService = await getAIService();

        // 以 SSE 流式返回：逐段推送 delta，结束后推送结构化 result，异常推送 error
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const send = (obj: unknown) => {
                    try {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                    } catch {
                        // 控制器已关闭，忽略
                    }
                };
                try {
                    const result = await aiService.analyzeImageStream(
                        imageBase64,
                        mimeType,
                        language,
                        userGrade,
                        subjectChinese,
                        userGradeSemester,
                        (delta) => send({ type: 'delta', content: delta })
                    );
                    // 关闭「AI 错因分析」后只归档题目/答案/解析
                    const config = await getAppConfig();
                    const finalResult = withoutMistakeAnalysis(
                        result,
                        config.aiOptions?.enableMistakeAnalysis !== false
                    );
                    send({ type: 'done', result: finalResult });
                } catch (error: any) {
                    const errorMessage = normalizeAIErrorMessage(error);
                    logger.error({ errorMessage }, 'Streaming analysis failed');
                    send({ type: 'error', message: errorMessage });
                } finally {
                    try { controller.close(); } catch { /* noop */ }
                }
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        });
    } catch (error: any) {
        logger.error({
            error: error.message,
            stack: error.stack
        }, 'Analysis request error');

        let errorMessage = error.message || "Failed to analyze image";
        if (error.message?.includes('Zod') || error.message?.includes('validate')) {
            errorMessage = 'AI_RESPONSE_ERROR';
        }

        return createErrorResponse(errorMessage, 500, ErrorCode.AI_ERROR, error.message);
    }
}
