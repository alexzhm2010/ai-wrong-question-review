/** 与阿里云 SDK 无关的纯逻辑，便于在 jsdom 环境下单测。 */
export const BAILIAN_KEYWORDS = ["百炼", "bailian", "model studio", "大模型服务平台"];

export interface BillItem {
    productName?: string;
    productCode?: string;
    productDetail?: string;
    paymentAmount?: number;
    pretaxAmount?: number;
}

/** 从实例账单条目里筛出百炼相关消费并求和。优先用实付金额，缺失时回退税前金额。 */
export function sumBailianSpend(items: BillItem[] = []): { amount: number; matched: number } {
    let amount = 0;
    let matched = 0;
    for (const item of items) {
        const text = [item.productName, item.productCode, item.productDetail]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        if (!BAILIAN_KEYWORDS.some((keyword) => text.includes(keyword))) continue;
        matched += 1;
        const raw = typeof item.paymentAmount === "number" ? item.paymentAmount : item.pretaxAmount;
        amount += Number.isFinite(raw) ? (raw as number) : 0;
    }
    return { amount: Math.round(amount * 100) / 100, matched };
}
