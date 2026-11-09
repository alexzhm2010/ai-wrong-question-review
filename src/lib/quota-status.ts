import type { QuotaSnapshot } from "./aliyun-bss";

export type QuotaStatus = "ok" | "warn" | "danger" | "unknown" | "unconfigured" | "error";

/** 阈值语义：余额 <= threshold 为危险，<= 2 倍阈值为提醒，其余正常。 */
export function getQuotaStatus(snapshot: QuotaSnapshot | null, threshold: number): QuotaStatus {
    if (!snapshot) return "unknown";
    if (snapshot.status === "unconfigured") return "unconfigured";
    if (snapshot.status === "error") return "error";
    const balance = snapshot.balance?.availableAmount;
    if (typeof balance !== "number" || !Number.isFinite(balance)) return "unknown";
    const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : 20;
    if (balance <= 0 || balance <= limit) return "danger";
    if (balance <= limit * 2) return "warn";
    return "ok";
}

/** 距到期日还剩几天；无效日期返回 null。 */
export function daysUntilExpiry(isoDate?: string): number | null {
    if (!isoDate) return null;
    const target = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
}

export function formatMoney(amount: number, currency = "CNY"): string {
    try {
        return new Intl.NumberFormat("zh-CN", {
            style: "currency",
            currency,
            minimumFractionDigits: 2,
        }).format(amount);
    } catch {
        return `${amount.toFixed(2)} ${currency}`;
    }
}
