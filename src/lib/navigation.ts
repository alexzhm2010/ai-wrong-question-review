import { BASE_PATH } from "@/lib/supabase/config";

/**
 * 页面导航规范（集中定义，避免各页面各自写死返回目标）。
 *
 * 规则：
 *  1. 每个二级/叶子页面都有唯一「逻辑父页面」；顶部返回箭头一律回到它，
 *     不允许跳到无关页面（历史教训：批改页曾错写回 /review 今日复习卷）。
 *  2. 批卷与试卷归档已合并到「练习试卷」：扫码/归档进入 /mark，判完提交后
 *     无论点返回箭头还是结果页按钮，都回到 /papers（原 /mark-center 已移除）。
 */
export const NAV_PARENT: Record<string, string> = {
    "/mark": "/papers", // 批改页 ← 练习试卷（扫码批卷入口已合并进来）
    "/scan": "/me", // 拍照批改（旧）← 我的
    "/review": "/", // 今日复习卷 ← 首页
    "/mastery": "/stats", // 掌握度 ← 统计中心
    "/papers": "/", // 练习试卷（归档）← 首页（侧栏一级入口）
    "/paper-view": "/papers", // 试卷内容查看 ← 练习试卷
};

/** 练习试卷归档页（查看试卷、扫码批卷的统一返回目标） */
export const PAPERS_HOME = "/papers";

/** 批改流程结束后「无论如何」要回的页面（= 练习试卷） */
export const MARK_HOME = PAPERS_HOME;

/** 取某页面的逻辑父页面；带 query/hash 也能命中；未登记的页面回首页 */
export function parentOf(path: string): string {
    const clean = (path || "").split(/[?#]/)[0] || "/";
    if (NAV_PARENT[clean]) return NAV_PARENT[clean];
    for (const key of Object.keys(NAV_PARENT)) {
        if (clean.startsWith(key + "/")) return NAV_PARENT[key];
    }
    return "/";
}

/**
 * 整页导航（硬跳转）。
 *
 * 用于进入 /print-preview 这类「靠 URL query 取数」的页面。静态导出 + App Router
 * 下用 next/link 客户端导航进来时，Link 的预取缓存可能把带 query 的页面固化成
 * 空壳（location.search 还没切过去），打印页只读一次 location.search 就拿到空
 * ids，结果是「继续打印 / 重做错题」点进去一片空白。整页加载能保证渲染时 URL 已就绪。
 * path 传站内路径（如 /print-preview?ids=...），函数负责补 basePath。
 */
export function hardNavHref(path: string): string {
    return `${BASE_PATH}${path.startsWith("/") ? path : "/" + path}`.replace(/\/+/g, "/");
}

export function hardNavigate(path: string): void {
    if (typeof window === "undefined") return;
    window.location.assign(hardNavHref(path));
}

/**
 * 构造打印页地址，二维码凭证是其中一等公民。
 *
 * 卷首二维码只在打印页 URL 带 paper=code 时渲染。把 ids / code / paperNo 的
 * 拼接集中到这里，避免某个入口漏带 paper 导致「打印出来没二维码」——
 * 历史上「继续打印那份」只带 ids，正是漏了这里才整批卷子没有码。
 */
export function printPreviewHref(ids: string[], code = "", paperNo = ""): string {
    const q = new URLSearchParams();
    q.set("ids", ids.join(","));
    if (code) {
        q.set("paper", code);
        q.set("paperNo", paperNo);
    }
    return `/print-preview?${q.toString()}`;
}
