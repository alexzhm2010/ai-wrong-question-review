import { describe, it, expect } from "vitest";
import {
    MAX_HISTORY,
    clampRect,
    eraseWidthRatio,
    hitHandle,
    hitRect,
    isRectUsable,
    moveRect,
    normalizeRect,
    pickPaperColor,
    popOp,
    pushOp,
    rectToPixels,
    resizeFromHandle,
    summarize,
    type EditOp,
    type Rect,
} from "@/lib/image-editor";

describe("normalizeRect：拖动起止点 → 归一化矩形", () => {
    it("正向拖", () => {
        const r = normalizeRect({ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 });
        expect(r.x).toBeCloseTo(0.1, 6);
        expect(r.y).toBeCloseTo(0.2, 6);
        expect(r.w).toBeCloseTo(0.4, 6);
        expect(r.h).toBeCloseTo(0.4, 6);
    });

    it("反向拖（从右下往左上）也要得到同样的框", () => {
        const r = normalizeRect({ x: 0.5, y: 0.6 }, { x: 0.1, y: 0.2 });
        expect(r.x).toBeCloseTo(0.1, 6);
        expect(r.y).toBeCloseTo(0.2, 6);
        expect(r.w).toBeCloseTo(0.4, 6);
        expect(r.h).toBeCloseTo(0.4, 6);
    });

    it("拖出画布外会被收进来", () => {
        const r = normalizeRect({ x: -0.2, y: -0.1 }, { x: 1.4, y: 1.3 });
        expect(r.x).toBe(0);
        expect(r.y).toBe(0);
        expect(r.w).toBeCloseTo(1, 6);
        expect(r.h).toBeCloseTo(1, 6);
    });
});

describe("clampRect：把矩形收回画布", () => {
    it("贴边超出的按边界对齐", () => {
        const r = clampRect({ x: 0.9, y: 0.95, w: 0.3, h: 0.2 });
        expect(r.x + r.w).toBeCloseTo(1, 5);
        expect(r.y + r.h).toBeCloseTo(1, 5);
    });

    it("负数尺寸被抬到最小可操作尺寸", () => {
        const r = clampRect({ x: 0.2, y: 0.2, w: -0.1, h: 0 });
        expect(r.w).toBeGreaterThanOrEqual(0.02);
        expect(r.h).toBeGreaterThanOrEqual(0.02);
    });
});

describe("rectToPixels：归一化 → 像素", () => {
    it("按比例换算并取整", () => {
        expect(rectToPixels({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, 2400, 3200)).toEqual({
            x: 1200, y: 1600, w: 600, h: 800,
        });
    });

    it("极小的框至少 1px，否则 drawImage 会报错", () => {
        const r = rectToPixels({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 2400, 3200);
        expect(r.w).toBeGreaterThanOrEqual(1);
        expect(r.h).toBeGreaterThanOrEqual(1);
    });

    it("宽高不会越过画布边界", () => {
        const r = rectToPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1000, 1000);
        expect(r.x + r.w).toBeLessThanOrEqual(1000);
        expect(r.y + r.h).toBeLessThanOrEqual(1000);
    });
});

describe("isRectUsable：误触过滤", () => {
    it("点一下（无位移）不算框选", () => {
        expect(isRectUsable({ x: 0.3, y: 0.3, w: 0, h: 0 })).toBe(false);
    });

    it("指甲盖大小的框也不收", () => {
        expect(isRectUsable({ x: 0.3, y: 0.3, w: 0.01, h: 0.01 })).toBe(false);
    });

    it("正常框选通过", () => {
        expect(isRectUsable({ x: 0.3, y: 0.3, w: 0.3, h: 0.2 })).toBe(true);
    });
});

describe("resizeFromHandle：四角等比缩放", () => {
    const rect: Rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.2 }; // 宽高比 2

    it("拖右下角：对角（左上）固定不动", () => {
        const r = resizeFromHandle(rect, "se", { x: 0.8, y: 0.6 });
        expect(r.x).toBeCloseTo(0.2, 5);
        expect(r.y).toBeCloseTo(0.2, 5);
        expect(r.w / r.h).toBeCloseTo(2, 3);
    });

    it("拖左上角：对角（右下）固定不动", () => {
        const r = resizeFromHandle(rect, "nw", { x: 0.1, y: 0.1 });
        expect(r.x + r.w).toBeCloseTo(0.6, 3);
        expect(r.y + r.h).toBeCloseTo(0.4, 3);
        expect(r.w / r.h).toBeCloseTo(2, 3);
    });

    it("纵向拉得比横向多时，以纵向为准（跟手）", () => {
        // 只往下拉，宽度也要跟着变，否则用户会觉得「拉不动」
        const r = resizeFromHandle(rect, "se", { x: 0.21, y: 0.9 });
        expect(r.w).toBeGreaterThan(0.4);
        expect(r.w / r.h).toBeCloseTo(2, 3);
    });

    it("缩到极小也不会变成 0 尺寸", () => {
        const r = resizeFromHandle(rect, "se", { x: 0.2, y: 0.2 });
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
    });
});

