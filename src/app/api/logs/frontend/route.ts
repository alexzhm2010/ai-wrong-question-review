import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { createLogger } from '@/lib/logger';

const logger = createLogger('frontend-logs');

export const runtime = 'nodejs';

const MAX_LOGS_PER_BATCH = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PREFIX_LENGTH = 100;
const MAX_URL_LENGTH = 500;
const MAX_CONTEXT_VALUE_LENGTH = 500;

/** 只允许这些字段进入日志上下文，避免客户端注入任意键覆盖审计字段 */
const ALLOWED_CONTEXT_KEYS = [
    'component', 'action', 'errorCode', 'status', 'durationMs', 'itemId',
] as const;

interface FrontendLogEntry {
    level?: string;
    prefix?: string;
    message?: string;
    context?: Record<string, unknown>;
    timestamp?: string;
    url?: string;
}

/**
 * POST /api/logs/frontend
 *
 * M-01：原实现无鉴权、数组无上限、且用 ...context 把客户端对象整体展开进日志，
 * 匿名者可伪造审计日志或一次性打满日志配额。现在要求登录，并对条数、
 * 字段长度、上下文字段做白名单限制。
 */
export async function POST(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ success: false }, { status: 401 });
    }

    try {
        const body = await request.json();
        const rawLogs: FrontendLogEntry[] = Array.isArray(body?.logs) ? body.logs : [body];

        if (rawLogs.length > MAX_LOGS_PER_BATCH) {
            return NextResponse.json(
                { success: false, message: 'Too many log entries' },
                { status: 413 }
            );
        }

        let written = 0;
        for (const entry of rawLogs) {
            if (!entry || typeof entry !== 'object') continue;

            const message = typeof entry.message === 'string'
                ? entry.message.slice(0, MAX_MESSAGE_LENGTH)
                : '';
            if (!message) continue;

            const prefix = typeof entry.prefix === 'string'
                ? entry.prefix.slice(0, MAX_PREFIX_LENGTH)
                : 'frontend';
            const level = ['info', 'warn', 'error'].includes(entry.level || '')
                ? entry.level
                : 'info';

            // 只挑选白名单字段，且统一截断字符串值
            const context: Record<string, unknown> = {};
            if (entry.context && typeof entry.context === 'object') {
                for (const key of ALLOWED_CONTEXT_KEYS) {
                    const value = entry.context[key];
                    if (value === undefined || value === null) continue;
                    context[key] = typeof value === 'string'
                        ? value.slice(0, MAX_CONTEXT_VALUE_LENGTH)
                        : typeof value === 'number' || typeof value === 'boolean'
                            ? value
                            : '[omitted]';
                }
            }

            const logContext = {
                source: 'frontend',
                userId: session.user.id,
                prefix,
                url: (typeof entry.url === 'string'
                    ? entry.url
                    : request.headers.get('referer') || '').slice(0, MAX_URL_LENGTH),
                userAgent: (request.headers.get('user-agent') || '').slice(0, MAX_URL_LENGTH),
                clientTime: typeof entry.timestamp === 'string'
                    ? entry.timestamp.slice(0, 50)
                    : undefined,
                ...context,
            };

            switch (level) {
                case 'error':
                    logger.error(logContext, message);
                    break;
                case 'warn':
                    logger.warn(logContext, message);
                    break;
                default:
                    logger.info(logContext, message);
            }
            written += 1;
        }

        return NextResponse.json({ success: true, count: written });
    } catch (error) {
        logger.error({ error }, 'Failed to process frontend log');
        return NextResponse.json({ success: false }, { status: 500 });
    }
}
