import { getAppConfig } from "./config";
import { isQuotaConfigured, getQuotaSnapshot } from "./aliyun-bss";
import { daysUntilExpiry } from "./quota-status";
import { createLogger } from "./logger";

const logger = createLogger("lib:quota-guard");

/** 拦截原因码：前端可据此做国际化，但绝不回显任何余额/密钥细节。 */
export type QuotaBlockCode = "FREE_QUOTA_EXPIRED" | "BALANCE_DEPLETED" | "BALANCE_UNKNOWN";

export interface AiAvailability {
    allowed: boolean;
    code?: QuotaBlockCode;
    /** 仅给管理员/日志用的可读原因，不含密钥与精确余额数值之外必要信息。 */
    reason?: string;
    freeQuotaExpired?: boolean;
    daysLeft?: number | null;
}

/** 距到期多少天内算「临近」，用于看板预警。 */
export const NEAR_EXPIRY_DAYS = 7;

/** 免费额度是否临近到期（含今天）。 */
export function isNearExpiry(daysLeft: number | null): boolean {
    return daysLeft !== null && daysLeft >= 0 && daysLeft <= NEAR_EXPIRY_DAYS;
}

/**
 * 判断是否允许调用 AI。核心防欠费逻辑（fail-safe）：
 *
 * 1. 若开启「免费额度到期即停」且免费额度已过期：
 *    - 未配置只读 AccessKey → 无法确认付费余额 → 停用（fail-safe）。
 *    - 已配置 AK 且可用余额 > 0 → 放行（按量付费）。
 *    - 已配置 AK 但余额 <= 0 → 停用。
 *    - 已配置 AK 但查询失败 → 保守停用，避免未知欠费。
 * 2. 免费额度未过期（或未设置到期日）→ 放行。余额耗尽由阿里云侧拦截
 *    （AI_QUOTA_EXCEEDED），不在此重复拦截以免误伤正常免费调用。
 */
export async function checkAiAvailability(): Promise<AiAvailability> {
    const config = await getAppConfig();
    const quota = config.quota ?? {};
    // 默认开启：免费额度到期即停，是防欠费的第一道闸。
    const stopWhenFreeExpired = quota.stopWhenFreeExpired !== false;
    const daysLeft = daysUntilExpiry(quota.freeQuotaExpireAt);
    const expired = daysLeft !== null && daysLeft < 0;

    if (!expired || !stopWhenFreeExpired) {
        return { allowed: true, freeQuotaExpired: expired, daysLeft };
    }

    // 免费额度已过期且开启了即停
    if (!isQuotaConfigured()) {
        const reason =
            "免费额度已到期，且未配置阿里云只读 AccessKey，无法确认付费余额，已暂停 AI 以防欠费";
        logger.warn({ daysLeft }, reason);
        return { allowed: false, code: "FREE_QUOTA_EXPIRED", reason, freeQuotaExpired: true, daysLeft };
    }

    const snapshot = await getQuotaSnapshot(false);
    const balance = snapshot.balance?.availableAmount ?? 0;
    if (snapshot.status === "ok" && balance > 0) {
        // 有可用付费余额，放行（按量付费，仍由阿里云侧余额/配额兜底）。
        return { allowed: true, freeQuotaExpired: true, daysLeft };
    }
    if (snapshot.status === "ok" && balance <= 0) {
        const reason = "免费额度已到期，且账户可用余额不足，已暂停 AI 以防欠费";
        logger.warn({ balance }, reason);
        return { allowed: false, code: "BALANCE_DEPLETED", reason, freeQuotaExpired: true, daysLeft };
    }
    const reason = "免费额度已到期，且无法确认账户余额（查询失败），已暂停 AI 以防欠费";
    logger.warn({ status: snapshot.status }, reason);
    return { allowed: false, code: "BALANCE_UNKNOWN", reason, freeQuotaExpired: true, daysLeft };
}
