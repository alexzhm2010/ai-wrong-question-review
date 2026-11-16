/**
 * 方案 C 导航壳的路径判定（纯函数，便于单测）。
 *
 * 静态导出 + basePath 下，usePathname() 是否带前缀在不同 Next 版本行为不一致，
 * 这里统一剥一次 BASE_PATH，保证侧栏 / 底部 Tab 的选中态不失效。
 */

/** 不套主外壳的页面：全屏表单 / 打印 / 后台 / 沉浸式流程页 */
export const SHELL_EXEMPT_PREFIXES = [
    "/login",
    "/register",
    "/admin",
    "/print-preview",
    "/latex-test",
    "/item",
    "/scan",
    "/practice",
    "/mark",
] as const;

const BASE_PATH = "/ai-wrong-question-review";

/** 去掉 basePath 与尾部斜杠，得到可比较的路径 */
export function normalizeShellPath(pathname: string | null | undefined): string {
    let p = pathname || "/";
    if (BASE_PATH && (p === BASE_PATH || p.startsWith(BASE_PATH + "/"))) {
        p = p.slice(BASE_PATH.length) || "/";
    }
    if (!p.startsWith("/")) p = "/" + p;
    while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
}

/** 该路径是否不带导航壳 */
export function isShellExempt(pathname: string | null | undefined): boolean {
    const p = normalizeShellPath(pathname);
    return SHELL_EXEMPT_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

/** 手机 4 Tab 的选中项（管理类页面归到「我的」） */
export function activeTabKey(pathname: string | null | undefined): string {
    const p = normalizeShellPath(pathname);
    if (p === "/") return "/";
    if (p.startsWith("/notebook")) return "/notebooks";
    if (p.startsWith("/review") || p.startsWith("/mastery") || p.startsWith("/practice")) return "/review";
    if (
        p.startsWith("/me") || p.startsWith("/tags") || p.startsWith("/stats") ||
        p.startsWith("/batch") || p.startsWith("/grade") || p.startsWith("/scan")
    ) return "/me";
    return "/";
}

/** 桌面侧栏某一项是否高亮 */
export function isNavActive(
    href: string,
    pathname: string | null | undefined,
    extraPrefixes: string[] = [],
): boolean {
    const p = normalizeShellPath(pathname);
    if (href === "/") return p === "/";
    if (p === href || p.startsWith(href + "/")) return true;
    return extraPrefixes.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}
