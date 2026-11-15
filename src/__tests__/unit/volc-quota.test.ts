import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { buildQuotaView, VOLC_PROVIDER, toNumber } from "@/lib/quota-view";
import { getQuotaStatus, formatMoney } from "@/lib/quota-status";
import {
    buildBalanceRequest,
    parseBalanceResponse,
    queryVolcBalance,
} from "../../../supabase/functions/_shared/volc-billing";

// jsdom 的 crypto 通常没有 subtle，补全为 Node 的 Web Crypto 实现
if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("火山方舟额度视图：数据链路与来源优先级", () => {
    it("无快照且无手动录入时，如实返回尚未同步，且供应商是火山方舟", () => {
        const v = buildQuotaView(null, {});
        expect(v.status).toBe("unconfigured");
        expect(v.source).toBe("none");
        expect(v.balance).toBeUndefined();
        expect(v.availability.allowed).toBe(true);
        expect(v.provider).toEqual(VOLC_PROVIDER);
        expect(v.provider.model).toBe("doubao-seed-2-1-lite-260915");
        expect(v.consoleUrl).toContain("console.volcengine.com");
        expect(v.settings).toMatchObject({ warnThreshold: 20, freeQuotaExpireAt: "", stopWhenFreeExpired: true });
    });

    it("服务端自动同步的快照：余额、现金余额与同步时间都能映射到前端结构", () => {
        const v = buildQuotaView(
            {
                balance: "19.50",
                currency: "CNY",
                source: "volc-api",
                captured_at: "2026-11-15T07:00:00Z",
                free_quota_expired: false,
                stop_when_free_expired: true,
                raw: { CashBalance: "21.30", CreditLimit: "0.00" },
            },
            {}
        );
        expect(v.status).toBe("ok");
        expect(v.source).toBe("volc-api");
        expect(v.balance.availableAmount).toBe(19.5);
        expect(v.balance.availableCashAmount).toBe(21.3);
        expect(v.balance.currency).toBe("CNY");
        expect(v.fetchedAt).toBe("2026-11-15T07:00:00Z");
        expect(v.configured).toBe(true);
    });

    it("手动录入的余额来自 app_config_public.quota，标记为 manual", () => {
        const v = buildQuotaView(null, {
            quota: {
                manualBalance: 19.5,
                balanceSyncedAt: "2026-11-15T06:00:00Z",
                warnThreshold: 35,
                freeQuotaExpireAt: "2026-12-31",
                stopWhenFreeExpired: false,
            },
        });
        expect(v.status).toBe("ok");
        expect(v.source).toBe("manual");
        expect(v.balance.availableAmount).toBe(19.5);
        expect(v.balance.availableCashAmount).toBeNull();
        expect(v.fetchedAt).toBe("2026-11-15T06:00:00Z");
        expect(v.settings).toMatchObject({
            warnThreshold: 35,
            freeQuotaExpireAt: "2026-12-31",
            stopWhenFreeExpired: false,
            manualBalance: 19.5,
        });
    });

    it("服务端快照优先于手动值，快照无余额时回落手动值", () => {
        const snap = { balance: 50, source: "volc-api", captured_at: "2026-11-15T07:00:00Z" };
        const cfg = { quota: { manualBalance: 19.5 } };
        expect(buildQuotaView(snap, cfg).balance.availableAmount).toBe(50);
        expect(buildQuotaView({ ...snap, balance: null }, cfg).balance.availableAmount).toBe(19.5);
    });

    it("免费额度到期且开启阻断时返回 AI_QUOTA_BLOCKED，关闭开关则放行", () => {
        const expired = { balance: 10, free_quota_expired: true, stop_when_free_expired: true };
        expect(buildQuotaView(expired, {}).availability).toMatchObject({
            allowed: false,
            code: "AI_QUOTA_BLOCKED",
            freeQuotaExpired: true,
        });
        expect(buildQuotaView({ ...expired, stop_when_free_expired: false }, {}).availability.allowed).toBe(true);
    });

    it("余额视图不含任何阿里云口径字段", () => {
        const dump = JSON.stringify(buildQuotaView({ balance: 10 }, { quota: { manualBalance: 1 } }));
        for (const banned of ["百炼", "阿里云", "dashscope", "ALIBABA_CLOUD", "monthSpend"]) {
            expect(dump).not.toContain(banned);
        }
        expect(toNumber("")).toBeNull();
        expect(toNumber("abc")).toBeNull();
        expect(toNumber("19.5")).toBe(19.5);
    });
});

