import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-utils";
import { forbidden, unauthorized } from "@/lib/api-errors";
import { getAppConfig } from "@/lib/config";
import { getQuotaSnapshot } from "@/lib/aliyun-bss";
import { checkAiAvailability } from "@/lib/quota-guard";
import { createLogger } from "@/lib/logger";

const logger = createLogger("api:ai-quota");

export const dynamic = "force-dynamic";

/** AI 额度看板：仅管理员可读，绝不返回 AccessKey 或 AK 前缀。 */
export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return unauthorized();
    }
    if (!requireAdmin(session)) {
        return forbidden();
    }

    try {
        const force = request.nextUrl.searchParams.get("refresh") === "1";
        const [snapshot, config, availability] = await Promise.all([
            getQuotaSnapshot(force),
            getAppConfig(),
            checkAiAvailability(),
        ]);

        return NextResponse.json(
            {
                ...snapshot,
                settings: {
                    warnThreshold: config.quota?.warnThreshold ?? 20,
                    freeQuotaExpireAt: config.quota?.freeQuotaExpireAt ?? "",
                    stopWhenFreeExpired: config.quota?.stopWhenFreeExpired !== false,
                },
                availability,
                provider: {
                    name: "阿里云百炼 DashScope",
                    model: config.openai?.instances?.[0]?.model || "qwen3-vl-plus",
                },
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        logger.error({ error }, "Failed to build AI quota snapshot");
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
