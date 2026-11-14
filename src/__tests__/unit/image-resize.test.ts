/**
 * 图片压缩尺寸回归测试。
 *
 * 背景：compressImage 旧实现只判断 `width > maxWidth`，竖版整页拍题图
 * （2108×2207、2136×3034）宽度不到 2400 就完全不缩，6.5M 像素原样送进模型，
 * 从第 4 张开始把批量解析拖到超时。这里锁住「最长边 + 总像素」双限制。
 */
import { describe, it, expect } from "vitest";
import { fitImageSize, DRAFT_IMAGE_LIMITS } from "@/lib/image-utils";

const EDGE = 2400;
const PIXELS = 4_000_000;

describe("fitImageSize：最长边 + 总像素双限制", () => {
    it("横版大图按最长边缩放，保持宽高比", () => {
        const r = fitImageSize(3000, 2000, EDGE, PIXELS);
        expect(r.width).toBe(2400);
        expect(r.height).toBe(1600);
        expect(r.width * r.height).toBeLessThanOrEqual(PIXELS);
    });

    it("竖版整页图宽度没超标，也必须按总像素缩（旧 bug）", () => {
        const r = fitImageSize(2136, 3034, EDGE, PIXELS);
        expect(r.width).toBeLessThan(2136);
        expect(r.height).toBeLessThan(3034);
        expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(EDGE);
        expect(r.width * r.height).toBeLessThanOrEqual(PIXELS * 1.01);
        // 等比：宽高比不能变
        expect(r.width / r.height).toBeCloseTo(2136 / 3034, 2);
    });

    it("接近正方形的大图同样被总像素约束", () => {
        const r = fitImageSize(2108, 2207, EDGE, PIXELS);
        expect(r.width * r.height).toBeLessThanOrEqual(PIXELS * 1.01);
        expect(r.width / r.height).toBeCloseTo(2108 / 2207, 2);
    });

    it("小图不放大", () => {
        expect(fitImageSize(800, 600, EDGE, PIXELS)).toMatchObject({ width: 800, height: 600, scale: 1 });
    });

    it("A4 @200dpi 整页（1654×2339）恰好不受影响，打印清晰度保留", () => {
        const r = fitImageSize(1654, 2339, EDGE, PIXELS);
        expect(r.width).toBe(1654);
        expect(r.height).toBe(2339);
    });

    it("极端长条图按更严的那个约束缩", () => {
        const r = fitImageSize(1000, 10000, EDGE, PIXELS);
        expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(EDGE);
        expect(r.width * r.height).toBeLessThanOrEqual(PIXELS * 1.01);
    });

    it("v1.19.9：批量草稿收紧到 1600 长边 / 150 万像素 / q82", () => {
        expect(DRAFT_IMAGE_LIMITS).toMatchObject({ maxWidth: 1600, maxPixels: 1_500_000, quality: 0.82 });
        const r = fitImageSize(
            2136, 3034, DRAFT_IMAGE_LIMITS.maxWidth, DRAFT_IMAGE_LIMITS.maxPixels,
        );
        expect(r.width * r.height).toBeLessThanOrEqual(DRAFT_IMAGE_LIMITS.maxPixels * 1.01);
        expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(DRAFT_IMAGE_LIMITS.maxWidth);
        expect(r.height).toBeLessThan(1500);
    });

    it("像素上限为 0 或负数时不产生非法尺寸", () => {
        const r = fitImageSize(100, 100, EDGE, 0);
        expect(r.width).toBeGreaterThanOrEqual(1);
        expect(r.height).toBeGreaterThanOrEqual(1);
    });
});
