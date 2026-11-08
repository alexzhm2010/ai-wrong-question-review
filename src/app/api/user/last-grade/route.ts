import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { normalizeGradeSemester } from "@/lib/grade-options";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:user:last-grade');

/**
 * GET /api/user/last-grade
 *
 * 返回当前用户最近一次保存错题时使用的「有效」年级，供新题预填。
 * 只取标准值，跳过历史脏数据（例如早年自动算出的「已毕业上」）。
 * 不调用任何 AI 能力。
 */
export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ gradeSemester: null });
        }

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            select: { id: true },
        });
        if (!user) {
            return NextResponse.json({ gradeSemester: null });
        }

        const recentItems = await prisma.errorItem.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 30,
            select: { gradeSemester: true },
        });

        for (const item of recentItems) {
            const normalized = normalizeGradeSemester(item.gradeSemester);
            if (normalized) {
                return NextResponse.json({ gradeSemester: normalized });
            }
        }

        return NextResponse.json({ gradeSemester: null });
    } catch (error) {
        logger.error({ error }, 'Failed to read last used grade');
        return NextResponse.json({ gradeSemester: null });
    }
}
