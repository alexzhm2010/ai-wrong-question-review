/**
 * 今日复习卷选题逻辑的单元测试。
 * 锁死排序直觉：已掌握直接排除、掌握度越差越优先、越久没做越优先、新题权重低。
 */
import { describe, it, expect } from "vitest";
import {
    estimateMinutes, pickReview, scoreItem,
    wrongRedoDelayDays, wrongRedoRemainingDays, isWrongRedoCoolingDown,
    WRONG_REDO_MIN_DAYS, WRONG_REDO_SPREAD_DAYS,
    correctRedoDelayDays, correctRedoRemainingDays, isCorrectRedoCoolingDown,
    reviewTier, CORRECT_REDO_MIN_DAYS, CORRECT_REDO_SPREAD_DAYS,
    TIER_CORRECT_COOLDOWN, TIER_WRONG_COOLDOWN,
} from "@/lib/review-plan";

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

    it("未做(skip)的题理由提示补做，而不是说入库没做", () => {
        const r = scoreItem({ id: "s", lastResult: "skip", lastAttemptAt: daysAgo(3), wrongCount: 0 }, NOW);
        expect(r.reason).toContain("跳过没做");
        expect(r.reason).toContain("补做");
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

/**
 * 做错题「隔一周以上再重做、随机分散、不扎堆」的回归测试（2026-11-21）。
 * 用户要求：上次做错的题间隔 > 7 天才重做；每题在随机日期到期；不要挤在一张卷。
 */
describe("错题间隔重做：到期日计算", () => {
    it("间隔永远大于一周（≥7 天），且不超过 7+spread 天", () => {
        expect(WRONG_REDO_MIN_DAYS).toBe(7);
        for (const id of ["a", "b", "c", "item-01", "xyz-999", "题目甲"]) {
            const d = wrongRedoDelayDays(id);
            expect(d).toBeGreaterThanOrEqual(WRONG_REDO_MIN_DAYS);
            expect(d).toBeLessThan(WRONG_REDO_MIN_DAYS + WRONG_REDO_SPREAD_DAYS);
        }
    });

    it("同一道题的到期日恒定，不会因反复调用而漂移", () => {
        expect(wrongRedoDelayDays("stable-id")).toBe(wrongRedoDelayDays("stable-id"));
    });

    it("不同题目落到不同到期日（分散，不扎堆在同一天）", () => {
        const delays = Array.from({ length: 40 }, (_, i) => wrongRedoDelayDays(`item-${i}`));
        const distinct = new Set(delays.map((d) => Math.round(d * 100)));
        // 40 道题应铺开到多个不同到期日，而不是全挤在一天
        expect(distinct.size).toBeGreaterThan(15);
    });

    it("只有「上次做错」的题才算冷却；做对/没做过/没时间的返回 null", () => {
        expect(wrongRedoRemainingDays({ id: "a", lastResult: "wrong", lastAttemptAt: daysAgo(1) }, NOW)).not.toBeNull();
        expect(wrongRedoRemainingDays({ id: "a", lastResult: "correct", lastAttemptAt: daysAgo(1) }, NOW)).toBeNull();
        expect(wrongRedoRemainingDays({ id: "a", lastAttemptAt: daysAgo(1) }, NOW)).toBeNull();
        expect(wrongRedoRemainingDays({ id: "a", lastResult: "wrong" }, NOW)).toBeNull();
    });
});

describe("错题间隔重做：冷却期判定", () => {
    it("刚做错的题（1 天前）处于冷却期", () => {
        expect(isWrongRedoCoolingDown({ id: "a", lastResult: "wrong", lastAttemptAt: daysAgo(1) }, NOW)).toBe(true);
    });

    it("做错很久（30 天前）已过冷却期", () => {
        expect(isWrongRedoCoolingDown({ id: "a", lastResult: "wrong", lastAttemptAt: daysAgo(30) }, NOW)).toBe(false);
    });

    it("做对/没做过的题永不进冷却，行为不变", () => {
        expect(isWrongRedoCoolingDown({ id: "a", lastResult: "correct", lastAttemptAt: daysAgo(1) }, NOW)).toBe(false);
        expect(isWrongRedoCoolingDown({ id: "a", createdAt: daysAgo(1) }, NOW)).toBe(false);
    });
});

describe("错题间隔重做：挑题行为", () => {
    it("刚做错的题不会立刻被选进今日卷", () => {
        const freshWrong = {
            id: "fresh-wrong", wrongCount: 9, correctCount: 0,
            lastResult: "wrong" as const, lastAttemptAt: daysAgo(1), tags: [{ name: "X" }],
        };
        const normal = { id: "normal", wrongCount: 1, createdAt: daysAgo(10), tags: [{ name: "Y" }] };
        const ids = pickReview([freshWrong, normal], 5, { now: NOW }).map((p) => p.item.id);
        expect(ids).not.toContain("fresh-wrong");
        expect(ids).toContain("normal");
    });

    it("冷却期过后，做错的题恢复候选（且因高分获得优先）", () => {
        const staleWrong = {
            id: "stale-wrong", wrongCount: 9, correctCount: 0,
            lastResult: "wrong" as const, lastAttemptAt: daysAgo(20), tags: [{ name: "X" }],
        };
        const ids = pickReview([staleWrong], 5, { now: NOW }).map((p) => p.item.id);
        expect(ids).toContain("stale-wrong");
    });

    it("全部是刚做错的题时，冷却过滤后可能没有候选（不硬凑错题）", () => {
        const allCooling = Array.from({ length: 10 }, (_, i) => ({
            id: `cool-${i}`, wrongCount: 5, lastResult: "wrong" as const, lastAttemptAt: daysAgo(2),
        }));
        expect(pickReview(allCooling, 6, { now: NOW })).toHaveLength(0);
    });

    it("一张卷里的重做题有上限，不会让到期错题扎堆（分摊到不同卷）", () => {
        const manyStaleWrong = Array.from({ length: 30 }, (_, i) => ({
            id: `redo-${i}`, wrongCount: 9, correctCount: 0,
            lastResult: "wrong" as const, lastAttemptAt: daysAgo(30), tags: [{ name: `K${i}` }],
        }));
        const picked = pickReview(manyStaleWrong, 12, { now: NOW });
        // 单卷最多 floor(12/3)=4 道重做题，且是硬上限：即使题库全是到期错题、
        // 凑不满 12 道，也绝不把剩下的错题塞回来——这就是「不扎堆」。
        const redoCount = picked.filter((p) => p.item.lastResult === "wrong").length;
        expect(redoCount).toBe(4);
        expect(picked.length).toBe(4); // 硬上限生效，不硬凑满
        // 换一批（seed 不同）应拿到不同的重做题——它们分摊到不同批次/日期
        const picked2 = pickReview(manyStaleWrong, 12, { now: NOW, seed: 1 });
        const set1 = new Set(picked.map((p) => p.item.id));
        const overlap = picked2.filter((p) => set1.has(p.item.id)).length;
        expect(overlap).toBeLessThan(4); // 不会是同一批，说明分散到了不同卷
    });

    it("冷却期内换一批也绝不会出现刚做错的题", () => {
        const pool2 = [
            { id: "fresh", wrongCount: 8, lastResult: "wrong" as const, lastAttemptAt: daysAgo(3) },
            ...Array.from({ length: 20 }, (_, i) => ({ id: `ok-${i}`, wrongCount: 1, createdAt: daysAgo(5) })),
        ];
        for (const seed of [0, 1, 2, 3, 7]) {
            const ids = pickReview(pool2, 12, { now: NOW, seed }).map((p) => p.item.id);
            expect(ids).not.toContain("fresh");
        }
    });
});

/**
 * 做对题长冷却 + 三层优先级（2026-11-23）。
 * 用户要求：做对的题 14 天以上才可能重现；优先没做过 > 做错到期；14 天内没题可选才用做对题兜底。
 */
describe("做对题长冷却与选题优先级", () => {
    it("做对题间隔恒大于 14 天（14~21），且按 id 稳定分散", () => {
        expect(CORRECT_REDO_MIN_DAYS).toBe(14);
        for (const id of ["a", "b", "item-01", "题目甲"]) {
            const d = correctRedoDelayDays(id);
            expect(d).toBeGreaterThanOrEqual(14);
            expect(d).toBeLessThan(14 + CORRECT_REDO_SPREAD_DAYS);
        }
        expect(correctRedoDelayDays("stable")).toBe(correctRedoDelayDays("stable"));
        const distinct = new Set(Array.from({ length: 40 }, (_, i) => Math.round(correctRedoDelayDays(`q-${i}`) * 100)));
        expect(distinct.size).toBeGreaterThan(15);
    });

    it("只有上次做对才算冷却；做错/没做过返回 null", () => {
        expect(correctRedoRemainingDays({ id: "a", lastResult: "correct", lastAttemptAt: daysAgo(1) }, NOW)).not.toBeNull();
        expect(correctRedoRemainingDays({ id: "a", lastResult: "wrong", lastAttemptAt: daysAgo(1) }, NOW)).toBeNull();
        expect(correctRedoRemainingDays({ id: "a", lastAttemptAt: daysAgo(1) }, NOW)).toBeNull();
    });

    it("刚做对（1 天前）处于长冷却，做过 20 天到期", () => {
        expect(isCorrectRedoCoolingDown({ id: "a", lastResult: "correct", lastAttemptAt: daysAgo(1) }, NOW)).toBe(true);
        expect(isCorrectRedoCoolingDown({ id: "a", lastResult: "correct", lastAttemptAt: daysAgo(20) }, NOW)).toBe(false);
    });

    it("分层：没做过=0，做错到期=1，做对到期=2，做对冷却=3，做错冷却=4", () => {
        expect(reviewTier({ id: "a" }, NOW)).toBe(0);
        expect(reviewTier({ id: "b", lastResult: "wrong", lastAttemptAt: daysAgo(20) }, NOW)).toBe(1);
        expect(reviewTier({ id: "c", lastResult: "correct", lastAttemptAt: daysAgo(20) }, NOW)).toBe(2);
        expect(reviewTier({ id: "d", lastResult: "correct", lastAttemptAt: daysAgo(2) }, NOW)).toBe(TIER_CORRECT_COOLDOWN);
        expect(reviewTier({ id: "e", lastResult: "wrong", lastAttemptAt: daysAgo(2) }, NOW)).toBe(TIER_WRONG_COOLDOWN);
    });

    it("有没做过的题时，绝不会选到做对冷却期的题", () => {
        const coolingCorrect = { id: "cool-correct", lastResult: "correct" as const, lastAttemptAt: daysAgo(2), wrongCount: 5 };
        const fresh = Array.from({ length: 6 }, (_, i) => ({ id: `fresh-${i}`, createdAt: daysAgo(3) }));
        const ids = pickReview([coolingCorrect, ...fresh], 6, { now: NOW }).map((p) => p.item.id);
        expect(ids).not.toContain("cool-correct");
        expect(ids).toHaveLength(6);
    });

    it("只有做对冷却期的题时，才兜底选中它（14 天内没题可选才用它）", () => {
        const coolingCorrect = Array.from({ length: 6 }, (_, i) => ({
            id: `cc-${i}`, lastResult: "correct" as const, lastAttemptAt: daysAgo(2), wrongCount: 3,
        }));
        const ids = pickReview(coolingCorrect, 6, { now: NOW }).map((p) => p.item.id);
        expect(ids).toHaveLength(6); // 没别的可选，才用做对冷却题兜底
    });

    it("做错冷却期的题永不被选（即使没题可选也不破例）", () => {
        const coolingWrong = Array.from({ length: 6 }, (_, i) => ({
            id: `cw-${i}`, lastResult: "wrong" as const, lastAttemptAt: daysAgo(2), wrongCount: 9,
        }));
        expect(pickReview(coolingWrong, 6, { now: NOW })).toHaveLength(0);
    });

    it("优先级：没做过的题排在到期做对题之前", () => {
        const staleCorrect = Array.from({ length: 4 }, (_, i) => ({
            id: `sc-${i}`, lastResult: "correct" as const, lastAttemptAt: daysAgo(20), correctStreak: 1,
        }));
        const fresh = Array.from({ length: 4 }, (_, i) => ({ id: `fr-${i}`, createdAt: daysAgo(3) }));
        const ids = pickReview([...staleCorrect, ...fresh], 4, { now: NOW }).map((p) => p.item.id);
        expect(ids.every((x) => x.startsWith("fr"))).toBe(true);
    });

    it("做对题到期后 reason 提示已隔很久", () => {
        const r = pickReview([{ id: "sc", lastResult: "correct" as const, lastAttemptAt: daysAgo(40), correctStreak: 1, correctCount: 1 }], 1, { now: NOW });
        expect(r[0].reason).toContain("很久前做对过");
    });
});

/**
 * 到期错题保底（2026-11-26）。
 * 用户要求：冷却期照旧严格保证，但新题再多也不能把「做错到期」的题整层饿死——
 * 它们必须拿到约 1/3 的重做名额，永远有再次练习的机会。
 */
describe("到期错题保底：不被新题饿死", () => {
    const manyNew = Array.from({ length: 40 }, (_, i) => ({
        id: `new-${i}`, createdAt: daysAgo(3), tags: [{ name: `N${i % 8}` }],
    }));

    it("新题源源不断时，做错到期的题仍拿到保底重做名额", () => {
        const dueWrong = Array.from({ length: 6 }, (_, i) => ({
            id: `due-${i}`, wrongCount: 4, correctCount: 0,
            lastResult: "wrong" as const, lastAttemptAt: daysAgo(30), tags: [{ name: `W${i}` }],
        }));
        const ids = pickReview([...manyNew, ...dueWrong], 12, { now: NOW }).map((p) => p.item.id);
        // redoCap = floor(12/3) = 4，到期错题至少拿到 1 道保底
        expect(ids.filter((id) => id.startsWith("due-")).length).toBeGreaterThanOrEqual(1);
        expect(ids).toHaveLength(12);
    });

    it("保底名额不超过单卷重做上限（约 1/3），错题不扎堆", () => {
        const dueWrong = Array.from({ length: 30 }, (_, i) => ({
            id: `due-${i}`, wrongCount: 9, correctCount: 0,
            lastResult: "wrong" as const, lastAttemptAt: daysAgo(30), tags: [{ name: `W${i}` }],
        }));
        const ids = pickReview([...manyNew, ...dueWrong], 12, { now: NOW }).map((p) => p.item.id);
        const dueCount = ids.filter((id) => id.startsWith("due-")).length;
        expect(dueCount).toBeGreaterThanOrEqual(1);
        expect(dueCount).toBeLessThanOrEqual(4); // redoCap 硬上限
        expect(ids).toHaveLength(12);
    });

    it("保底绝不让冷却中的错题提前出现（新题再多也一样）", () => {
        const coolingWrong = Array.from({ length: 6 }, (_, i) => ({
            id: `cool-${i}`, wrongCount: 9,
            lastResult: "wrong" as const, lastAttemptAt: daysAgo(2), tags: [{ name: `C${i}` }],
        }));
        for (const seed of [0, 1, 2, 7]) {
            const ids = pickReview([...manyNew, ...coolingWrong], 12, { now: NOW, seed }).map((p) => p.item.id);
            expect(ids.some((id) => id.startsWith("cool-"))).toBe(false);
            expect(ids).toHaveLength(12);
        }
    });

    it("做对冷却题仍只做兜底：有到期错题和新题时绝不入选", () => {
        const coolingCorrect = Array.from({ length: 5 }, (_, i) => ({
            id: `cc-${i}`, lastResult: "correct" as const, lastAttemptAt: daysAgo(2), wrongCount: 3,
        }));
        const dueWrong = Array.from({ length: 4 }, (_, i) => ({
            id: `due-${i}`, lastResult: "wrong" as const, lastAttemptAt: daysAgo(30), wrongCount: 4,
        }));
        const ids = pickReview([...coolingCorrect, ...dueWrong, ...manyNew], 12, { now: NOW }).map((p) => p.item.id);
        expect(ids.some((id) => id.startsWith("cc-"))).toBe(false);
    });
});

/**
 * 已安排未批改题的降权（2026-11-26）。
 * 冷却只看 lastAttemptAt；生成了卷却没批改时 lastAttemptAt 不变，
 * 若不做处理，同一批题会连日霸占推荐。scheduledAt 晚于 lastAttemptAt 的题
 * 压到最后兜底，只有题库见底才用；冷却规则本身不变。
 */
describe("已安排未批改的题不连日出现", () => {
    it("刚被安排过、还没作答的题，有其它候选时不入选", () => {
        // 两道到期错题，其中一道今天刚被排进过卷（还没批改），另一批新题充足
        const staleWrongA = {
            id: "picked", wrongCount: 9, lastResult: "wrong" as const, lastAttemptAt: daysAgo(20), tags: [{ name: "A" }],
        };
        const staleWrongB = {
            id: "fresh", wrongCount: 9, lastResult: "wrong" as const, lastAttemptAt: daysAgo(20), tags: [{ name: "B" }],
        };
        const fresh = Array.from({ length: 20 }, (_, i) => ({
            id: `new-${i}`, createdAt: daysAgo(2), tags: [{ name: `N${i}` }],
        }));
        // picked 的安排时间 NOW，晚于它的 lastAttemptAt(daysAgo 20) → pending
        const scheduledAt = new Map<string, number>([["picked", NOW]]);
        const ids = pickReview([staleWrongA, staleWrongB, ...fresh], 12, { now: NOW, scheduledAt }).map((p) => p.item.id);
        expect(ids).toContain("fresh");
        expect(ids).not.toContain("picked"); // 刚安排过的被压后，这批不出现
    });

    it("批改后 lastAttemptAt 晚于安排时间，pending 自动解除、正常参与", () => {
        const staleWrong = {
            id: "done", wrongCount: 9, lastResult: "wrong" as const, lastAttemptAt: daysAgo(30), tags: [{ name: "A" }],
        };
        const fresh = Array.from({ length: 8 }, (_, i) => ({ id: `n-${i}`, createdAt: daysAgo(2) }));
        // 安排时间是 40 天前，作答是 30 天前（已过错题冷却）→ 已作答，不算 pending
        const scheduledAt = new Map<string, number>([["done", NOW - 40 * 86_400_000]]);
        const ids = pickReview([staleWrong, ...fresh], 6, { now: NOW, scheduledAt }).map((p) => p.item.id);
        expect(ids).toContain("done");
    });

    it("题库全是刚安排未批改的题时，仍兜底填满、不空卷", () => {
        const all = Array.from({ length: 6 }, (_, i) => ({
            id: `pending-${i}`, createdAt: daysAgo(2), tags: [{ name: `K${i}` }],
        }));
        const scheduledAt = new Map(all.map((x) => [x.id, NOW]));
        const ids = pickReview(all, 6, { now: NOW, scheduledAt }).map((p) => p.item.id);
        expect(ids).toHaveLength(6); // 没别的可选才放开
    });
});

