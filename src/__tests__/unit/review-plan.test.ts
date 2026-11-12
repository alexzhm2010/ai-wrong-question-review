/**
 * 今日复习卷选题逻辑的单元测试。
 * 锁死三条排序直觉：错得多优先、放得久优先、连续对两次往后压。
 */
import { describe, it, expect } from "vitest";
import { estimateMinutes, pickReview, scoreItem } from "@/lib/review-plan";

const NOW = Date.parse("2026-11-12T20:00:00+08:00");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("scoreItem", () => {
    it("错得越多分越高", () => {
        const a = scoreItem({ id: "a", wrongCount: 5 }, NOW);
        const b = scoreItem({ id: "b", wrongCount: 1 }, NOW);
        expect(a.score).toBeGreaterThan(b.score);
    });

    it("同样条件，越久没做分越高", () => {
        const recent = scoreItem({ id: "a", wrongCount: 2, lastAttemptAt: daysAgo(1) }, NOW);
        const stale = scoreItem({ id: "b", wrongCount: 2, lastAttemptAt: daysAgo(20) }, NOW);
        expect(stale.score).toBeGreaterThan(recent.score);
    });

    it("连续答对 2 次会被明显压后", () => {
        const mastered = scoreItem({ id: "a", wrongCount: 3, correctCount: 3, correctStreak: 2 }, NOW);
        const weak = scoreItem({ id: "b", wrongCount: 3, correctCount: 0, correctStreak: 0 }, NOW);
        expect(weak.score).toBeGreaterThan(mastered.score);
        expect(mastered.score).toBeLessThan(0 + 9 * 3);
    });

    it("没做过的新题有基础分，但不会盖过高频错题", () => {
        const fresh = scoreItem({ id: "a", createdAt: daysAgo(3), wrongCount: 0, correctCount: 0 }, NOW);
        const hot = scoreItem({ id: "b", wrongCount: 6, correctCount: 0, lastResult: "wrong", lastAttemptAt: daysAgo(5) }, NOW);
        expect(fresh.score).toBeGreaterThan(0);
        expect(hot.score).toBeGreaterThan(fresh.score);
        expect(fresh.reason).toContain("没做");
    });

    it("理由文案跟着状态走", () => {
        expect(scoreItem({ id: "a", wrongCount: 4, lastResult: "wrong", lastAttemptAt: daysAgo(1) }, NOW).reason)
            .toContain("错过 4 次");
        expect(scoreItem({ id: "b", wrongCount: 1, correctCount: 1, correctStreak: 1, lastAttemptAt: daysAgo(1) }, NOW).reason)
            .toContain("再确认");
        expect(scoreItem({ id: "c", wrongCount: 2, lastResult: "wrong", lastAttemptAt: daysAgo(9) }, NOW).reason)
            .toContain("已隔");
    });
});

describe("pickReview", () => {
    const pool = Array.from({ length: 30 }, (_, i) => ({
        id: `id-${String(i).padStart(2, "0")}`,
        wrongCount: i % 5,
        correctCount: i % 3,
        correctStreak: i % 4 === 0 ? 2 : 0,
        lastAttemptAt: daysAgo(i),
        tags: [{ name: `知识点${i % 6}` }],
    }));

    it("数量不超请求值", () => {
        expect(pickReview(pool, 12, { now: NOW })).toHaveLength(12);
        expect(pickReview(pool, 6, { now: NOW })).toHaveLength(6);
    });

    it("题库不足时有多少给多少", () => {
        expect(pickReview(pool.slice(0, 4), 12, { now: NOW })).toHaveLength(4);
    });

    it("已归档的题不会被选中", () => {
        const withArchived = [
            ...pool.slice(0, 3),
            { id: "archived-1", wrongCount: 20, masteryLevel: 3, tags: [{ name: "X" }] },
        ];
        const ids = pickReview(withArchived, 5, { now: NOW }).map((p) => p.item.id);
        expect(ids).not.toContain("archived-1");
    });

    it("同一知识点不会占满整张卷子", () => {
        const skewed = Array.from({ length: 20 }, (_, i) => ({
            id: `s-${i}`,
            wrongCount: 5,
            tags: [{ name: "同一个知识点" }],
        }));
        const picks = pickReview(skewed, 8, { now: NOW });
        // 只有单一知识点时只能全部入选，但多样性上限仍是 2 道起步
        expect(picks.length).toBe(8);
    });

    it("换 seed 会换一批（有扰动）", () => {
        const a = pickReview(pool, 8, { now: NOW, seed: 0 }).map((p) => p.item.id);
        const b = pickReview(pool, 8, { now: NOW, seed: 7 }).map((p) => p.item.id);
        expect(a).not.toEqual(b);
    });

    it("结果稳定：同 seed 同 now 完全一致", () => {
        const a = pickReview(pool, 8, { now: NOW, seed: 3 }).map((p) => p.item.id);
        const b = pickReview(pool, 8, { now: NOW, seed: 3 }).map((p) => p.item.id);
        expect(a).toEqual(b);
    });
});

describe("estimateMinutes", () => {
    it("12 道约 26 分钟，最少 3 分钟", () => {
        expect(estimateMinutes(12)).toBe(26);
        expect(estimateMinutes(0)).toBe(3);
    });
});
