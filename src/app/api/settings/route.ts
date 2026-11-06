import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getAppConfig, updateAppConfig } from "@/lib/config";
import { forbidden, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import type { AppConfig, OpenAIInstance } from "@/types/api";

const logger = createLogger('api:settings');

export const dynamic = 'force-dynamic';

const MASKED_KEY = '********';

function maskConfig(config: AppConfig): AppConfig {
    return {
        ...config,
        gemini: config.gemini ? { ...config.gemini, apiKey: MASKED_KEY } : config.gemini,
        azure: config.azure ? { ...config.azure, apiKey: MASKED_KEY } : config.azure,
        openai: config.openai
            ? {
                ...config.openai,
                instances: (config.openai.instances || []).map((instance) => ({
                    ...instance,
                    apiKey: MASKED_KEY,
                })),
            }
            : config.openai,
    };
}

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    const config = await getAppConfig();
    return NextResponse.json(maskConfig(config));
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return unauthorized("Authentication required");
    }
    if (session.user.role !== 'admin') {
        return forbidden("Administrator access required");
    }

    try {
        const body = await req.json();
        const currentConfig = await getAppConfig();

        // Don't save masked keys if they somehow get sent back (for Gemini)
        if (body.gemini?.apiKey === MASKED_KEY) {
            // 保留原有的 API Key
            body.gemini.apiKey = currentConfig.gemini?.apiKey;
        }

        // For OpenAI instances, preserve original keys for masked entries
        if (body.openai?.instances) {
            const currentInstances = currentConfig.openai?.instances || [];
            body.openai.instances = body.openai.instances.map((instance: OpenAIInstance) => {
                if (instance.apiKey === MASKED_KEY) {
                    // 查找原有实例并保留其 API Key
                    const originalInstance = currentInstances.find((i) => i.id === instance.id);
                    return {
                        ...instance,
                        apiKey: originalInstance?.apiKey || '',
                    };
                }
                return instance;
            });
        }

        // For Azure, preserve original key if masked
        if (body.azure?.apiKey === MASKED_KEY) {
            body.azure.apiKey = currentConfig.azure?.apiKey;
        }

        const updatedConfig = await updateAppConfig(body);
        return NextResponse.json(maskConfig(updatedConfig));
    } catch (error) {
        logger.error({ error }, 'Failed to update settings');
        return internalError("Failed to update settings");
    }
}
