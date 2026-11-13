import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ensureThumb, dropThumb } from "@/lib/image-cache";

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
