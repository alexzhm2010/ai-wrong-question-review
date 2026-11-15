import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AiQuotaResponse } from "@/types/api";
import {
    DEFAULT_WARN_THRESHOLD,
    GUARD_QUERY_TIMEOUT_MS,
    confirmQuotaBeforeImport,
    needsQuotaWarning,
    resolveQuotaWarning,
    showQuotaWarning,
    subscribeQuotaWarning,
    type QuotaWarningDetail,
} from "@/lib/quota-guard";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

function quotaView(overrides: Partial<AiQuotaResponse> = {}): AiQuotaResponse {
    return {
        configured: true,
        status: "ok",
        balance: {
            currency: "CNY",
            availableAmount: 19.09,
            availableCashAmount: 19.09,
            creditAmount: 0,
        },
        settings: {
            warnThreshold: 20,
            freeQuotaExpireAt: "",
            stopWhenFreeExpired: true,
        },
        ...overrides,
    };
}

const detail: QuotaWarningDetail = {
    balance: 5,
    threshold: 20,
    currency: "CNY",
};

describe("导入前余额闸门：低于后台阈值才提醒", () => {
    it("余额低于阈值 → 返回提醒明细（金额/阈值/币种/同步时间）", () => {
        const result = needsQuotaWarning(
            quotaView({ fetchedAt: "2026-11-15T08:00:00.000Z", consoleUrl: "https://example.com" }),
        );
        expect(result).toEqual({
            balance: 19.09,
            threshold: 20,
            currency: "CNY",
            fetchedAt: "2026-11-15T08:00:00.000Z",
            consoleUrl: "https://example.com",
        });
    });

    it("余额等于或高于阈值 → 不弹窗，直接放行", () => {
        expect(needsQuotaWarning(quotaView({
            balance: { currency: "CNY", availableAmount: 20, availableCashAmount: 20, creditAmount: 0 },
        }))).toBeNull();
        expect(needsQuotaWarning(quotaView({
            balance: { currency: "CNY", availableAmount: 25.5, availableCashAmount: 25.5, creditAmount: 0 },
        }))).toBeNull();
    });

    it("阈值取后台设置，改了立刻生效", () => {
        const result = needsQuotaWarning(quotaView({
            balance: { currency: "CNY", availableAmount: 30, availableCashAmount: 30, creditAmount: 0 },
            settings: { warnThreshold: 50, freeQuotaExpireAt: "", stopWhenFreeExpired: true },
        }));
        expect(result?.threshold).toBe(50);
        expect(result?.balance).toBe(30);
    });

    it("阈值缺失或非法 → 回落到默认 20", () => {
        for (const warnThreshold of [undefined, 0, -5, Number.NaN]) {
            const result = needsQuotaWarning(quotaView({
                balance: { currency: "CNY", availableAmount: 10, availableCashAmount: 10, creditAmount: 0 },
                settings: { warnThreshold: warnThreshold as number, freeQuotaExpireAt: "", stopWhenFreeExpired: true },
            }));
            expect(result?.threshold).toBe(DEFAULT_WARN_THRESHOLD);
        }
    });

    it("余额未同步 / 查询失败 / 数值非法 → 一律放行，不阻断导入", () => {
        expect(needsQuotaWarning(null)).toBeNull();
        expect(needsQuotaWarning(undefined)).toBeNull();
        expect(needsQuotaWarning({ configured: false, status: "unconfigured" })).toBeNull();
        expect(needsQuotaWarning(quotaView({ status: "error" }))).toBeNull();
        expect(needsQuotaWarning(quotaView({
            balance: { currency: "CNY", availableAmount: Number.NaN, availableCashAmount: null, creditAmount: 0 },
        }))).toBeNull();
        expect(needsQuotaWarning(quotaView({
            balance: { currency: "CNY", availableAmount: Number.POSITIVE_INFINITY, availableCashAmount: null, creditAmount: 0 },
        }))).toBeNull();
    });

    it("币种缺失时按 CNY 处理", () => {
        const result = needsQuotaWarning(quotaView({
            balance: { currency: "", availableAmount: 1, availableCashAmount: null, creditAmount: 0 },
        }));
        expect(result?.currency).toBe("CNY");
    });
});

describe("导入前余额闸门：弹窗决定的回传", () => {
    it("点「仍要继续」放行，点「取消」阻断；并发导入共用同一次决定", async () => {
        const seen: Array<QuotaWarningDetail | null> = [];
        const unsub = subscribeQuotaWarning((d) => seen.push(d));
        try {
            const p1 = showQuotaWarning(detail);
            const p2 = showQuotaWarning(detail);
            expect(seen[0]).toEqual(detail);
            expect(seen.length).toBe(1); // 不会弹两次
            resolveQuotaWarning(true);
            expect(await p1).toBe(true);
            expect(await p2).toBe(true);
            expect(seen.at(-1)).toBeNull(); // 弹窗关闭

            const p3 = showQuotaWarning(detail);
            resolveQuotaWarning(false);
            expect(await p3).toBe(false);
        } finally {
            unsub();
        }
    });

    it("弹窗组件未挂载时放行，绝不卡住导入", async () => {
        expect(await showQuotaWarning(detail)).toBe(true);
    });
});

