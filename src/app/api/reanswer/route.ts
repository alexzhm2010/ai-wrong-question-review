import { NextResponse } from "next/server";
import { getAIService } from "@/lib/ai";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { badRequest, createErrorResponse, ErrorCode } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAppConfig } from "@/lib/config";
import { withoutMistakeAnalysis } from "@/lib/ai/response-guard";
import { checkAiAvailability } from "@/lib/quota-guard";

const logger = createLogger('api:reanswer');

// Vercel 函数最大执行时长（Hobby 上限 60s；Docker 部署不受此限制）
export const maxDuration = 60;

export async function POST(req: Request) {
    logger.info('Reanswer API called');

    const session = await getServerSession(authOptions);

    // 认证检查
    if (!session) {
        logger.warn('Unauthorized access attempt');
        return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { questionText, language = 'zh', subject, imageBase64, gradeSemester } = body;

        logger.debug({
            questionLength: questionText?.length,
            language,
            subject,
            hasImage: !!imageBase64,
            gradeSemester
        }, 'Reanswer request received');

        if (!questionText || questionText.trim().length === 0) {
            logger.warn('Missing question text');
            return badRequest("Missing question text");
        }

        // 防欠费：免费额度到期即停（fail-safe）。
        const availability = await checkAiAvailability();
        if (!availability.allowed) {
            logger.warn({ code: availability.code }, 'AI call blocked by quota guard (reanswer)');
            return createErrorResponse('AI_QUOTA_BLOCKED', 402, ErrorCode.AI_ERROR);
        }

        const aiService = await getAIService();

        // 根据是否有图片选择不同的重新解题方式
        const result = await aiService.reanswerQuestion(questionText, language, subject, imageBase64, gradeSemester);

        logger.info('Reanswer successful');

        const config = await getAppConfig();
        const finalResult = withoutMistakeAnalysis(
            result,
            config.aiOptions?.enableMistakeAnalysis !== false
        );
        return NextResponse.json(finalResult);
    } catch (error: unknown) {
        const errorMessageFromError = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error({ error: errorMessageFromError, stack }, 'Reanswer error occurred');

        // L-01：只把已知的标准化错误码透传给前端做国际化，
        // 不再把上游 error.message（可能含端点、URL、网络细节）回显给调用方。
        const KNOWN_AI_CODES = [
            'AI_AUTH_ERROR',
            'AI_CONNECTION_FAILED',
            'AI_TIMEOUT_ERROR',
            'AI_QUOTA_EXCEEDED',
            'AI_QUOTA_BLOCKED',
            'AI_RESPONSE_ERROR',
        ] as const;
        const matchedCode = KNOWN_AI_CODES.find(code => errorMessageFromError.includes(code));

        return createErrorResponse(matchedCode || 'AI_UNKNOWN_ERROR', 500, ErrorCode.AI_ERROR);
    }
}
