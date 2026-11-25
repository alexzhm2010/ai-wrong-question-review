/**
 * 练习试卷归档模块的纯逻辑（便于回归测试）。
 *
 * 归档页汇总所有出卷记录（无论来自错题本打印还是每日复习），
 * 提供「查看」与「删除」两种操作，二者的选中约束不同：
 *  - 查看：必须且只能选中一份（要看就看完整的一份卷）
 *  - 删除：可多选，一次删除多份
 */

/** 查看按钮：恰好选中一份才可用 */
export function canView(selectedCount: number): boolean {
    return selectedCount === 1;
}

/** 删除按钮：至少选中一份才可用 */
export function canDelete(selectedCount: number): boolean {
    return selectedCount >= 1;
}

/** 查看试卷内容（含标准答案）的页面地址 */
export function paperViewHref(code: string): string {
    return `/paper-view?c=${encodeURIComponent(code)}`;
}

/**
 * 是否已批改：分数或提交时间任一存在即视为已批改（提交时两者同时写入）。
 * 已批改试卷的逐题判定明细是熟练度差分的依据，因此禁止删除。
 */
export function isSubmitted(row: { score?: number | null; submittedAt?: string | null }): boolean {
    return (row.score !== null && row.score !== undefined) || !!row.submittedAt;
}

/** 得分展示文本：已批改显示分数，未批改显示破折号（score=0 是合法分数，不能当假值） */
export function scoreLabel(row: { score?: number | null; submittedAt?: string | null }): string {
    return isSubmitted(row) && row.score !== null && row.score !== undefined ? String(row.score) : "—";
}

/** 归档页进入「扫码批改」页的地址：带来源参数，批改完/返回时回练习试卷 */
export function paperMarkHref(code: string): string {
    return `/mark?c=${encodeURIComponent(code)}&from=papers`;
}

/**
 * 试卷中的某一道题 -> 错题本题目详情（完整解析页）。
 *
 * 试卷快照 ExamPaperItem.errorItemId 就是 ErrorItem 主键，直接复用 /item?id=。
 * 附加参数含义：
 *  - from=paper：详情页据此把「返回」按钮指回来源试卷，而不是错题本列表；
 *  - back=<来源试卷地址>：精确到「哪份卷 / 批改还是查看」，返回时整页跳回。
 * back 只接受站内绝对路径（白名单前缀），避免被拼成开放重定向。
 */
export function errorItemDetailHref(errorItemId: string, backPath: string): string {
    const q = new URLSearchParams();
    q.set("id", errorItemId);
    q.set("from", "paper");
    if (backPath) q.set("back", backPath);
    return `/item?${q.toString()}`;
}

/** 详情页返回的 back 参数白名单：只允许练习试卷相关的站内路径 */
export function isPaperBackPath(back: string | null | undefined): boolean {
    if (!back || !back.startsWith("/") || back.startsWith("//")) return false;
    return /^\/(papers|paper-view|mark)(\?|$)/.test(back);
}

/** 当前页中允许删除的 code：排除已批改卷，批改明细要留作熟悉度计算依据 */
export function deletableCodes(rows: Array<{ code: string; score?: number | null; submittedAt?: string | null }>): string[] {
    return rows.filter((r) => !isSubmitted(r)).map((r) => r.code);
}

/** 删除二次确认文案：明确份数、不可恢复，并说明已批改卷会被保留 */
export function deleteConfirmText(count: number): string {
    return `确定删除选中的 ${count} 份试卷吗？删除后题目快照与标准答案将一并移除，且无法恢复。已批改的试卷会自动跳过（批改明细需用于计算每道题的熟悉度）。`;
}

/** 归档页每页条数（与服务端 RPC 的 limit 对应） */
export const PAPER_PAGE_SIZE = 20;

/** 由总数算总页数，至少 1 页 */
export function totalPages(total: number, pageSize = PAPER_PAGE_SIZE): number {
    if (!Number.isFinite(total) || total <= 0) return 1;
    return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * 删除若干条后当前页该停在哪一页。
 * 若删空了当前页（剩余条目不足以铺满当前页）且不是第一页，回退一页，
 * 避免停在空白页；其余情况保持当前页（服务端会重新返回该页数据）。
 */
export function pageAfterDelete(
    currentPage: number,
    currentPageRows: number,
    deletedCount: number,
    pageSize = PAPER_PAGE_SIZE,
): number {
    const remainingOnPage = currentPageRows - deletedCount;
    if (remainingOnPage <= 0 && currentPage > 1) return currentPage - 1;
    return Math.max(1, currentPage);
}
