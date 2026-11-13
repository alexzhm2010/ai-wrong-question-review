import { describe, it, expect } from "vitest";
import { trimBlankEdge, hasInkTrace } from "@/lib/image-autocrop";

/** 造一个逐行墨水占比数组 */
function profile(rows: number[]): Float32Array {
    return Float32Array.from(rows);
}

describe("trimBlankEdge：底部/顶部空白收缩", () => {
    it("纯空白一路收到 inner", () => {
        const p = profile(new Array(50).fill(0));
        expect(trimBlankEdge(p, 49, 0, 100)).toBe(0);
    });

    it("遇到实墨立即停", () => {
        const rows = new Array(50).fill(0);
        rows[40] = 0.12;
        const p = profile(rows);
        expect(trimBlankEdge(p, 49, 0, 100)).toBe(40);
    });

    it("分数分母这类小字（稀疏墨）不能被跳过", () => {
        // v1.18.41 的 bug：底部「2/3」的分母单行墨占比只有 0.6%，
        // 旧逻辑按 1% 判定成空白 → 底边越过它 → 只剩分子
        const rows = new Array(60).fill(0);
        rows[55] = 0.006; // 分母：连续两行稀疏墨
        rows[56] = 0.006;
        const p = profile(rows);
        expect(trimBlankEdge(p, 59, 0, 100)).toBe(55);
    });

    it("单行孤立墨点当作噪点跳过", () => {
        const rows = new Array(60).fill(0);
        rows[57] = 0.006; // 只有一行，且上下都是空白
        const p = profile(rows);
        const bottom = trimBlankEdge(p, 59, 0, 100);
        expect(bottom).toBeLessThanOrEqual(56);
    });

    it("低于稀疏阈值（JPEG 噪点）不拦", () => {
        const rows = new Array(40).fill(0);
        rows[38] = 0.001; // < SPARSE_INK(0.0025)
        const p = profile(rows);
        expect(trimBlankEdge(p, 39, 0, 100)).toBeLessThanOrEqual(37);
    });

    it("顶部方向同样生效", () => {
        const rows = new Array(50).fill(0);
        rows[6] = 0.03;
        const p = profile(rows);
        expect(trimBlankEdge(p, 0, 49, 100)).toBe(6);
    });

    it("maxRows 限制收缩距离", () => {
        const p = profile(new Array(100).fill(0));
        expect(trimBlankEdge(p, 99, 0, 10)).toBe(89);
    });
});

describe("hasInkTrace：被裁区域里到底有没有内容", () => {
    it("全白区间返回 false", () => {
        expect(hasInkTrace(profile(new Array(20).fill(0)), 0, 19)).toBe(false);
    });

    it("有一行稀疏墨就算有内容", () => {
        const rows = new Array(20).fill(0);
        rows[12] = 0.006;
        expect(hasInkTrace(profile(rows), 0, 19)).toBe(true);
    });

    it("区间外的不算", () => {
        const rows = new Array(20).fill(0);
        rows[2] = 0.5;
        expect(hasInkTrace(profile(rows), 10, 19)).toBe(false);
    });
});