describe("命中判断", () => {
    const r: Rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.3 };

    it("框内按下 = 移动", () => {
        expect(hitRect(r, { x: 0.3, y: 0.3 })).toBe(true);
        expect(hitRect(r, { x: 0.1, y: 0.3 })).toBe(false);
    });

    it("四角 3% 容差内算抓手柄", () => {
        expect(hitHandle(r, { x: 0.21, y: 0.21 })).toBe("nw");
        expect(hitHandle(r, { x: 0.61, y: 0.51 })).toBe("se");
        expect(hitHandle(r, { x: 0.4, y: 0.4 })).toBeNull();
    });
});

describe("moveRect：平移不出界", () => {
    it("向右下移动会被画布边界挡住", () => {
        const r = moveRect({ x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, 0.5, 0.5);
        expect(r.x).toBeCloseTo(0.7, 5);
        expect(r.y).toBeCloseTo(0.7, 5);
    });
});

describe("pickPaperColor：抹除颜色要取纸面而不是纯白", () => {
    /** 造一片灰纸（#e6e4df）中间夹一笔黑墨 */
    function paperWithInk(): number[] {
        const out: number[] = [];
        for (let i = 0; i < 100; i++) {
            if (i >= 40 && i < 50) out.push(20, 20, 20, 255);
            else out.push(230, 228, 223, 255);
        }
        return out;
    }

    it("忽略墨迹，返回纸面色", () => {
        expect(pickPaperColor(paperWithInk())).toBe("#e6e4df");
    });

    it("全透明时退回纯白", () => {
        expect(pickPaperColor(new Array(40).fill(0))).toBe("#ffffff");
    });

    it("整片都是深色（比如拍的是黑板）时不让亮度过滤把结果清空", () => {
        const dark: number[] = [];
        for (let i = 0; i < 20; i++) dark.push(60, 60, 60, 255);
        // 全被判为「墨」→ 没有候选 → 纯白，这是有意的兜底：宁可变白也别返回黑
        expect(pickPaperColor(dark)).toBe("#ffffff");
    });
});

describe("笔宽三档", () => {
    it("细 < 中 < 粗，且都在合理区间", () => {
        expect(eraseWidthRatio(0)).toBeLessThan(eraseWidthRatio(1));
        expect(eraseWidthRatio(1)).toBeLessThan(eraseWidthRatio(2));
        expect(eraseWidthRatio(2)).toBeLessThanOrEqual(0.06);
        expect(eraseWidthRatio(0)).toBeGreaterThanOrEqual(0.008);
    });
});

describe("历史栈", () => {
    const erase: EditOp = { type: "erase", size: 1, color: "#fff", points: [{ x: 0.1, y: 0.1 }] };

    it("超过上限时丢最老的，避免无限增长", () => {
        let ops: EditOp[] = [];
        for (let i = 0; i < MAX_HISTORY + 5; i++) ops = pushOp(ops, erase);
        expect(ops).toHaveLength(MAX_HISTORY);
    });

    it("撤销一次少一条", () => {
        expect(popOp(pushOp([], erase))).toHaveLength(0);
    });

    it("空栈撤销不会变成负数", () => {
        expect(popOp([])).toHaveLength(0);
    });

    it("统计笔数与块数", () => {
        const move: EditOp = {
            type: "move",
            src: { x: 0, y: 0, w: 0.2, h: 0.2 },
            dst: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
            color: "#fff",
        };
        expect(summarize([erase, erase, move])).toEqual({ erase: 2, move: 1 });
    });
});
