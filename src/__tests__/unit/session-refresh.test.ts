import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureFreshToken, getSession, setSession } from '@/lib/supabase/core';

function expiredSession(tokenPair = 'r1') {
    return {
        access_token: 'old-access',
        refresh_token: tokenPair,
        expires_at: Date.now() - 1000,
        token_type: 'bearer',
        user: { id: 'u1', email: 'admin@local.test', role: 'admin' },
    };
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('会话刷新', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('并发调用只发起一次 refresh，其余复用同一结果', async () => {
        setSession(expiredSession());
        let calls = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 20));
            return jsonResponse({ access_token: 'new-access', refresh_token: 'r2', expires_in: 3600 });
        }));

        const [a, b, c] = await Promise.all([
            ensureFreshToken(),
            ensureFreshToken(),
            ensureFreshToken(),
        ]);

        expect(calls).toBe(1);
        expect([a, b, c]).toEqual(['new-access', 'new-access', 'new-access']);
        expect(getSession()?.refresh_token).toBe('r2');
    });

    it('后到的请求拿到「已使用」的 400 时，沿用盘上已换好的新会话，不登出', async () => {
        setSession(expiredSession('r1'));
        vi.stubGlobal('fetch', vi.fn(async () => {
            // 模拟：另一个请求已经用 r1 换到了 r2
            setSession({ ...expiredSession('r2'), access_token: 'rotated-access', expires_at: Date.now() + 3600_000 });
            return jsonResponse({ message: 'Invalid Refresh Token: Already Used' }, 400);
        }));

        const token = await ensureFreshToken();

        expect(token).toBe('rotated-access');
        expect(getSession()).not.toBeNull();
    });

    it('弱网导致刷新请求抛错时保留会话，下次还能重试', async () => {
        setSession(expiredSession());
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }));

        const token = await ensureFreshToken();

        expect(token).toBe('');
        expect(getSession()?.refresh_token).toBe('r1');
    });

    it('refresh token 确实失效（401）时才清空会话', async () => {
        setSession(expiredSession());
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'invalid_grant' }, 401)));

        const token = await ensureFreshToken();

        expect(token).toBe('');
        expect(getSession()).toBeNull();
    });
});
