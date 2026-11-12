/**
 * /api/ai/models 单元测试
 *
 * 覆盖 P0 审查 B-01 修复后的契约：
 * - POST + JSON body（apiKey 不再走 URL query）
 * - 必须登录且必须是 admin
 * - 出站 baseUrl 经 SSRF 校验后才允许发起 fetch
 * - 上游失败返回 502，不再伪装成 200 成功
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    assertSafeOutboundUrl: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    })),
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession,
    default: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ authOptions: {} }));

vi.mock('@/lib/ssrf-guard', () => ({
    assertSafeOutboundUrl: mocks.assertSafeOutboundUrl,
    UnsafeOutboundUrlError: class UnsafeOutboundUrlError extends Error {},
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST } from '@/app/api/ai/models/route';

function makeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest(new URL('http://localhost/api/ai/models'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /api/ai/models', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'admin-1', role: 'admin', email: 'admin@localhost' },
        });
        mocks.assertSafeOutboundUrl.mockImplementation(async (raw: string) => {
            if (/internal|localhost|127\.0\.0\.1|169\.254/.test(raw)) {
                throw new Error('Outbound host resolves to a private or reserved address');
            }
            return new URL(raw);
        });
    });

    it('未登录时应返回 401 且不发起任何出站请求', async () => {
        mocks.getServerSession.mockResolvedValue(null);

        const res = await POST(makeRequest({ provider: 'gemini', apiKey: 'test-key' }));

        expect(res.status).toBe(401);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('非 admin 登录用户应返回 403', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: { id: 'u-2', role: 'user', email: 'u@example.com' },
        });

        const res = await POST(makeRequest({ provider: 'gemini', apiKey: 'test-key' }));

        expect(res.status).toBe(403);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('缺少 apiKey 应返回 400', async () => {
        const res = await POST(makeRequest({ provider: 'gemini' }));

        expect(res.status).toBe(400);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('内网 baseUrl 应被拒绝（400）且不发起出站请求', async () => {
        const res = await POST(makeRequest({
            provider: 'openai',
            apiKey: 'test-key',
            baseUrl: 'http://127.0.0.1:8080/v1',
        }));

        expect(res.status).toBe(400);
        expect(mocks.assertSafeOutboundUrl).toHaveBeenCalledWith('http://127.0.0.1:8080/v1');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('应正确获取并返回 Gemini 模型列表', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                models: [
                    { name: 'models/gemini-2.0-flash' },
                    { name: 'models/gemini-1.5-pro' },
                    { name: 'models/gemini-2.5-flash' },
                ],
            }),
        });

        const res = await POST(makeRequest({ provider: 'gemini', apiKey: 'test-key' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toHaveLength(3);
        expect(body.models[0]).toEqual({
            id: 'gemini-2.0-flash',
            name: 'gemini-2.0-flash',
            owned_by: 'Google',
        });
        expect(body.models[1].id).toBe('gemini-1.5-pro');
        expect(body.models[2].id).toBe('gemini-2.5-flash');
        // 请求路径本身不带任何密钥参数
        expect(String(mockFetch.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
    });

    it('应使用校验后的自定义 baseUrl 请求 OpenAI 兼容接口', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: [{ id: 'qwen3-vl-plus', owned_by: 'alibaba' }] }),
        });

        const res = await POST(makeRequest({
            provider: 'openai',
            apiKey: 'test-key',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models[0].id).toBe('qwen3-vl-plus');
        expect(String(mockFetch.mock.calls[0][0]))
            .toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models');
    });

    it('API 返回空 models 数组时应返回空列表', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) });

        const res = await POST(makeRequest({ provider: 'gemini', apiKey: 'test-key' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.models).toEqual([]);
    });

    it('上游失败应返回 502，而不是伪装成 200 成功', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

        const res = await POST(makeRequest({ provider: 'gemini', apiKey: 'bad-key' }));
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.models).toEqual([]);
        // L-01：不回显上游错误细节
        expect(body.error).toBe('Failed to fetch models');
    });

    it('fetch 应禁用重定向跟随并设置超时', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });

        await POST(makeRequest({ provider: 'openai', apiKey: 'test-key' }));

        const init = mockFetch.mock.calls[0][1];
        expect(init.redirect).toBe('manual');
        expect(init.signal).toBeDefined();
    });
});
