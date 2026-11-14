/**
 * 年级沿用规则（v1.13.0 定下，v1.19.6 下沉到入库层）。
 *
 * 回归背景：规则原本只做在前端编辑器预填，批量「一键全部入库」不经过编辑器，
 * 导致整批年级为空。这里锁住服务端兜底的核心判定，以及批量入库 handler
 * 确实把「最近一次年级」写进了 ErrorItem 和 BatchItem。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    recentGradeFromRows,
    gradeNeedsInherit,
    resolveGradeForNewItem,
    withInheritedGrade,
} from "@/lib/supabase/routes/grade";

const mocks = vi.hoisted(() => ({ restJson: vi.fn() }));
const restJsonMock = mocks.restJson;

vi.mock("@/lib/supabase/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/supabase/core")>();
    return { ...actual, restJson: mocks.restJson };
});

describe("recentGradeFromRows：从倒序行里取最近一个有效年级", () => {
    it("取第一条有效标准值", () => {
        expect(recentGradeFromRows([
            { gradeSemester: "高一上" },
            { gradeSemester: "高二下" },
        ])).toBe("高一上");
    });

    it("跳过 null / 空串 / 历史脏值，继续往前找", () => {
        expect(recentGradeFromRows([
            { gradeSemester: null },
            { gradeSemester: "" },
            { gradeSemester: "已毕业上" },
            { gradeSemester: "初三" },   // 不在 12 个标准值里
            { gradeSemester: "高二上" },
        ])).toBe("高二上");
    });

    it("首尾空白能归一", () => {
        expect(recentGradeFromRows([{ gradeSemester: "  高一上  " }])).toBe("高一上");
    });

    it("没有有效年级返回 null（不抛错、不返回脏值）", () => {
        expect(recentGradeFromRows([])).toBeNull();
        expect(recentGradeFromRows(null)).toBeNull();
        expect(recentGradeFromRows([{ gradeSemester: "已毕业上" }])).toBeNull();
    });
});

describe("gradeNeedsInherit：谁需要沿用", () => {
    it("null / undefined / 脏值需要沿用", () => {
        expect(gradeNeedsInherit(null)).toBe(true);
        expect(gradeNeedsInherit(undefined)).toBe(true);
        expect(gradeNeedsInherit("初三")).toBe(true);
        expect(gradeNeedsInherit("已毕业上")).toBe(true);
    });

    it("自带有效值、或明确选「未设置」(空串) 都不需要沿用", () => {
        expect(gradeNeedsInherit("高一上")).toBe(false);
        expect(gradeNeedsInherit("高三下")).toBe(false);
        expect(gradeNeedsInherit("")).toBe(false);
    });
});

describe("resolveGradeForNewItem：算出最终年级", () => {
    it("本条自带有效年级优先，不被最近值覆盖", () => {
        expect(resolveGradeForNewItem("高二下", "高一上")).toBe("高二下");
    });

    it("本条没年级 → 沿用最近一次", () => {
        expect(resolveGradeForNewItem(null, "高一上")).toBe("高一上");
        expect(resolveGradeForNewItem(undefined, "高一上")).toBe("高一上");
    });

    it("本条是脏值 → 丢弃并沿用最近一次", () => {
        expect(resolveGradeForNewItem("已毕业上", "高一上")).toBe("高一上");
    });

    it("用户明确选「未设置」→ 尊重，即使库里有最近值", () => {
        expect(resolveGradeForNewItem("", "高一上")).toBe("");
    });

    it("库里也没有历史年级 → 留空，不编造", () => {
        expect(resolveGradeForNewItem(null, null)).toBeNull();
        expect(resolveGradeForNewItem("已毕业上", null)).toBeNull();
    });

    it("最近值是脏值时也不会写入脏数据", () => {
        expect(resolveGradeForNewItem(null, "已毕业上")).toBeNull();
    });
});

describe("withInheritedGrade：写库前兜底", () => {
    beforeEach(() => { restJsonMock.mockReset(); });

    it("自带有效年级时零查询，直接保留", async () => {
        const out = await withInheritedGrade({ gradeSemester: "高二下", questionText: "题" }, "u1");
        expect(out.gradeSemester).toBe("高二下");
        expect(out.questionText).toBe("题");
        expect(restJsonMock).not.toHaveBeenCalled();
    });

    it("明确「未设置」时零查询，尊重用户", async () => {
        const out = await withInheritedGrade({ gradeSemester: "" }, "u1");
        expect(out.gradeSemester).toBe("");
        expect(restJsonMock).not.toHaveBeenCalled();
    });

    it("没年级时查一次库并沿用", async () => {
        restJsonMock.mockResolvedValue([{ gradeSemester: "高一上" }]);
        const out = await withInheritedGrade({ questionText: "题" }, "u1");
        expect(out.gradeSemester).toBe("高一上");
        expect(restJsonMock).toHaveBeenCalledTimes(1);
        const path = restJsonMock.mock.calls[0][0] as string;
        expect(path).toContain("userId=eq.u1");           // 必须按用户隔离
        expect(path).toContain("gradeSemester=not.is.null");
        expect(path).toContain("order=createdAt.desc");
    });

    it("查询失败时留空，不阻断入库", async () => {
        restJsonMock.mockRejectedValue(new Error("network"));
        const out = await withInheritedGrade({}, "u1");
        expect(out.gradeSemester).toBeNull();
    });

    it("不修改传入的原对象", async () => {
        restJsonMock.mockResolvedValue([{ gradeSemester: "高一上" }]);
        const body = { questionText: "题" };
        await withInheritedGrade(body, "u1");
        expect("gradeSemester" in body).toBe(false);
    });
});
