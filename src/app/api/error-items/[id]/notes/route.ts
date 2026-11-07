import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { unauthorized, internalError, badRequest, notFound } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:error-items:notes');

export async function PATCH(
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

        const { userNotes } = await req.json();
        if (typeof userNotes !== 'string' && userNotes !== null && userNotes !== undefined) {
            return badRequest("userNotes must be a string or null");
        }
        const normalizedNotes = typeof userNotes === 'string' ? userNotes : null;

        // C-01：把归属条件放进 where，用 updateMany 原子完成「校验 + 更新」，
        // 避免按 id 直接 update 造成的越权写入（IDOR）与 TOCTOU 竞态。
        const result = await prisma.errorItem.updateMany({
            where: { id, userId: user.id },
            data: { userNotes: normalizedNotes },
        });

        if (result.count === 0) {
            return notFound("Item not found");
        }

        return NextResponse.json({ id, userNotes: normalizedNotes });
    } catch (error) {
        logger.error({ error }, 'Error updating notes');
        return internalError("Failed to update notes");
    }
}
