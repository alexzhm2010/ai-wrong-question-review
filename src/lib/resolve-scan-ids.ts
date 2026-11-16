/**
 * 批改目标题的来源解析：URL 的 ?ids= 优先，其次上次打印记录。
 *
 * 从「我的 → 拍照批改」等入口进入 /scan 时没有带 ids，若不回退到上次打印，
 * 页面就加载不到任何题，卷面上每个题号都会被误判成「库里没有这个号」。
 * grade 页也用同一套来源，两处必须保持一致。
 */

export const LAST_PRINT_KEY = "wq:last-print";

export interface ResolvedIds {
    ids: string[];
    /** 是否来自上次打印（而非 URL 明确指定） */
    fromLastPrint: boolean;
}

/** 从 localStorage 读上次打印的 id；隐私模式/损坏数据都当没有 */
export function readLastPrintIds(storage: Pick<Storage, "getItem"> | null): string[] {
    if (!storage) return [];
    try {
        const saved = JSON.parse(storage.getItem(LAST_PRINT_KEY) || "null");
        if (saved && Array.isArray(saved.ids)) {
            return saved.ids
                .filter((x: unknown) => x !== null && x !== undefined && x !== "")
                .map(String);
        }
    } catch {
        /* 本地记录损坏就当没有 */
    }
    return [];
}

/**
 * @param fromUrl URL 上 ?ids= 的原始字符串
 * @param storage 提供 getItem 的对象；SSR/测试可传 null
 */
export function resolveScanIds(
    fromUrl: string | null | undefined,
    storage: Pick<Storage, "getItem"> | null,
): ResolvedIds {
    const fromUrlIds = (fromUrl || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (fromUrlIds.length) return { ids: fromUrlIds, fromLastPrint: false };
    return { ids: readLastPrintIds(storage), fromLastPrint: true };
}
