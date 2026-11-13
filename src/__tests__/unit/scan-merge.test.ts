import { describe, expect, it } from "vitest";
import { mergeHits, needsReview, planReview, type ScanHit } from "@/lib/scan-merge";

const hit = (p: Partial<ScanHit> & { code: string }): ScanHit => ({
    verdict: "correct",
    confidence: 0.9,
    studentAnswer: "A",
    stripKey: "p1-0",
    pageId: "p1",
    pass: 1,
    ...p,
});

describe("mergeHits 去重", () => {
    it("同一编号只出一条，取置信度高的", () => {
        const rows = mergeHits([
            hit({ code: "1", confidence: 0.5 }),
            hit({ code: "1", confidence: 0.9, stripKey: "p1-1" }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].confidence).toBeCloseTo(0.9);
        expect(rows[0].sources).toHaveLength(2);
    });

    it("保持编号首次出现的顺序", () => {
        const rows = mergeHits([hit({ code: "B" }), hit({ code: "A" }), hit({ code: "B", stripKey: "p1-2" })]);
        expect(rows.map((r) => r.code)).toEqual(["B", "A"]);
    });

    it("同一段内重复出现不会算成多来源", () => {
        const rows = mergeHits([hit({ code: "1" }), hit({ code: "1" })]);
        expect(rows[0].sources).toHaveLength(1);
        expect(rows[0].multiPage).toBe(false);
    });
});

describe("重叠区的 skip 噪声", () => {
    it("skip 与 correct 并存时判对，且不算冲突", () => {
        // 边缘段只拍到半截，看不到作答框，于是给了 blank
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.85, stripKey: "p1-0" }),
            hit({ code: "1", verdict: "correct", confidence: 0.7, stripKey: "p1-1" }),
        ]);
        expect(rows[0].verdict).toBe("correct");
        expect(rows[0].conflict).toBe(false);
    });

    it("skip 置信度极高也不会盖掉低一点的 wrong", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.95 }),
            hit({ code: "1", verdict: "wrong", confidence: 0.4, stripKey: "p1-1" }),
        ]);
        expect(rows[0].verdict).toBe("wrong");
        expect(rows[0].conflict).toBe(false);
    });

    it("另一段只是瞎猜（置信 <35%）时，空白仍然算没做", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.95 }),
            hit({ code: "1", verdict: "correct", confidence: 0.2, stripKey: "p1-1" }),
        ]);
        expect(rows[0].verdict).toBe("skip");
    });

    it("全都是 skip 时仍然判没做", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.9 }),
            hit({ code: "1", verdict: "skip", confidence: 0.8, stripKey: "p1-1" }),
        ]);
        expect(rows[0].verdict).toBe("skip");
    });
});

describe("真冲突", () => {
    it("同一编号一处判对一处判错 → 冲突", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "correct", confidence: 0.8 }),
            hit({ code: "1", verdict: "wrong", confidence: 0.7, stripKey: "p1-1" }),
        ]);
        expect(rows[0].conflict).toBe(true);
        expect(needsReview(rows[0])).toBe(true);
    });

    it("两页都出现同一编号 → 标记多页，但仍是一条", () => {
        const rows = mergeHits([
            hit({ code: "1", pageId: "p1" }),
            hit({ code: "1", pageId: "p2", stripKey: "p2-0" }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].multiPage).toBe(true);
        expect(rows[0].conflict).toBe(false);
    });
});

describe("第二轮复核", () => {
    it("复核同意 → verified，置信度抬到 0.75 以上", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "wrong", confidence: 0.4 }),
            hit({ code: "1", verdict: "wrong", confidence: 0.45, pass: 2, stripKey: "p1-0:r2" }),
        ]);
        expect(rows[0].verified).toBe(true);
        expect(rows[0].conflict).toBe(false);
        expect(rows[0].confidence).toBeGreaterThanOrEqual(0.75);
        expect(needsReview(rows[0])).toBe(false);
    });

    it("复核推翻首轮 → 以复核为准，但标冲突", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.5 }),
            hit({ code: "1", verdict: "correct", confidence: 0.8, pass: 2, stripKey: "p1-0:r2" }),
        ]);
        expect(rows[0].verdict).toBe("correct");
        expect(rows[0].corrected).toBe(true);
        expect(rows[0].conflict).toBe(true);
        expect(rows[0].confidence).toBeLessThanOrEqual(0.55);
    });

    it("复核只是补了作答文字、判定没变，不算改判", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "correct", confidence: 0.5, studentAnswer: "" }),
            hit({ code: "1", verdict: "correct", confidence: 0.6, pass: 2, stripKey: "p1-0:r2", studentAnswer: "B" }),
        ]);
        expect(rows[0].corrected).toBe(false);
        expect(rows[0].studentAnswer).toBe("B");
    });
});

