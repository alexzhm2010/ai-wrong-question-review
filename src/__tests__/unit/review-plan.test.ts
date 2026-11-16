/**
 * 今日复习卷选题逻辑的单元测试。
 * 锁死排序直觉：已掌握直接排除、掌握度越差越优先、越久没做越优先、新题权重低。
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

    it("连续答对 2 次的已掌握题分数沉到最底", () => {
        const mastered = scoreItem({ id: "a", wrongCount: 3, correctCount: 3, correctStreak: 2 }, NOW);
        const weak = scoreItem({ id: "b", wrongCount: 3, correctCount: 0, correctStreak: 0 }, NOW);
        expect(weak.score).toBeGreaterThan(mastered.score);
        expect(mastered.score).toBeLessThan(0);
    });

    it("掌握度越差分越高：待攻克 > 巩固中 > 未开始", () => {
        const weak = scoreItem({ id: "w", wrongCount: 1, correctCount: 0, correctStreak: 0 }, NOW);
        const steady = scoreItem({ id: "s", wrongCount: 1, correctCount: 1, correctStreak: 1 }, NOW);
        const fresh = scoreItem({ id: "n", wrongCount: 0, correctCount: 0, correctStreak: 0, createdAt: daysAgo(3) }, NOW);
        expect(weak.score).toBeGreaterThan(steady.score);
        expect(steady.score).toBeGreaterThan(fresh.score);
    });

    it("越久没做分越高，且 30 天后不再封顶（一路计到 60 天）", () => {
        const d3 = scoreItem({ id: "a", wrongCount: 2, lastAttemptAt: daysAgo(3) }, NOW);
        const d30 = scoreItem({ id: "b", wrongCount: 2, lastAttemptAt: daysAgo(30) }, NOW);
        const d55 = scoreItem({ id: "c", wrongCount: 2, lastAttemptAt: daysAgo(55) }, NOW);
        expect(d30.score).toBeGreaterThan(d3.score);
        expect(d55.score).toBeGreaterThan(d30.score);
    });

    it("没做过的新题只按入库时长给低权重，不再拿 30 天满额", () => {
        // 入库 60 天的新题，时长分封顶 30 天 ×0.6 = 18，而不是过去的 30 ×1.6 = 48
        const fresh = scoreItem({ id: "a", createdAt: daysAgo(60), wrongCount: 0, correctCount: 0 }, NOW);
        expect(fresh.score).toBeLessThan(25);
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
        // pool 里 streak=2 的已掌握题会被排除，剩下的不足 12 道时全部入选
        expect(pickReview(pool.slice(1, 5), 12, { now: NOW })).toHaveLength(3);
    });

    it("已归档的题不会被选中", () => {
        const withArchived = [
            ...pool.slice(1, 4),
            { id: "archived-1", wrongCount: 20, masteryLevel: 3, tags: [{ name: "X" }] },
        ];
        const ids = pickReview(withArchived, 5, { now: NOW }).map((p) => p.item.id);
        expect(ids).not.toContain("archived-1");
    });

    it("连续答对 2 次的已掌握题不会被选中，即使历史错很多", () => {
        const withMastered = [
            ...pool.slice(1, 4),
            { id: "mastered-1", wrongCount: 30, correctCount: 30, correctStreak: 2, tags: [{ name: "X" }] },
        ];
        const ids = pickReview(withMastered, 4, { now: NOW }).map((p) => p.item.id);
        expect(ids).not.toContain("mastered-1");
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
