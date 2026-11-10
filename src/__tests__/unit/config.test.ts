/**
 * 应用配置模块单元测试
 * 配置持久化在数据库 AppSetting 表中，因此这里 mock Prisma 客户端。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

const findUniqueMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
    prisma: {
        appSetting: {
            findUnique: (...args: unknown[]) => findUniqueMock(...args),
            upsert: (...args: unknown[]) => upsertMock(...args),
        },
    },
}));

describe('config module', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        vi.resetModules();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('getAppConfig', () => {
        it('数据库无记录时返回默认配置', async () => {
            findUniqueMock.mockResolvedValue(null);
            process.env.AI_PROVIDER = 'gemini';

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(findUniqueMock).toHaveBeenCalledWith({ where: { key: 'app_config' } });
            expect(config.aiProvider).toBe('gemini');
            // H-04：出厂默认关闭注册（fail-closed）
            expect(config.allowRegistration).toBe(false);
        });

        it('应该从环境变量读取 AI Provider', async () => {
            findUniqueMock.mockResolvedValue(null);
            process.env.AI_PROVIDER = 'openai';

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(config.aiProvider).toBe('openai');
        });

        it('应该合并数据库中的配置', async () => {
            findUniqueMock.mockResolvedValue({
                key: 'app_config',
                value: JSON.stringify({
                    aiProvider: 'openai',
                    allowRegistration: false,
                    openai: {
                        instances: [{
                            id: 'db-1',
                            name: 'DB',
                            apiKey: 'db-key',
                            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                            model: 'qwen3-vl-plus',
                        }],
                        activeInstanceId: 'db-1',
                    },
                    prompts: { analyze: 'custom' },
                }),
            });

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(config.aiProvider).toBe('openai');
            expect(config.allowRegistration).toBe(false);
            expect(config.openai?.instances?.[0]?.apiKey).toBe('db-key');
            expect(config.prompts?.analyze).toBe('custom');
        });

        it('默认单次分析输出上限为 8192', async () => {
            findUniqueMock.mockResolvedValue(null);

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(config.aiOptions?.maxTokens).toBe(8192);
        });

        it('数据库里旧默认 4096 会一次性升级为 8192 并写回标记', async () => {
            findUniqueMock.mockResolvedValue({
                key: 'app_config',
                value: JSON.stringify({ aiOptions: { maxTokens: 4096 } }),
            });
            upsertMock.mockResolvedValue({});

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(config.aiOptions?.maxTokens).toBe(8192);
            expect(upsertMock).toHaveBeenCalledTimes(1);
            const saved = JSON.parse(upsertMock.mock.calls[0][0].update.value);
            expect(saved.aiOptions.maxTokens).toBe(8192);
            expect(saved.aiOptions.maxTokensMigrated).toBe(true);
        });

        it('已迁移过的用户主动改回 4096 时不会被覆盖', async () => {
            findUniqueMock.mockResolvedValue({
                key: 'app_config',
                value: JSON.stringify({ aiOptions: { maxTokens: 4096, maxTokensMigrated: true } }),
            });

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(config.aiOptions?.maxTokens).toBe(4096);
            expect(upsertMock).not.toHaveBeenCalled();
        });

        it('数据库异常时回退到默认配置', async () => {
            findUniqueMock.mockRejectedValue(new Error('db down'));
            process.env.AI_PROVIDER = 'openai';

            const { getAppConfig } = await import('@/lib/config');
            const config = await getAppConfig();

            expect(config.aiProvider).toBe('openai');
        });
    });

    describe('updateAppConfig', () => {
        it('应该写入数据库并返回合并后的配置', async () => {
            findUniqueMock.mockResolvedValue(null);
            upsertMock.mockResolvedValue({});

            const { updateAppConfig } = await import('@/lib/config');
            const result = await updateAppConfig({ aiProvider: 'openai' });

            expect(upsertMock).toHaveBeenCalled();
            expect(result.aiProvider).toBe('openai');
        });

        it('应该合并嵌套配置', async () => {
            findUniqueMock.mockResolvedValue(null);
            upsertMock.mockResolvedValue({});

            const { updateAppConfig } = await import('@/lib/config');
            const result = await updateAppConfig({
                openai: {
                    instances: [{
                        id: 'new-instance',
                        name: 'New',
                        apiKey: 'new-key',
                        baseUrl: 'https://api.openai.com/v1',
                        model: 'gpt-4o',
                    }],
                    activeInstanceId: 'new-instance',
                },
            });

            expect(result.openai?.instances?.[0]?.apiKey).toBe('new-key');
            expect(result.openai?.instances?.length).toBeGreaterThan(0);
        });

        it('应该在写入失败时抛出错误', async () => {
            findUniqueMock.mockResolvedValue(null);
            upsertMock.mockRejectedValue(new Error('Permission denied'));

            const { updateAppConfig } = await import('@/lib/config');

            await expect(updateAppConfig({ aiProvider: 'openai' })).rejects.toThrow();
        });

        it('应该更新提示词配置', async () => {
            findUniqueMock.mockResolvedValue(null);
            upsertMock.mockResolvedValue({});

            const { updateAppConfig } = await import('@/lib/config');
            const result = await updateAppConfig({ prompts: { analyze: '自定义提示词' } });

            expect(result.prompts?.analyze).toBe('自定义提示词');
        });

        it('应该更新注册开关', async () => {
            findUniqueMock.mockResolvedValue(null);
            upsertMock.mockResolvedValue({});

            const { updateAppConfig } = await import('@/lib/config');
            const result = await updateAppConfig({ allowRegistration: false });

            expect(result.allowRegistration).toBe(false);
        });
    });
});