describe("导入前余额闸门：接入点与既有刷新机制", () => {
    const ENTRYPOINTS = [
        "src/app/page.tsx",
        "src/app/notebook/add/page.tsx",
        "src/components/batch-quick-confirm.tsx",
        "src/components/batch-draft-editor.tsx",
    ];

    it("单张与批量的 4 个 AI 解析入口都在开始前调用闸门", () => {
        for (const file of ENTRYPOINTS) {
            expect(read(file), `${file} 应接入导入前余额检查`).toContain(
                "confirmQuotaBeforeImport()",
            );
        }
    });

    it("全局弹窗挂在 RootLayout，且中英文文案齐全", () => {
        expect(read("src/app/layout.tsx")).toContain("<QuotaGuardDialog />");
        const i18n = read("src/lib/translations.ts");
        expect(i18n).toContain("importGuard:");
        expect(i18n).toContain("仍要继续导入"); // zh
        expect(i18n).toContain("Low AI balance"); // en
        expect(i18n).toContain("Continue anyway"); // en
    });

    it("不改现有刷新机制：仍是 10 分钟节流 + 打开页面同步 + 手动强制刷新", () => {
        const sync = read("supabase/functions/quota-sync/index.ts");
        expect(sync).toContain("SNAPSHOT_TTL_MS = 10 * 60 * 1000");
        const routes = read("src/lib/supabase/routes/ai.ts");
        expect(routes).toContain("await quotaSyncEdge(force)");
        expect(routes).toContain('ctx.query.get("refresh") === "1"');
        // 闸门只读，不强制刷新、不碰账单接口
        const guard = read("src/lib/quota-guard.ts");
        expect(guard).toContain('fetch("/api/ai-quota")');
        expect(guard).not.toContain("refresh=1");
        expect(guard).not.toContain("VOLC_ACCESS_KEY_ID");
        expect(guard).not.toContain("QUOTA_EDGE");
    });
});

describe("导入前余额闸门：查询 → 弹窗 → 决定的完整链路", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    const lowBalance = (availableAmount: number) =>
        quotaView({
            balance: { currency: "CNY", availableAmount, availableCashAmount: availableAmount, creditAmount: 0 },
        });

    it("每次导入前都查一次余额；低于阈值弹窗，用户继续则放行", async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => lowBalance(5) }));
        vi.stubGlobal("fetch", fetchMock);
        let received: QuotaWarningDetail | null = null;
        const unsub = subscribeQuotaWarning((d) => { if (d) received = d; });
        try {
            const proceed = confirmQuotaBeforeImport();
            await vi.waitFor(() => expect(received).not.toBeNull());
            expect(received?.balance).toBe(5);
            expect(received?.threshold).toBe(20);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledWith("/api/ai-quota");
            resolveQuotaWarning(true);
            expect(await proceed).toBe(true);
        } finally {
            unsub();
        }
    });

    it("低于阈值且用户取消 → 不执行本次导入", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => lowBalance(1) })));
        let received: QuotaWarningDetail | null = null;
        const unsub = subscribeQuotaWarning((d) => { if (d) received = d; });
        try {
            const proceed = confirmQuotaBeforeImport();
            await vi.waitFor(() => expect(received).not.toBeNull());
            resolveQuotaWarning(false);
            expect(await proceed).toBe(false);
        } finally {
            unsub();
        }
    });

    it("余额充足 → 不弹窗，直接执行", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => lowBalance(100) })));
        let shown = false;
        const unsub = subscribeQuotaWarning((d) => { if (d) shown = true; });
        try {
            expect(await confirmQuotaBeforeImport()).toBe(true);
            expect(shown).toBe(false);
        } finally {
            unsub();
        }
    });

    it("余额接口报错 / 超时 / 未同步 → 一律放行，不阻断导入", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
        expect(await confirmQuotaBeforeImport()).toBe(true);

        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
        expect(await confirmQuotaBeforeImport()).toBe(true);

        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ configured: false, status: "unconfigured" }) })));
        expect(await confirmQuotaBeforeImport()).toBe(true);

        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn(() => new Promise<never>(() => {})));
        const hanging = confirmQuotaBeforeImport();
        await vi.advanceTimersByTimeAsync(GUARD_QUERY_TIMEOUT_MS + 20);
        expect(await hanging).toBe(true);
    });
});
