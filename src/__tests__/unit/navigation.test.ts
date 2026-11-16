import { describe, it, expect } from "vitest";
import { NAV_PARENT, MARK_HOME, parentOf } from "@/lib/navigation";

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
