/**
 * 打印选题的交接单键名。
 *
 * Next 的 page 文件只认 default / metadata 这类固定导出，多一个 export const
 * 会让 App Router 走非预期分支，表现是整页卡在 Suspense 的「加载中…」——
 * 所以这类常量必须放在 lib 里，不能留在 page 上。
 */
export const PRINT_PAYLOAD_KEY = "wq:print-payload";

type PrintSelectableItem = {
    id: string;
};

export function getSelectedPrintItems<T extends PrintSelectableItem>(
    items: T[],
    selectedIds: Set<string>,
): T[] {
    return items.filter((item) => selectedIds.has(item.id));
}

export function shouldReserveAnswerSpace(showAnswers: boolean, showAnalysis: boolean): boolean {
    return !showAnswers && !showAnalysis;
}

export function getPrintPreviewCountLabel(totalCount: number, selectedCount: number): string {
    return selectedCount === totalCount
        ? String(totalCount)
        : `${selectedCount}/${totalCount}`;
}

export function getPrintPreviewEmptyState(
    totalCount: number,
    selectedCount: number,
): 'noItems' | 'noSelection' | null {
    if (totalCount === 0) return 'noItems';
    if (selectedCount === 0) return 'noSelection';
    return null;
}
