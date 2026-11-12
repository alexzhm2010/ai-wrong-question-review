/**
 * 接口契约测试
 *
 * 背景：静态迁移后，前后端走的是浏览器桥接层（bridge.ts）。历史上已经因为
 * 「后端返回扁平对象、前端按嵌套读」崩过两次（/tags 整页白屏、/admin 与
 * /admin/user 报 Cannot read properties of undefined）。
 *
 * 这里把每个页面实际依赖的字段锁进断言：后端返回结构一旦变化，测试立刻失败，
 * 而不是等用户点进去白屏才发现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- 把 Supabase REST 与鉴权全部 mock 掉，只验证 handler 的输出契约 ----
const mocks = vi.hoisted(() => ({
    restJson: vi.fn(),
    restJsonPage: vi.fn(),
    requireUser: vi.fn(),
    requireAdmin: vi.fn(),
}));
const restJsonMock = mocks.restJson;
const restJsonPageMock = mocks.restJsonPage;
const requireUserMock = mocks.requireUser;

vi.mock('@/lib/supabase/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/supabase/core')>();
    return {
        ...actual,
        restJson: mocks.restJson,
        restJsonPage: mocks.restJsonPage,
        requireUser: mocks.requireUser,
        requireAdmin: mocks.requireAdmin,
        appUser: async () => ({ id: 'user-1', role: 'admin', auth_user_id: 'auth-1' }),
        getSession: () => ({ access_token: 't', user: { id: 'auth-1' } }),
        aiEdge: async () => new Response('{}'),
        nowIso: () => '2026-01-01T00:00:00.000Z',
        cuid: () => 'id-' + Math.random().toString(36).slice(2, 8),
    };
});

import { TAG_HANDLERS } from '@/lib/supabase/routes/tags';
import { ADMIN_HANDLERS } from '@/lib/supabase/routes/admin';
import type { RouteContext } from '@/lib/supabase/http';

function ctx(partial: Partial<RouteContext> & { parts: string[] }): RouteContext {
    return {
        method: 'GET',
        path: '/api/' + partial.parts.join('/'),
        query: new URLSearchParams(),
        body: null,
        ...partial,
    } as RouteContext;
}

async function call(handlers: any[], context: RouteContext) {
    for (const handler of handlers) {
        const res = await handler(context);
        if (res) return { res, data: await res.json() };
    }
    return { res: null as any, data: null as any };
}

beforeEach(() => {
    restJsonMock.mockReset();
    restJsonPageMock.mockReset();
    requireUserMock.mockReset();
    mocks.requireAdmin.mockReset();
    requireUserMock.mockResolvedValue({ id: 'user-1', role: 'admin' });
    mocks.requireAdmin.mockResolvedValue({ id: 'user-1', role: 'admin' });
    // 计数查询走 restJsonPage，默认给空页，避免 mock 返回 undefined 打断 .catch()
    restJsonPageMock.mockResolvedValue({ data: [], total: 0 });
});

describe('接口契约：/api/tags', () => {
    it('bootstrap 必须同时给出 grades / customTags / stats / totals', async () => {
        restJsonMock.mockImplementation((path: string) => {
            if (path.startsWith('/KnowledgeTag') && path.includes('parentId=is.null')) {
                return Promise.resolve([{ id: 'g1', name: '高一', subject: 'math' }]);
            }
            if (path.startsWith('/KnowledgeTag') && path.includes('isSystem=eq.false')) {
                return Promise.resolve([{ id: 'c1', name: '自定义', subject: 'math', parentId: null }]);
            }
            if (path.startsWith('/KnowledgeTag') && path.includes('id=in.')) {
                return Promise.resolve([{ id: 'c1', name: '自定义' }]);
            }
            if (path.startsWith('/KnowledgeTag')) {
                return Promise.resolve([
                    { id: 'g1', name: '高一', subject: 'math', isSystem: true, parentId: null },
                ]);
            }
            if (path.startsWith('/ErrorItem')) return Promise.resolve([{ knowledgePoints: '["受力分析"]' }]);
            return Promise.resolve([]);
        });

        const { data } = await call(TAG_HANDLERS, ctx({ parts: ['tags', 'bootstrap'] }));

        expect(data).toBeTypeOf('object');
        // 学科树不预拉（按需 fetchTags），但年级必须一次给全 9 个学科
        expect(data.grades).toBeTypeOf('object');
        expect(Array.isArray(data.grades.math)).toBe(true);
        expect(Array.isArray(data.customTags)).toBe(true);
        expect(Array.isArray(data.stats)).toBe(true);
        expect(typeof data.total).toBe('number');
        expect(typeof data.custom).toBe('number');
    });

    it('stats 必须返回 stats 数组（前端 setStats(data.stats) 直接使用）', async () => {
        restJsonMock.mockImplementation((path: string) => {
            if (path.startsWith('/ErrorItem')) {
                return Promise.resolve([{ knowledgePoints: '["受力分析","共点力平衡"]' }]);
            }
            return Promise.resolve([{ id: 'x' }]);
        });
        const { data } = await call(TAG_HANDLERS, ctx({ parts: ['tags', 'stats'] }));

        expect(Array.isArray(data.stats)).toBe(true);
        expect(data.stats[0]).toHaveProperty('tag');
        expect(data.stats[0]).toHaveProperty('count');
    });

    it('suggestions 必须返回字符串数组（输入框按字符串渲染）', async () => {
        restJsonMock.mockResolvedValue([{ name: '受力分析' }, { name: '共点力平衡' }]);
        const { data } = await call(
            TAG_HANDLERS,
            ctx({ parts: ['tags', 'suggestions'], query: new URLSearchParams('q=力') }),
        );

        expect(Array.isArray(data.suggestions)).toBe(true);
        for (const s of data.suggestions) expect(typeof s).toBe('string');
    });
});

describe('接口契约：/api/admin', () => {
    it('dashboard 必须给出 overview.userStats.masteryDistribution 四件套', async () => {
        restJsonMock.mockImplementation((path: string) => {
            if (path.startsWith('/User')) {
                return Promise.resolve([
                    { id: 'u1', email: 'a@b.c', role: 'user', createdAt: '2026-01-01T00:00:00Z' },
                    { id: 'u2', email: 'd@e.f', role: 'user', createdAt: '2020-01-01T00:00:00Z' },
                ]);
            }
            if (path.startsWith('/ErrorItem')) {
                return Promise.resolve([{ id: 'e1', userId: 'u1', masteryLevel: 0 }]);
            }
            return Promise.resolve([]);
        });

        const { data } = await call(ADMIN_HANDLERS, ctx({ parts: ['admin', 'dashboard'] }));

        // 前端 admin/page.tsx 读 data.overview.totalUsers，结构必须嵌套
        expect(data.overview).toBeTypeOf('object');
        expect(typeof data.overview.totalUsers).toBe('number');
        expect(typeof data.overview.totalErrorItems).toBe('number');
        expect(Array.isArray(data.userStats)).toBe(true);
        expect(data.userStats[0]).toHaveProperty('errorCount');
        expect(Array.isArray(data.dailyTrend)).toBe(true);
        expect(Array.isArray(data.subjectDistribution)).toBe(true);
        expect(data.masteryDistribution).toBeTypeOf('object');
        // 前端读的是 .new / .reviewing / .mastered
        for (const key of ['new', 'reviewing', 'mastered']) {
            expect(typeof data.masteryDistribution[key]).toBe('number');
        }
    });

    it('用户详情必须给出扁平 user / errorCount / masteryDistribution.new', async () => {
        restJsonMock.mockImplementation((path: string) => {
            if (path.startsWith('/User?')) {
                return Promise.resolve([{ id: 'u1', email: 'a@b.c', role: 'user', createdAt: '2026-01-01T00:00:00Z' }]);
            }
            if (path.startsWith('/ErrorItem')) {
                return Promise.resolve([{ id: 'e1', masteryLevel: 0, subjectId: 's1' }]);
            }
            if (path.startsWith('/Subject')) return Promise.resolve([{ id: 's1', name: '数学', userId: 'u1' }]);
            return Promise.resolve([]);
        });

        const { data } = await call(ADMIN_HANDLERS, ctx({ parts: ['admin', 'users', 'u1', 'detail'] }));

        expect(data.user).toBeTypeOf('object');
        expect(data.user.id).toBe('u1');
        // 前端 admin/user/page.tsx 读扁平 errorCount / notebookCount（不是 data.stats.*）
        expect(typeof data.errorCount).toBe('number');
        expect(typeof data.practiceCount).toBe('number');
        expect(typeof data.notebookCount).toBe('number');
        expect(Array.isArray(data.notebooks)).toBe(true);
        expect(data.masteryDistribution).toBeTypeOf('object');
        expect(typeof data.masteryDistribution.new).toBe('number');
        expect(Array.isArray(data.recentErrorItems)).toBe(true);
    });
});
