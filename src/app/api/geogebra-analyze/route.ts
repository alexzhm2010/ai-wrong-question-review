import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { getAIService } from "@/lib/ai";
import { isNonGeogebraSubject } from "@/lib/geogebra-subject";

const logger = createLogger('api:geogebra-analyze');

/**
 * General-purpose GeoGebra analysis endpoint.
 * Used by the correction editor where the error item hasn't been saved yet.
 * Does NOT require an item ID.
 */
// Vercel 函数最大执行时长（Hobby 上限 60s；Docker 部署不受此限制）
export const maxDuration = 60;

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    try {
        if (!session?.user?.email) {
            return unauthorized("Authentication required");
        }

        const body = await req.json();
        const { questionText, answerText, analysis, subjectName, previousErrors } = body;

        if (!questionText?.trim()) {
            return NextResponse.json(
                { suitable: false, commands: [], description: "题目文本为空" },
                { status: 400 }
            );
        }

        // 明确是非理科时直接短路：语文 / 英语 / 化学等题不必白跑一次 AI 调用。
        // 学科未知时放行，交给 AI 判断是否适合演示（与详情页接口行为一致）。
        if (isNonGeogebraSubject(subjectName)) {
            return NextResponse.json({
                suitable: false,
                commands: [],
                description: "仅数学和物理题目支持 GeoGebra 动态演示",
            });
        }

        const aiService = await getAIService();
        const result = await aiService.analyzeForGeogebra(
            questionText,
            answerText || "",
            analysis || "",
            typeof previousErrors === "string" ? previousErrors : ""
        );

        logger.info({ suitable: result.suitable, commandCount: result.commands.length }, 'GeoGebra analysis complete');

        return NextResponse.json(result);
    } catch (error) {
        logger.error({ error }, 'Error during GeoGebra analysis');

        const errorMsg = error instanceof Error ? error.message : String(error);

        if (errorMsg.startsWith("AI_")) {
            return NextResponse.json(
                { message: errorMsg },
                { status: 502 }
            );
        }

        return NextResponse.json(
            { message: "Failed to analyze for GeoGebra" },
            { status: 500 }
        );
    }
}
