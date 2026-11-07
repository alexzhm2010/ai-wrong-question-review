import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { assertSafeOutboundUrl } from '@/lib/ssrf-guard';

const logger = createLogger('api:ai:models');

const FETCH_TIMEOUT_MS = 10_000;

const DEFAULT_BASE_URL = {
    gemini: 'https://generativelanguage.googleapis.com',
    openai: 'https://api.openai.com/v1',
} as const;

interface ModelInfo {
    id: string;
    name: string;
    owned_by?: string;
}

interface ModelsRequest {
    provider?: 'gemini' | 'openai';
    apiKey?: string;
    baseUrl?: string;
}

// 从模型 ID 中提取短名称
function extractModelName(modelId: string): string {
    // models/gemini-2.0-flash -> gemini-2.0-flash
    return modelId.replace(/^models\//, '');
}

/**
 * 统一的出站请求：禁止跟随重定向（避免 302 跳到内网）、强制超时。
 * 目标地址在调用前已经过 assertSafeOutboundUrl 校验。
 */
function outboundFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
}

async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/v1beta/models`);
    url.searchParams.set('key', apiKey);

    const response = await outboundFetch(url.toString(), {
        headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
        // 只记录状态码，不把上游响应体（可能含密钥回显）写入日志
        logger.warn({ status: response.status, provider: 'gemini' }, 'Gemini models API error');
        throw new Error('Gemini models API error');
    }

    const data = await response.json();
    return (data.models || [])
        .map((m: any) => {
            const id = extractModelName(m.name);
            return {
                id,
                name: id,
                owned_by: 'Google',
            };
        });
}

async function fetchOpenAIModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
    const url = `${baseUrl.replace(/\/$/, '')}/models`;

    const response = await outboundFetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        logger.warn({ status: response.status, provider: 'openai' }, 'OpenAI models API error');
        throw new Error('OpenAI models API error');
    }

    const data = await response.json();
    return (data.data || [])
        .map((model: any) => ({
            id: model.id,
            name: model.id,
            owned_by: model.owned_by,
        }));
}

/**
 * POST /api/ai/models
 *
 * 安全约束（对应 P0 审查 B-01）：
 * - 必须登录（原来完全无鉴权）
 * - apiKey / baseUrl 改由 POST body 传入，不再出现在 URL query（避免落入访问日志 / Referer）
 * - baseUrl 在发起请求前经 assertSafeOutboundUrl 校验，禁止内网 / 元数据 / 非 HTTPS 地址
 * - 上游失败返回 502 而非伪装成 200 成功，且不回显内部错误详情（L-01）
 */
export async function POST(req: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized', models: [] }, { status: 401 });
    }
    // AI 配置界面仅对管理员开放，与 POST /api/settings 的权限保持一致
    if (!requireAdmin(session)) {
        return NextResponse.json({ error: 'Forbidden', models: [] }, { status: 403 });
    }

    let body: ModelsRequest;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body', models: [] }, { status: 400 });
    }

    const provider = body.provider === 'gemini' ? 'gemini' : 'openai';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

    if (!apiKey) {
        return NextResponse.json({ error: 'API key is required', models: [] }, { status: 400 });
    }

    const rawBaseUrl =
        typeof body.baseUrl === 'string' && body.baseUrl.trim()
            ? body.baseUrl.trim()
            : DEFAULT_BASE_URL[provider];

    let safeBase: URL;
    try {
        safeBase = await assertSafeOutboundUrl(rawBaseUrl);
    } catch (error) {
        logger.warn(
            { provider, reason: error instanceof Error ? error.message : 'unknown' },
            'Rejected unsafe model-list baseUrl'
        );
        return NextResponse.json(
            { error: 'Unsafe or invalid API base URL', models: [] },
            { status: 400 }
        );
    }

    try {
        const models = provider === 'gemini'
            ? await fetchGeminiModels(apiKey, safeBase.toString())
            : await fetchOpenAIModels(apiKey, safeBase.toString());

        return NextResponse.json({ models });
    } catch (error) {
        // 详情只写服务端日志，对外固定文案
        logger.error({ error, provider }, 'Error fetching models');
        return NextResponse.json(
            { error: 'Failed to fetch models', models: [] },
            { status: 502 }
        );
    }
}
