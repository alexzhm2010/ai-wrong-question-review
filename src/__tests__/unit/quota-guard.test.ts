import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 外部依赖 mock（必须在导入被测模块前） ──────────────────────────────
const mockConfig = {
    quota: { warnThreshold: 20, freeQuotaExpireAt: '', stopWhenFreeExpired: true },
};
const akState = { configured: false };
const snapshotState: any = {
    status: 'ok',
    balance: { currency: 'CNY', availableAmount: 100, availableCashAmount: 100, creditAmount: 0 },
};

vi.mock('@/lib/config', () => ({
    getAppConfig: vi.fn(async () => mockConfig),
}));
vi.mock('@/lib/aliyun-bss', () => ({
    isQuotaConfigured: vi.fn(() => akState.configured),
    getQuotaSnapshot: vi.fn(async () => snapshotState),
}));

const { checkAiAvailability, isNearExpiry } = await import('@/lib/quota-guard');

const localIso = (offsetDays: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

beforeEach(() => {
    mockConfig.quota = { warnThreshold: 20, freeQuotaExpireAt: '', stopWhenFreeExpired: true };
    akState.configured = false;
    snapshotState.status = 'ok';
    snapshotState.balance = { currency: 'CNY', availableAmount: 100, availableCashAmount: 100, creditAmount: 0 };
});

describe('isNearExpiry', () => {
    it('null 与过期返回 false，7 天内（含今天）返回 true', () => {
        expect(isNearExpiry(null)).toBe(false);
        expect(isNearExpiry(-3)).toBe(false);
        expect(isNearExpiry(0)).toBe(true);
        expect(isNearExpiry(7)).toBe(true);
        expect(isNearExpiry(8)).toBe(false);
    });
});

describe('免费额度到期即停（fail-safe）', () => {
    it('未设置到期日 → 放行', async () => {
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(true);
    });

    it('免费额度未过期 → 放行', async () => {
        mockConfig.quota.freeQuotaExpireAt = localIso(10);
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(true);
    });

    it('免费额度已过期 + 未配置 AK → 停用（FREE_QUOTA_EXPIRED）', async () => {
        mockConfig.quota.freeQuotaExpireAt = localIso(-1);
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(false);
        expect(r.code).toBe('FREE_QUOTA_EXPIRED');
        expect(r.freeQuotaExpired).toBe(true);
    });

    it('免费额度已过期 + 已配置 AK + 余额 > 0 → 放行（按量付费）', async () => {
        mockConfig.quota.freeQuotaExpireAt = localIso(-1);
        akState.configured = true;
        snapshotState.balance.availableAmount = 50;
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(true);
        expect(r.freeQuotaExpired).toBe(true);
    });

    it('免费额度已过期 + 已配置 AK + 余额 <= 0 → 停用（BALANCE_DEPLETED）', async () => {
        mockConfig.quota.freeQuotaExpireAt = localIso(-1);
        akState.configured = true;
        snapshotState.balance.availableAmount = 0;
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(false);
        expect(r.code).toBe('BALANCE_DEPLETED');
    });

    it('免费额度已过期 + 已配置 AK + 查询失败 → 保守停用（BALANCE_UNKNOWN）', async () => {
        mockConfig.quota.freeQuotaExpireAt = localIso(-1);
        akState.configured = true;
        snapshotState.status = 'error';
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(false);
        expect(r.code).toBe('BALANCE_UNKNOWN');
    });

    it('关闭「到期即停」开关 → 即使过期也放行', async () => {
        mockConfig.quota.freeQuotaExpireAt = localIso(-1);
        mockConfig.quota.stopWhenFreeExpired = false;
        const r = await checkAiAvailability();
        expect(r.allowed).toBe(true);
    });
});