describe("余额状态与金额格式化", () => {
    it("19.5 元（阈值 20）应告警，50 元正常，30 元偏低", () => {
        const mk = (amount: number) => ({ configured: true, status: "ok" as const, balance: { currency: "CNY", availableAmount: amount, availableCashAmount: null, creditAmount: 0 } });
        expect(getQuotaStatus(mk(19.5), 20)).toBe("danger");
        expect(getQuotaStatus(mk(30), 20)).toBe("warn");
        expect(getQuotaStatus(mk(50), 20)).toBe("ok");
        expect(getQuotaStatus(null, 20)).toBe("unknown");
    });

    it("现金余额缺失时显示 --，不显示 NaN", () => {
        expect(formatMoney(null)).toBe("--");
        expect(formatMoney(undefined)).toBe("--");
        expect(formatMoney(19.5)).toContain("19.50");
    });
});

describe("火山引擎 QueryBalanceAcct：签名与解析（自动同步就绪）", () => {
    const creds = { accessKeyId: "AKTEST0000000000000000", secretAccessKey: "secret-test-value-000000" };

    it("解析官方响应示例", () => {
        const b = parseBalanceResponse({
            Result: {
                AvailableBalance: "77.01",
                CashBalance: "83.01",
                CreditLimit: "0.01",
                ArrearsBalance: "1.01",
                FreezeAmount: "5.01",
                Currency: "CNY",
            },
        });
        expect(b).toMatchObject({ availableAmount: 77.01, cashAmount: 83.01, currency: "CNY" });
    });

    it("缺少 AvailableBalance 或空响应返回 null", () => {
        expect(parseBalanceResponse({})).toBeNull();
        expect(parseBalanceResponse({ Result: { CashBalance: "1" } })).toBeNull();
    });

    it("同一时刻签名确定，且符合火山 V4 授权头格式", async () => {
        const now = new Date("2026-11-15T07:19:00.000Z");
        const a = await buildBalanceRequest(creds, now);
        const b = await buildBalanceRequest(creds, now);
        expect(a.headers.Authorization).toBe(b.headers.Authorization);
        expect(a.headers["X-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
        expect(a.headers.Authorization).toContain("HMAC-SHA256 Credential=");
        expect(a.headers.Authorization).toContain("/20261115/cn-beijing/billing/request");
        expect(a.headers.Authorization).toContain("SignedHeaders=host");
        expect(a.headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/);
        expect(a.url).toContain("Action=QueryBalanceAcct&Version=2022-01-01");
        expect(a.url).toContain("billing.volcengineapi.com");
    });

    it("不同密钥产生不同签名，未配置凭证时不发起任何请求", async () => {
        const now = new Date("2026-11-15T07:19:00.000Z");
        const a = await buildBalanceRequest(creds, now);
        const b = await buildBalanceRequest({ ...creds, secretAccessKey: "another-secret" }, now);
        expect(a.headers.Authorization).not.toBe(b.headers.Authorization);

        let called = false;
        const noFetch = (async () => { called = true; throw new Error("不应发起请求"); }) as unknown as typeof fetch;
        expect(await queryVolcBalance(undefined, noFetch)).toBeNull();
        expect(await queryVolcBalance({ accessKeyId: "x" }, noFetch)).toBeNull();
        expect(called).toBe(false);
    });
});

describe("护栏：额度卡片已彻底切到火山口径，阿里云死代码已移除", () => {
    it("额度相关源码不再出现阿里云 / 百炼 / RAM 字样", () => {
        const banned = ["百炼", "ALIBABA_CLOUD", "RAM 子用户", "Read-only Alibaba Cloud", "dashscope"];
        for (const file of [
            "src/components/ai-quota-card.tsx",
            "src/lib/supabase/routes/ai.ts",
            "src/lib/quota-view.ts",
            "src/lib/quota-status.ts",
        ]) {
            const src = read(file);
            for (const word of banned) expect(src, `${file} 不应含 ${word}`).not.toContain(word);
        }
        const translations = read("src/lib/translations.ts");
        for (const word of ["ALIBABA_CLOUD_ACCESS_KEY", "百炼消费", "只读阿里云账户余额", "RAM 子用户"]) {
            expect(translations).not.toContain(word);
        }
    });

    it("卡片指向火山引擎费用中心，且阿里云 SDK 依赖与源码已删除", () => {
        expect(read("src/lib/quota-view.ts")).toContain("console.volcengine.com");
        expect(read("package.json")).not.toContain("@alicloud");
        expect(existsSync(resolve(root, "src/lib/aliyun-bss.ts"))).toBe(false);
        expect(existsSync(resolve(root, "src/lib/quota-bill.ts"))).toBe(false);
    });
});

describe("额度设置保存：失败原因不再一律归咎于管理员权限", () => {
    it("服务端区分「账号不是管理员」与「数据库 RLS 拒绝写入」", () => {
        const routes = read("src/lib/supabase/routes/ai.ts");
        expect(routes).toContain("当前账号不是管理员");
        expect(routes).toContain("数据库拒绝写入：AppSetting");
        expect(routes).toContain("role 设为 admin");
    });

    it("卡片优先展示服务端返回的真实原因", () => {
        const card = read("src/components/ai-quota-card.tsx");
        expect(card).toContain("function serverMessage");
        expect(card).toContain("serverMessage(e) || q?.saveError");
    });
});
