import { describe, it, expect } from "vitest";
import { NAV_PARENT, MARK_HOME, PAPERS_HOME, parentOf, hardNavHref, printPreviewHref } from "@/lib/navigation";

describe("navigation：页面上下步骤规范（批改中心已并入练习试卷）", () => {
    it("批改页的逻辑父页面是练习试卷，绝不能是今日复习卷 /review", () => {
        expect(NAV_PARENT["/mark"]).toBe("/papers");
        expect(NAV_PARENT["/mark"]).not.toBe("/review");
        expect(MARK_HOME).toBe("/papers");
        expect(MARK_HOME).toBe(PAPERS_HOME);
        expect(NAV_PARENT["/mark-center"]).toBeUndefined(); // 批改中心已移除
    });

    it("parentOf 对带 query/hash 的批改地址也能命中练习试卷", () => {
        expect(parentOf("/mark")).toBe("/papers");
        expect(parentOf("/mark?c=261116ABC")).toBe("/papers");
        expect(parentOf("/mark?c=x#top")).toBe("/papers");
    });

    it("其它二级页父页面登记齐全", () => {
        expect(parentOf("/review")).toBe("/");
        expect(parentOf("/mastery")).toBe("/stats");
        expect(parentOf("/scan")).toBe("/me");
    });

    it("练习试卷查看页回到归档页，归档页是侧栏一级入口", () => {
        expect(PAPERS_HOME).toBe("/papers");
        expect(parentOf("/paper-view")).toBe("/papers");
        expect(parentOf("/paper-view?c=abc123")).toBe("/papers");
        expect(parentOf("/papers")).toBe("/");
    });

    it("未登记页面兜底回首页", () => {
        expect(parentOf("/some-unknown-page")).toBe("/");
        expect(parentOf("")).toBe("/");
    });
});

describe("hardNavHref：整页导航 URL 拼接", () => {
    it("补 basePath 且规范化重复斜杠", () => {
        const h = hardNavHref("/print-preview?ids=a,b");
        expect(h).toContain("/print-preview?ids=a,b");
        expect(h).not.toMatch(/([^:]\/)\/+/); // 除协议外无双斜杠
    });

    it("保留调用方已编码的 query", () => {
        const h = hardNavHref("/print-preview?ids=a%2Cb%2Cc");
        expect(h).toContain("ids=a%2Cb%2Cc");
    });

    it("tag 参数整页链接可用", () => {
        expect(hardNavHref("/print-preview?tag=%E6%95%B0%E5%AD%A6")).toContain("tag=");
    });
});

describe("printPreviewHref：打印页地址必须带二维码凭证", () => {
    it("带凭证时 ids / paper / paperNo 一个不少", () => {
        const href = printPreviewHref(["q1", "q2"], "261116ABC123", "261116201033");
        expect(href).toContain("ids=q1%2Cq2");
        expect(href).toContain("paper=261116ABC123");
        expect(href).toContain("paperNo=261116201033");
    });

    it("没有凭证时只带 ids，不出现空的 paper 参数", () => {
        const href = printPreviewHref(["q1", "q2"]);
        expect(href).toContain("ids=q1%2Cq2");
        expect(href).not.toContain("paper=");
    });

    it("凭证含特殊字符时正确编码，不破坏链接", () => {
        const href = printPreviewHref(["a"], "code &+/=", "No 1");
        // URLSearchParams 把空格编码成 +，其余特殊字符百分号编码，均合法
        expect(href).toContain("paper=code+%26%2B%2F%3D");
        expect(href).toContain("paperNo=No+1");
    });

    it("整页导航拼接后凭证仍然完整", () => {
        const href = hardNavHref(printPreviewHref(["q1"], "CODE123", "NO9"));
        expect(href).toContain("/print-preview?");
        expect(href).toContain("paper=CODE123");
        expect(href).toContain("paperNo=NO9");
    });
});
