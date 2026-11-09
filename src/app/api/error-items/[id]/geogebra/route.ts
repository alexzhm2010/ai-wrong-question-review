import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, forbidden, notFound, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAIService } from "@/lib/ai";
import { isNonGeogebraSubject } from "@/lib/geogebra-subject";

const logger = createLogger('api:error-items:geogebra');

// Vercel 函数最大执行时长（Hobby 上限 60s；Docker 部署不受此限制）
export const maxDuration = 60;

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    try {
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
        }

        if (!user) {
            return unauthorized("Authentication required");
        }

        const errorItem = await prisma.errorItem.findUnique({
            where: { id },
            include: { subject: true },
        });

        if (!errorItem) {
            return notFound("Item not found");
        }

        if (errorItem.userId !== user.id) {
            return forbidden("Not authorized to access this item");
        }

        // 与 /api/geogebra-analyze 共用同一套学科门禁：明确非理科才拒绝。
        // 学科未设置（未归档）时放行，由 AI 判断，避免误拒几何题。
        const subjectName = errorItem.subject?.name || "";
        if (isNonGeogebraSubject(subjectName)) {
            return NextResponse.json({
                suitable: false,
                commands: [],
                description: "仅数学和物理题目支持 GeoGebra 动态演示",
            });
        }

        if (!errorItem.questionText) {
            return NextResponse.json({
                suitable: false,
                commands: [],
                description: "题目文本为空，无法分析",
            });
        }

        const aiService = await getAIService();

        // Use frontend-provided data if available (more up-to-date), fall back to DB
        const body = await req.json().catch(() => ({}));
        const questionText = body.questionText || errorItem.questionText;
        const answerText = body.answerText || errorItem.answerText || "";
        const previousErrors = body.previousErrors || "";

        const result = await aiService.analyzeForGeogebra(
            questionText,
            answerText,
            errorItem.analysis || "",
            previousErrors
        );

        // If suitable, save the commands to the database
        if (result.suitable && result.commands.length > 0) {
            await prisma.errorItem.update({
                where: { id },
                data: {
                    geogebraCommands: JSON.stringify(result.commands),
                },
            });
        }

        logger.info({ id, suitable: result.suitable, commandCount: result.commands.length }, 'GeoGebra analysis complete');

        return NextResponse.json(result);
    } catch (error) {
        logger.error({ error }, 'Error during GeoGebra analysis');

        const errorMsg = error instanceof Error ? error.message : String(error);

        // Pass through AI-specific errors
        if (errorMsg.startsWith("AI_")) {
            return NextResponse.json(
                { message: errorMsg },
                { status: 502 }
            );
        }

        return internalError("Failed to analyze for GeoGebra");
    }
}
