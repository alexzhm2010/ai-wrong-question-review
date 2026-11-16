/**
 * 页面导航规范（集中定义，避免各页面各自写死返回目标）。
 *
 * 规则：
 *  1. 每个二级/叶子页面都有唯一「逻辑父页面」；顶部返回箭头一律回到它，
 *     不允许跳到无关页面（历史教训：批改页曾错写回 /review 今日复习卷）。
 *  2. 批改流程的终点是「批改中心」：扫码批卷进入 /mark，判完提交后
 *     无论点返回箭头还是结果页按钮，都回到 /mark-center。
 */
export const NAV_PARENT: Record<string, string> = {
    "/mark": "/mark-center", // 批改页 ← 批改中心（不是 /review）
    "/mark-center": "/me", // 批改中心 ← 我的
    "/scan": "/me", // 拍照批改（旧）← 我的
    "/review": "/", // 今日复习卷 ← 首页
    "/mastery": "/stats", // 掌握度 ← 统计中心
};

/** 批改流程结束后「无论如何」要回的页面 */
export const MARK_HOME = "/mark-center";

/** 取某页面的逻辑父页面；带 query/hash 也能命中；未登记的页面回首页 */
export function parentOf(path: string): string {
    const clean = (path || "").split(/[?#]/)[0] || "/";
    if (NAV_PARENT[clean]) return NAV_PARENT[clean];
    for (const key of Object.keys(NAV_PARENT)) {
        if (clean.startsWith(key + "/")) return NAV_PARENT[key];
    }
    return "/";
}