describe("needsReview", () => {
    it("低置信要人看，高置信不用", () => {
        expect(needsReview({ conflict: false, confidence: 0.5, verdict: "correct" })).toBe(true);
        expect(needsReview({ conflict: false, confidence: 0.9, verdict: "correct" })).toBe(false);
    });

    it("本地字母比对定过的题不再要人看", () => {
        expect(needsReview({ conflict: false, confidence: 0.2, verdict: "correct" }, { localChecked: true })).toBe(false);
    });

    it("冲突优先于一切，本地定过也提示", () => {
        expect(needsReview({ conflict: true, confidence: 0.99, verdict: "wrong" }, { localChecked: true })).toBe(true);
    });
});

describe("planReview 分组", () => {
    const strips = [{ key: "s0" }, { key: "s1" }, { key: "s2" }, { key: "s3" }];

    it("把握不足的题按它所在的段归组", () => {
        const tasks = planReview({
            uncertain: [
                { code: "a", stripKey: "s1" },
                { code: "b", stripKey: "s1" },
                { code: "c", stripKey: "s3" },
            ],
            missing: [],
            strips,
            itemCount: 4,
        });
        expect(tasks).toEqual([
            { stripKey: "s1", codes: ["a", "b"] },
            { stripKey: "s3", codes: ["c"] },
        ]);
    });

    it("漏识别的题按批内序号折算到对应段", () => {
        const tasks = planReview({
            uncertain: [],
            missing: [
                { code: "first", order: 0 },
                { code: "last", order: 5 },
            ],
            strips,
            itemCount: 6,
        });
        expect(tasks).toEqual([
            { stripKey: "s0", codes: ["first"] },
            { stripKey: "s3", codes: ["last"] },
        ]);
    });

    it("漏识别的题和低置信题落在同一段时合并成一次请求", () => {
        const tasks = planReview({
            uncertain: [{ code: "a", stripKey: "s0" }],
            missing: [{ code: "b", order: 0 }],
            strips,
            itemCount: 6,
        });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].codes.sort()).toEqual(["a", "b"]);
    });

    it("只有一段时全部归到那一段", () => {
        const tasks = planReview({
            uncertain: [],
            missing: [
                { code: "a", order: 0 },
                { code: "b", order: 9 },
            ],
            strips: [{ key: "only" }],
            itemCount: 10,
        });
        expect(tasks).toEqual([{ stripKey: "only", codes: ["a", "b"] }]);
    });

    it("超过段数上限后不再新建请求", () => {
        const tasks = planReview({
            uncertain: [
                { code: "a", stripKey: "s0" },
                { code: "b", stripKey: "s1" },
                { code: "c", stripKey: "s2" },
                { code: "d", stripKey: "s3" },
            ],
            missing: [],
            strips,
            itemCount: 4,
            maxStrips: 2,
        });
        expect(tasks).toHaveLength(2);
    });

    it("每段带的编号有上限，多的丢掉而不是超发", () => {
        const tasks = planReview({
            uncertain: ["a", "b", "c", "d"].map((code) => ({ code, stripKey: "s0" })),
            missing: [],
            strips,
            itemCount: 4,
            maxCodes: 3,
        });
        expect(tasks[0].codes).toEqual(["a", "b", "c"]);
    });

    it("来源段已经不存在时跳过，不留空请求", () => {
        const tasks = planReview({
            uncertain: [{ code: "a", stripKey: "gone" }],
            missing: [],
            strips,
            itemCount: 4,
        });
        expect(tasks).toEqual([]);
    });
});

describe("复核确认空白", () => {
    it("首轮没读到、复核判空白 → 标记为已确认空白，而不是漏识别", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.9, pass: 2, stripKey: "p1-0:r2" }),
        ]);
        expect(rows[0].reviewedBlank).toBe(true);
        expect(rows[0].verdict).toBe("skip");
        // 置信度高，不必再提示人看
        expect(needsReview(rows[0])).toBe(false);
    });

    it("首轮就读到、复核也说空白 → 仍是复核一致，不算确认空白", () => {
        const rows = mergeHits([
            hit({ code: "1", verdict: "skip", confidence: 0.8 }),
            hit({ code: "1", verdict: "skip", confidence: 0.7, pass: 2, stripKey: "p1-0:r2" }),
        ]);
        expect(rows[0].reviewedBlank).toBe(false);
        expect(rows[0].verified).toBe(true);
    });
});
