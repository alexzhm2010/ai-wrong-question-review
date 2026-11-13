import { describe, expect, it } from "vitest";
import { planStrips } from "@/lib/scan-split";

/** 构造 rowInk：默认每行 0.3 墨水，指定的 [start,end] 区间改成空白 */
function mk(n: number, gaps: Array<[number, number]>, ink = 0.3): Float32Array {
    const arr = new Float32Array(n).fill(ink);
    for (const [a, b] of gaps) {
        for (let y = a; y <= b; y++) arr[y] = 0;
    }
    return arr;
}

describe("planStrips", () => {
    it("没有空白带且内容密集时不切", () => {
        const plan = planStrips(mk(600, []), 0, 599);
        expect(plan).toHaveLength(1);
        expect(plan[0]).toEqual({ y0: 0, y1: 599 });
    });

    it("一条空白带在正中时切成两段，切缝落在空白带里", () => {
        const plan = planStrips(mk(600, [[292, 308]]), 0, 599);
        expect(plan).toHaveLength(2);
        expect(plan[0].y1).toBeGreaterThanOrEqual(292);
        expect(plan[0].y1).toBeLessThanOrEqual(308);
        expect(plan[0].y0).toBe(0);
        expect(plan[1].y1).toBe(599);
    });

    it("多条空白带时最多切 4 段，且段与段连续不重叠（重叠由调用方加）", () => {
        const plan = planStrips(mk(600, [[142, 158], [292, 308], [442, 458]]), 0, 599);
        expect(plan.length).toBeLessThanOrEqual(4);
        expect(plan.length).toBeGreaterThan(1);
        for (let i = 1; i < plan.length; i++) {
            expect(plan[i].y0).toBe(plan[i - 1].y1 + 1);
        }
        expect(plan[0].y0).toBe(0);
        expect(plan[plan.length - 1].y1).toBe(599);
    });

    it("太矮的内容不切（半页以内只有一两道题）", () => {
        const plan = planStrips(mk(100, [[45, 55]]), 0, 99);
        expect(plan).toHaveLength(1);
    });

    it("maxStrips=1 时保持整段", () => {
        const plan = planStrips(mk(600, [[292, 308]]), 0, 599, { maxStrips: 1 });
        expect(plan).toHaveLength(1);
    });

    it("空白带只有 1 行时不被当作切缝，退到最安静的行", () => {
        const ink = mk(600, []);
        ink[300] = 0.03;
        const plan = planStrips(ink, 0, 599, { quietRunMin: 2, denseInk: 0.05 });
        expect(plan.length).toBeGreaterThan(1);
    });

    it("越界的边界输入返回单个合法区间", () => {
        expect(planStrips(mk(10, []), 5, 4)).toEqual([]);
        expect(planStrips(mk(600, []), 0, 599, { maxStrips: 0 })).toHaveLength(1);
    });
});
