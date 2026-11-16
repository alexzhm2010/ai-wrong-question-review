import { describe, it, expect } from "vitest";
import {
    normalizeShellPath,
    isShellExempt,
    activeTabKey,
    isNavActive,
    SHELL_EXEMPT_PREFIXES,
} from "@/lib/app-shell-path";

const BASE = "/ai-wrong-question-review";

describe("normalizeShellPath", () => {
    it("剥掉 basePath", () => {
        expect(normalizeShellPath(BASE + "/notebooks")).toBe("/notebooks");
        expect(normalizeShellPath(BASE + "/me")).toBe("/me");
        expect(normalizeShellPath(BASE)).toBe("/");
    });

    it("不带 basePath 的路径原样保留", () => {
        expect(normalizeShellPath("/")).toBe("/");
        expect(normalizeShellPath("/review")).toBe("/review");
        expect(normalizeShellPath("/notebook/add")).toBe("/notebook/add");
    });

    it("去掉尾部斜杠（trailingSlash 构建）", () => {
        expect(normalizeShellPath("/notebooks/")).toBe("/notebooks");
        expect(normalizeShellPath(BASE + "/review/")).toBe("/review");
        expect(normalizeShellPath("/")).toBe("/");
    });

    it("空值与相对路径兜底", () => {
        expect(normalizeShellPath(null)).toBe("/");
        expect(normalizeShellPath(undefined)).toBe("/");
        expect(normalizeShellPath("me")).toBe("/me");
    });
});

describe("isShellExempt", () => {
    it("全屏表单 / 打印 / 后台 / 沉浸式流程页不带壳", () => {
        const cases = [
            "/login", "/register", "/admin", "/admin/user", "/print-preview",
            "/latex-test", "/item", "/scan", "/practice", "/mark",
        ];
        for (const p of cases) expect(isShellExempt(p), p).toBe(true);
    });

    it("带 basePath 与尾斜杠时同样判定", () => {
        expect(isShellExempt(BASE + "/login/")).toBe(true);
        expect(isShellExempt(BASE + "/item/")).toBe(true);
        expect(isShellExempt(BASE + "/scan/")).toBe(true);
        expect(isShellExempt(BASE + "/mark/")).toBe(true);
        expect(isShellExempt(BASE + "/notebooks/")).toBe(false);
    });

    it("主流程页都带壳", () => {
        const cases = ["/", "/notebooks", "/notebook", "/review", "/mastery", "/tags", "/stats", "/batch", "/me", "/grade"];
        for (const p of cases) expect(isShellExempt(p), p).toBe(false);
    });

    it("前缀边界不误伤（/itemized 不是 /item）", () => {
        expect(isShellExempt("/itemized")).toBe(false);
        expect(isShellExempt("/practice-log")).toBe(false);
    });

    it("白名单常量与预期一致", () => {
        expect(SHELL_EXEMPT_PREFIXES).toContain("/print-preview");
        expect(SHELL_EXEMPT_PREFIXES).toContain("/admin");
    });
});

describe("activeTabKey", () => {
    it("4 个主 Tab 各自命中", () => {
        expect(activeTabKey("/")).toBe("/");
        expect(activeTabKey("/notebooks")).toBe("/notebooks");
        expect(activeTabKey("/notebook/add")).toBe("/notebooks");
        expect(activeTabKey("/review")).toBe("/review");
        expect(activeTabKey("/me")).toBe("/me");
    });

    it("二级页归到对应主 Tab", () => {
        expect(activeTabKey("/notebook/add")).toBe("/notebooks");
        expect(activeTabKey("/mastery")).toBe("/review");
        expect(activeTabKey("/practice")).toBe("/review");
        expect(activeTabKey("/tags")).toBe("/me");
        expect(activeTabKey("/stats")).toBe("/me");
        expect(activeTabKey("/batch")).toBe("/me");
        expect(activeTabKey("/grade")).toBe("/me");
    });

    it("basePath 不影响命中", () => {
        expect(activeTabKey(BASE + "/notebooks/")).toBe("/notebooks");
        expect(activeTabKey(BASE + "/review")).toBe("/review");
    });
});

describe("isNavActive（桌面侧栏）", () => {
    it("首页只在根路径高亮", () => {
        expect(isNavActive("/", "/")).toBe(true);
        expect(isNavActive("/", "/notebooks")).toBe(false);
    });

    it("精确与子路径命中", () => {
        expect(isNavActive("/batch", "/batch")).toBe(true);
        expect(isNavActive("/batch", "/batch/detail")).toBe(true);
        expect(isNavActive("/batch", "/me")).toBe(false);
    });

    it("额外前缀让详情页高亮到父项", () => {
        expect(isNavActive("/notebooks", "/notebook", ["/notebook"])).toBe(true);
        expect(isNavActive("/review", "/practice", ["/practice"])).toBe(true);
    });

    it("basePath 下同样正确", () => {
        expect(isNavActive("/notebooks", BASE + "/notebooks/", ["/notebook"])).toBe(true);
        expect(isNavActive("/", BASE + "/")).toBe(true);
    });
});
