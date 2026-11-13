import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ensureThumb, dropThumb, ensureFullImage, peekFullImage } from "@/lib/image-cache";

/**
 * 这组测试盯的是「整页翻到截图态」时最要命的两个点：
 *   1. 同一道题被并发要求取图时，只能解码一次（否则 18 张卡会互相拖死）；
 *   2. 取到的图要留在内存里，翻回文字再翻回去不能重新走一遍。
 *
 * jsdom 不加载图片、也不实现 canvas，所以这里把 Image 换成即时回调的假实现，
 * canvas 拿不到 2d context 时 makeThumb 会原样返回 src —— 对缓存逻辑没有影响。
 */

class FakeImage {
    static created = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "async";
    naturalWidth = 1200;
    naturalHeight = 1600;
    constructor() {
        FakeImage.created++;
    }
    set src(_v: string) {
        setTimeout(() => this.onload?.(), 0);
    }
}

describe("缩略图缓存", () => {
    beforeEach(() => {
        vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("同一道题并发取图只调用一次 fetcher", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "data:image/jpeg;base64,AAA" }));

        const [a, b, c] = await Promise.all([
            ensureThumb("unit-same-id", fetcher),
            ensureThumb("unit-same-id", fetcher),
            ensureThumb("unit-same-id", fetcher),
        ]);

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(a).toBeTruthy();
        expect(b).toBe(a);
        expect(c).toBe(a);
    });

    it("第二次取图走内存缓存，不再调用 fetcher", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "data:image/jpeg;base64,BBB" }));

        await ensureThumb("unit-mem-id", fetcher);
        await ensureThumb("unit-mem-id", fetcher);

        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("换图后 dropThumb 会清掉内存缓存，重新拉取", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "data:image/jpeg;base64,CCC" }));

        await ensureThumb("unit-drop-id", fetcher);
        await dropThumb("unit-drop-id");
        await ensureThumb("unit-drop-id", fetcher);

        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("没有原图时返回 null，不会把空图塞进缓存", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "" }));

        expect(await ensureThumb("unit-none-id", fetcher)).toBeNull();
        // 没图也要允许下次重试，不能被缓存的 null 卡死
        expect(await ensureThumb("unit-none-id", fetcher)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("fetcher 抛错时返回 null，不向上冒泡", async () => {
        const fetcher = vi.fn(async () => {
            throw new Error("network");
        });

        await expect(ensureThumb("unit-err-id", fetcher)).resolves.toBeNull();
    });
});

/**
 * 放大层要的是原图。
 *
 * 卡片缩略图只有 480px，铺满手机（DPR 3 ≈ 1000+ 物理像素）必糊，
 * 这组测试保证：放大走的是原图、并发只请求一次、内存只留最近 4 张。
 */
describe("高清原图", () => {
    beforeEach(() => {
        vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("返回的是原图，而不是缩略图", async () => {
        const raw = "data:image/jpeg;base64,FULL-RES";
        const fetcher = vi.fn(async () => ({ originalImageUrl: raw }));

        await expect(ensureFullImage("full-hd-id", fetcher)).resolves.toBe(raw);
        expect(peekFullImage("full-hd-id")).toBe(raw);
    });

    it("并发放大同一道题只请求一次详情", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "data:image/jpeg;base64,ONE" }));

        const [a, b] = await Promise.all([
            ensureFullImage("full-same-id", fetcher),
            ensureFullImage("full-same-id", fetcher),
        ]);

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });

    it("第二次放大走内存，不再请求", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "data:image/jpeg;base64,MEM" }));

        await ensureFullImage("full-mem-id", fetcher);
        await ensureFullImage("full-mem-id", fetcher);

        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("内存只保留最近 4 张，最早的一张被淘汰", async () => {
        const fetcher = (n: number) => vi.fn(async () => ({ originalImageUrl: `data:image/jpeg;base64,L${n}` }));

        for (let i = 0; i < 5; i++) {
            await ensureFullImage(`full-lru-${i}`, fetcher(i));
        }

        expect(peekFullImage("full-lru-0")).toBeNull();
        expect(peekFullImage("full-lru-4")).toBe("data:image/jpeg;base64,L4");
    });

    it("没有原图时返回 null，下次仍可重试", async () => {
        const fetcher = vi.fn(async () => ({ originalImageUrl: "" }));

        expect(await ensureFullImage("full-none-id", fetcher)).toBeNull();
        expect(await ensureFullImage("full-none-id", fetcher)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(peekFullImage("full-none-id")).toBeNull();
    });

    it("dropThumb 同时清掉高清缓存（换图后不能再看旧图）", async () => {
        const raw = "data:image/jpeg;base64,OLD";
        await ensureFullImage("full-drop-id", async () => ({ originalImageUrl: raw }));
        expect(peekFullImage("full-drop-id")).toBe(raw);

        await dropThumb("full-drop-id");
        expect(peekFullImage("full-drop-id")).toBeNull();
    });
});
