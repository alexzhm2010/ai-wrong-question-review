/**
 * 「出卷 → 打印」统一入口。
 *
 * 错题本选题打印、今日复习卷、批改页重做错题……凡是带题目去打印页的，都走这里：
 *  1. 先调用 paper_create 把题目快照写库，换一个凭证 code（卷首二维码靠它渲染）；
 *  2. 再用整页导航跳到打印页，URL 带上 ids + paper 凭证。
 *
 * 为什么必须统一：以前错题本那一路只把 ids 塞进 sessionStorage、用客户端导航跳
 * /print-preview?src=list，既不出卷（没有二维码），又和今日复习的打印页长得不一样。
 * 两条路都接到这一个函数，学生卷就有统一卷首（试卷编号 + 扫码批改二维码）。
 *
 * 出卷失败不阻断打印：仍跳打印页，只是这次没有二维码（老行为降级）。
 */
import { apiClient } from "@/lib/api-client";
import { hardNavigate, printPreviewHref } from "@/lib/navigation";

export type PaperPrintItem = {
    id: string;
    shortCode?: string | null;
};

export type CreatePaperResult = {
    code: string;
    paperNo: string;
};

/** 只出卷拿凭证，不跳转。今日复习需要先把凭证存本地，可先调这个再自行导航。 */
export async function createPaper(
    ids: string[],
    items: PaperPrintItem[],
    subjectNames: string,
): Promise<CreatePaperResult> {
    if (!ids.length) return { code: "", paperNo: "" };
    try {
        const res = await apiClient.post<{ code?: string; paperNo?: string }>("/api/paper/create", {
            subjectNames,
            items: ids.map((id, i) => ({
                id,
                orderIndex: i,
                shortCode: items[i]?.shortCode || "",
            })),
        });
        return { code: res?.code || "", paperNo: res?.paperNo || "" };
    } catch {
        // 出卷失败（未登录 / 网络）降级为无二维码打印
        return { code: "", paperNo: "" };
    }
}

/** 出卷并立即整页跳转到打印页。错题本「导出打印」用它。 */
export async function createPaperAndPrint(
    ids: string[],
    items: PaperPrintItem[],
    subjectNames: string,
): Promise<void> {
    const { code, paperNo } = await createPaper(ids, items, subjectNames);
    hardNavigate(printPreviewHref(ids, code, paperNo));
}
