import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sumBailianSpend } from '@/lib/quota-bill';
import { getQuotaStatus, daysUntilExpiry, formatMoney } from '@/lib/quota-status';
import type { QuotaSnapshot } from '@/lib/aliyun-bss';

const projectRoot = process.cwd();
const readSource = (relative: string) =>
    fs.readFileSync(path.join(projectRoot, relative), 'utf8');

const snapshot = (
    status: QuotaSnapshot['status'],
    availableAmount?: number
): QuotaSnapshot => ({
    configured: status !== 'unconfigured',
    status,
    ...(typeof availableAmount === 'number'
        ? {
            balance: {
                currency: 'CNY',
                availableAmount,
                availableCashAmount: availableAmount,
                creditAmount: 0,
            },
        }
        : {}),
});

describe('百炼账单过滤与求和', () => {
    it('空账单返回 0', () => {
        expect(sumBailianSpend()).toEqual({ amount: 0, matched: 0 });
        expect(sumBailianSpend([])).toEqual({ amount: 0, matched: 0 });
    });

    it('只累加百炼相关条目，忽略其它云产品', () => {
        const result = sumBailianSpend([
            { productName: '大模型服务平台百炼', paymentAmount: 1.25 },
            { productName: '云服务器 ECS', paymentAmount: 999 },
            { productCode: 'bailian', paymentAmount: 2.75 },
        ]);
        expect(result.matched).toBe(2);
        expect(result.amount).toBe(4);
    });

    it('英文 / 大小写关键字也能匹配，实付缺失时回退税前金额', () => {
        const result = sumBailianSpend([
            { productDetail: 'Model Studio inference', pretaxAmount: 3.5 },
        ]);
        expect(result.matched).toBe(1);
        expect(result.amount).toBe(3.5);
    });

    it('金额非法或缺失按 0 处理，不产生 NaN', () => {
        const result = sumBailianSpend([
            { productName: '百炼', paymentAmount: Number.NaN },
            { productName: '百炼' },
        ]);
        expect(result.matched).toBe(2);
        expect(result.amount).toBe(0);
        expect(Number.isFinite(result.amount)).toBe(true);
    });
});

describe('额度状态判定', () => {
    it('未配置 / 查询失败 / 无余额各有独立状态', () => {
        expect(getQuotaStatus(snapshot('unconfigured'), 20)).toBe('unconfigured');
        expect(getQuotaStatus(snapshot('error'), 20)).toBe('error');
        expect(getQuotaStatus(snapshot('ok'), 20)).toBe('unknown');
        expect(getQuotaStatus(null, 20)).toBe('unknown');
    });

    it('余额 <= 0 或 <= 阈值为危险，2 倍阈值内为提醒', () => {
        expect(getQuotaStatus(snapshot('ok', 0), 20)).toBe('danger');
        expect(getQuotaStatus(snapshot('ok', 20), 20)).toBe('danger');
        expect(getQuotaStatus(snapshot('ok', 30), 20)).toBe('warn');
        expect(getQuotaStatus(snapshot('ok', 40), 20)).toBe('warn');
        expect(getQuotaStatus(snapshot('ok', 41), 20)).toBe('ok');
    });

    it('阈值非法时回退到默认 20', () => {
        expect(getQuotaStatus(snapshot('ok', 15), 0)).toBe('danger');
        expect(getQuotaStatus(snapshot('ok', 15), Number.NaN)).toBe('danger');
    });
});

describe('免费额度到期日', () => {
    const localIso = (offsetDays: number) => {
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    it('空值与非法日期返回 null', () => {
        expect(daysUntilExpiry()).toBeNull();
        expect(daysUntilExpiry('')).toBeNull();
        expect(daysUntilExpiry('not-a-date')).toBeNull();
    });

    it('未来日期返回剩余天数，过去日期返回负数', () => {
        expect(daysUntilExpiry(localIso(3))).toBe(3);
        expect(daysUntilExpiry(localIso(0))).toBe(0);
        expect(daysUntilExpiry(localIso(-2))).toBe(-2);
    });

    it('金额格式化带两位小数', () => {
        expect(formatMoney(12.5, 'CNY')).toContain('12.50');
    });
});

describe('未配置 AccessKey 时的降级', () => {
    it('不调用 SDK，直接返回 unconfigured，不影响主流程', async () => {
        const { getQuotaSnapshot, isQuotaConfigured, clearQuotaCache } = await import('@/lib/aliyun-bss');
        delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
        delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
        clearQuotaCache();
        expect(isQuotaConfigured()).toBe(false);
        const snap = await getQuotaSnapshot(true);
        expect(snap.status).toBe('unconfigured');
        expect(snap.configured).toBe(false);
        expect(snap.balance).toBeUndefined();
    }, 30_000);
});

describe('额度看板安全护栏', () => {
    const route = readSource('src/app/api/ai-quota/route.ts');
    const bss = readSource('src/lib/aliyun-bss.ts');
    const settings = readSource('src/components/settings-dialog.tsx');
    const home = readSource('src/app/page.tsx');

    it('接口要求登录且仅管理员可读', () => {
        expect(route).toContain('getServerSession');
        expect(route).toContain('requireAdmin');
        expect(route).toContain('unauthorized()');
        expect(route).toContain('forbidden()');
    });

    it('接口不返回任何 AccessKey 字段', () => {
        expect(route).not.toMatch(/accessKeyId\s*:/);
        expect(route).not.toMatch(/accessKeySecret\s*:/);
        expect(route).not.toContain('ALIBABA_CLOUD_ACCESS_KEY_SECRET');
    });

    it('AK 只从服务端环境变量读取，且有超时与缓存', () => {
        expect(bss).toContain('process.env.ALIBABA_CLOUD_ACCESS_KEY_ID');
        expect(bss).toContain('process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET');
        expect(bss).toContain('REQUEST_TIMEOUT_MS');
        expect(bss).toContain('QUOTA_CACHE_TTL_MS');
    });

    it('卡片只挂在设置页 AI tab（仅管理员），首页不展示', () => {
        expect(settings).toContain('<AiQuotaCard />');
        expect(home).not.toContain('AiQuotaCard');
    });

    it('前端不引入阿里云 SDK，避免打进浏览器包', () => {
        const card = readSource('src/components/ai-quota-card.tsx');
        expect(card).not.toContain('@alicloud/');
        expect(card).not.toContain('aliyun-bss');
    });

    it('环境变量样例与 Render 蓝图都登记了 AK 变量（不写明文值）', () => {
        const envExample = readSource('.env.example');
        const renderYaml = readSource('render.yaml');
        for (const source of [envExample, renderYaml]) {
            expect(source).toContain('ALIBABA_CLOUD_ACCESS_KEY_ID');
            expect(source).toContain('ALIBABA_CLOUD_ACCESS_KEY_SECRET');
        }
        expect(renderYaml).toContain('sync: false');
    });

    it('阈值与到期日复用 AppSetting，不需要改 Schema', () => {
        expect(readSource('src/lib/config.ts')).toContain('freeQuotaExpireAt');
        expect(readSource('src/types/api.ts')).toContain('AiQuotaResponse');
        expect(readSource('prisma/schema.prisma')).not.toContain('model AiQuota');
    });
});
