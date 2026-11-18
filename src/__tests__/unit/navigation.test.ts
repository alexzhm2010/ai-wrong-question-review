import { describe, it, expect } from "vitest";
import { NAV_PARENT, MARK_HOME, parentOf, hardNavHref } from "@/lib/navigation";

describe("navigation：页面上下步骤规范", () => {
    it("批改页的逻辑父页面是批改中心，绝不能是今日复习卷 /review", () => {
        expect(NAV_PARENT["/mark"]).toBe("/mark-center");
        expect(NAV_PARENT["/mark"]).not.toBe("/review");
        expect(MARK_HOME).toBe("/mark-center");
    });

    it("parentOf 对带 query/hash 的批改地址也能命中", () => {
        expect(parentOf("/mark")).toBe("/mark-center");
        expect(parentOf("/mark?c=261116ABC")).toBe("/mark-center");
        expect(parentOf("/mark?c=x#top")).toBe("/mark-center");
    });

    it("批改中心回到我的；其它二级页父页面登记齐全", () => {
        expect(parentOf("/mark-center")).toBe("/me");
        expect(parentOf("/review")).toBe("/");
        expect(parentOf("/mastery")).toBe("/stats");
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
