import BssClient, { DescribeInstanceBillRequest } from "@alicloud/bssopenapi20171214";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { format } from "date-fns";
import { createLogger } from "./logger";
import { sumBailianSpend, type BillItem } from "./quota-bill";

const logger = createLogger("lib:aliyun-bss");

export { sumBailianSpend } from "./quota-bill";

export const BSS_ENDPOINT_DEFAULT = "business.aliyuncs.com";
export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AccountBalance {
    currency: string;
    availableAmount: number;
    availableCashAmount: number;
    creditAmount: number;
}

export interface MonthSpend {
    billingCycle: string;
    amount: number;
    currency: string;
    itemCount: number;
}

export interface QuotaSnapshot {
    configured: boolean;
    status: "ok" | "unconfigured" | "error";
    balance?: AccountBalance;
    monthSpend?: MonthSpend;
    fetchedAt?: string;
    message?: string;
}

function getCredentials(): { id: string; secret: string } | null {
    const id = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
    const secret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
    return id && secret ? { id, secret } : null;
}

export function isQuotaConfigured(): boolean {
    return getCredentials() !== null;
}

function createClient(cred: { id: string; secret: string }): InstanceType<typeof BssClient> {
    const config = new $OpenApiUtil.Config({
        accessKeyId: cred.id,
        accessKeySecret: cred.secret,
        endpoint: process.env.ALIBABA_CLOUD_BSS_ENDPOINT?.trim() || BSS_ENDPOINT_DEFAULT,
        protocol: "https",
        readTimeout: REQUEST_TIMEOUT_MS,
        connectTimeout: REQUEST_TIMEOUT_MS,
    });
    return new BssClient(config);
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("BSS_TIMEOUT")), REQUEST_TIMEOUT_MS);
        timer?.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function fetchBalance(client: InstanceType<typeof BssClient>): Promise<AccountBalance> {
    const response = await client.queryAccountBalance();
    const data = response?.body?.data;
    if (!data || typeof data.availableAmount === "undefined") {
        throw new Error("BSS_EMPTY_BALANCE");
    }
    const toNumber = (value: unknown): number => {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    };
    return {
        currency: data.currency || "CNY",
        availableAmount: toNumber(data.availableAmount),
        availableCashAmount: toNumber(data.availableCashAmount),
        creditAmount: toNumber(data.creditAmount),
    };
}

async function fetchMonthSpend(client: InstanceType<typeof BssClient>): Promise<MonthSpend> {
    const billingCycle = format(new Date(), "yyyy-MM");
    const productCode = process.env.ALIBABA_CLOUD_BILLING_PRODUCT_CODE?.trim();
    const request = new DescribeInstanceBillRequest({
        billingCycle,
        maxResults: 300,
        isHideZeroCharge: true,
        ...(productCode ? { productCode } : {}),
    });
    const response = await client.describeInstanceBill(request);
    const items = (response?.body?.data?.items || []) as BillItem[];
    const { amount } = sumBailianSpend(items);
    return {
        billingCycle,
        amount,
        currency: "CNY",
        itemCount: items.length,
    };
}

let cache: { at: number; value: QuotaSnapshot } | null = null;

/** 清缓存，供测试与「立即刷新」使用。 */
export function clearQuotaCache(): void {
    cache = null;
}

/**
 * 读取阿里云账户余额与本月百炼消费。
 * - 未配置 AccessKey 时返回 unconfigured，不抛错、不阻塞主流程。
 * - 账单查询失败只影响本月消费，余额仍可展示。
 * - 上游错误详情只写日志，对外统一返回固定文案。
 */
export async function getQuotaSnapshot(force = false): Promise<QuotaSnapshot> {
    if (!force && cache && Date.now() - cache.at < QUOTA_CACHE_TTL_MS) {
        return cache.value;
    }

    const cred = getCredentials();
    if (!cred) {
        const value: QuotaSnapshot = {
            configured: false,
            status: "unconfigured",
            message: "尚未配置阿里云只读 AccessKey",
        };
        cache = { at: Date.now(), value };
        return value;
    }

    try {
        const client = createClient(cred);
        const [balance, monthSpend] = await Promise.all([
            withTimeout(fetchBalance(client)),
            withTimeout(fetchMonthSpend(client)).catch((error) => {
                logger.warn(
                    { reason: error instanceof Error ? error.message : "unknown" },
                    "Failed to fetch monthly Model Studio bill"
                );
                return undefined;
            }),
        ]);

        const value: QuotaSnapshot = {
            configured: true,
            status: "ok",
            balance,
            ...(monthSpend ? { monthSpend } : {}),
            fetchedAt: new Date().toISOString(),
        };
        cache = { at: Date.now(), value };
        return value;
    } catch (error) {
        logger.error(
            { reason: error instanceof Error ? error.message : "unknown" },
            "Failed to fetch Alibaba Cloud account balance"
        );
        // 失败不缓存，避免一次网络抖动让卡片长时间显示错误
        cache = null;
        return {
            configured: true,
            status: "error",
            message: "无法获取账户余额，请检查只读 AccessKey 权限或网络",
        };
    }
}
