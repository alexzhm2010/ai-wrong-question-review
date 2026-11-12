/**
 * 掌握度分层与知识点聚合的单元测试。
 * 重点锁住两条产品规则：
 *   1. 连续答对是唯一掌握信号，错一次就归零；
 *   2. 归档（masteryLevel=3）的题不计入任何档位与统计。
 */
import { describe, it, expect } from "vitest";
import {
    bandOf,
    isArchived,
    knowledgeNames,
    summarizeMastery,
    tagMastery,
} from "@/lib/mastery";

describe("bandOf", () => {
    it("连续答对 2 次及以上算已掌握", () => {
        expect(bandOf({ correctStreak: 2, wrongCount: 3, correctCount: 2 })).toBe("mastered");
        expect(bandOf({ correctStreak: 5, wrongCount: 1, correctCount: 5 })).toBe("mastered");
    });

    it("刚答对 1 次算巩固中", () => {
        expect(bandOf({ correctStreak: 1, wrongCount: 2, correctCount: 1 })).toBe("steady");
    });

    it("做过但连续对为 0 算待攻克", () => {
        expect(bandOf({ correctStreak: 0, wrongCount: 1, correctCount: 2 })).toBe("weak");
        // 对过但后来错了（streak 归零）依然是待攻克
        expect(bandOf({ correctStreak: 0, wrongCount: 1, correctCount: 3 })).toBe("weak");
    });

    it("一次都没作答算未开始", () => {
        expect(bandOf({})).toBe("new");
        expect(bandOf({ correctStreak: null, wrongCount: null })).toBe("new");
    });
});

describe("isArchived", () => {
    it("masteryLevel >= 3 视为归档", () => {
        expect(isArchived({ masteryLevel: 3 })).toBe(true);
        expect(isArchived({ masteryLevel: 2 })).toBe(false);
        expect(isArchived({})).toBe(false);
    });
});

describe("summarizeMastery", () => {
    const items = [
        { correctStreak: 2, wrongCount: 2, correctCount: 3 },
        { correctStreak: 1, wrongCount: 1, correctCount: 1 },
        { correctStreak: 0, wrongCount: 3, correctCount: 1 },
        { correctStreak: 0, wrongCount: 0, correctCount: 0 },
        { masteryLevel: 3, correctStreak: 4, wrongCount: 1, correctCount: 4 },
    ];

    it("分档计数不含归档题", () => {
        const s = summarizeMastery(items);
        expect(s.total).toBe(5);
        expect(s.archived).toBe(1);
        expect(s.bands).toEqual({ mastered: 1, steady: 1, weak: 1, new: 1 });
    });

    it("掌握率分母排除未开始与归档", () => {
        const s = summarizeMastery(items);
        // 已学过（非归档非未开始）3 道，掌握 1 道
        expect(s.masteryRate).toBeCloseTo(1 / 3, 5);
    });

    it("题目全未开始时掌握率记 0，不出现除零", () => {
        const s = summarizeMastery([{ correctStreak: 0, wrongCount: 0, correctCount: 0 }]);
        expect(s.masteryRate).toBe(0);
        expect(s.avgWrong).toBe(0);
    });

    it("空数组安全", () => {
        const s = summarizeMastery([]);
        expect(s.total).toBe(0);
        expect(s.masteryRate).toBe(0);
    });
});

describe("knowledgeNames", () => {
    it("优先用关联标签", () => {
        expect(knowledgeNames({ tags: [{ name: "一元二次方程" }], knowledgePoints: '["二次函数"]' }))
            .toEqual(["一元二次方程"]);
    });

    it("没有标签时解析 knowledgePoints JSON", () => {
        expect(knowledgeNames({ knowledgePoints: '["二次函数","判别式"]' })).toEqual(["二次函数", "判别式"]);
    });

    it("脏数据不抛错", () => {
        expect(knowledgeNames({ knowledgePoints: "不是JSON" })).toEqual([]);
        expect(knowledgeNames({})).toEqual([]);
    });
});

describe("tagMastery", () => {
    it("按知识点统计掌握率，并按最弱排前", () => {
        const rows = tagMastery([
            { correctStreak: 2, tags: [{ name: "A" }] },
            { correctStreak: 0, wrongCount: 2, tags: [{ name: "A" }] },
            { correctStreak: 2, tags: [{ name: "B" }] },
            { correctStreak: 2, tags: [{ name: "B" }] },
        ]);
        expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
        expect(rows[0].rate).toBe(0.5);
        expect(rows[1].rate).toBe(1);
    });

    it("只出现一次的孤立知识点不进榜", () => {
        const rows = tagMastery([{ correctStreak: 0, wrongCount: 1, tags: [{ name: "孤立" }] }]);
        expect(rows).toEqual([]);
    });

    it("归档题不参与统计", () => {
        const rows = tagMastery([
            { correctStreak: 2, masteryLevel: 3, tags: [{ name: "A" }] },
            { correctStreak: 2, tags: [{ name: "A" }] },
            { correctStreak: 0, wrongCount: 1, tags: [{ name: "A" }] },
        ]);
        expect(rows[0].total).toBe(2);
        expect(rows[0].mastered).toBe(1);
    });
});
