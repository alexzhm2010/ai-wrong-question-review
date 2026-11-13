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

/* ------------------------------- 打印文件名 ------------------------------- */

/** 文件名里各系统都不认的字符：Windows 直接拒绝，macOS/Linux 会当成路径分隔符 */
const FILENAME_UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 打印时的默认文件名，如 `高二数学_20261113_201033`。
 *
 * 浏览器「另存为 PDF」的文件名取自 document.title，所以打印前临时改标题即可，
 * 不用引入任何库。干净的错题本名 + 精确到秒的时间戳，一天打十份也不会互相覆盖。
 *
 * - 空格换成下划线：部分安卓文件管理器会把空格截断
 * - 多个学科用「主学科等N科」：一个卷子跨科时也能看出是哪个
 * - 截到 120 字：避免超长标题被系统截断得莫名其妙
 */
export function printFileName(subjectNames: string[], at: Date = new Date()): string {
    const names = subjectNames
        .map((n) => (n || "").replace(FILENAME_UNSAFE, "").trim().replace(/\s+/g, "_"))
        .filter(Boolean);
    const unique = Array.from(new Set(names));
    const base =
        unique.length === 0 ? "错题本"
            : unique.length === 1 ? unique[0]
                : `${unique[0]}等${unique.length}科`;

    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
        `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
        `_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;

    return `${base}_${stamp}`.slice(0, 120);
}
