/**
 * 今日复习卷页面里的纯函数回归（2026-11-26）。
 * - loadAllErrorItems：题库 >1000 道时分页拉全量，不能只取第一页；
 * - readScheduleMap / markScheduled：安排日志的读取与刷新，支撑「未批改不连日出现」。
 */
import { describe, it, expect, vi } from "vitest";

// 页面顶层 import 了一堆 UI / api 依赖，这里按需 mock 掉，纯粹为了拿到具名导出的纯函数。
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("@/lib/storage", () => ({ imageSrc: (v: string) => v }));
vi.mock("@/components/auto-crop-image", () => ({
    AutoCropImage: () => null,
}));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => null }));
vi.mock("@/lib/paper-print", () => ({ createPaper: vi.fn() }));
vi.mock("@/lib/navigation", () => ({
    hardNavigate: vi.fn(),
    printPreviewHref: vi.fn(() => "#"),
}));

import { loadAllErrorItems, readScheduleMap, markScheduled } from "@/app/review/page";

const mkItem = (id: string) => ({ id } as any);
const page = (nums: number[], total: number) => ({
    items: nums.map(mkItem),
    total,
    page: 1,
    pageSize: 1000,
    totalPages: Math.ceil(total / 1000),
});

describe("loadAllErrorItems", () => {
    it("只有一页时取回第一页即可", async () => {
        const getPage = vi.fn(async () => page(["1", "2", "3"], 3));
        const all = await loadAllErrorItems(getPage);
        expect(all.map((x) => x.id)).toEqual(["1", "2", "3"]);
        expect(getPage).toHaveBeenCalledTimes(1);
    });

    it("题库超 1000 道时并发补齐所有页，不漏题", async () => {
        const getPage = vi.fn(async (p: number) => {
            if (p === 1) return page(Array.from({ length: 1000 }, (_, i) => `p1-${i}`), 2300);
            if (p === 2) return page(Array.from({ length: 1000 }, (_, i) => `p2-${i}`), 2300);
            return page(Array.from({ length: 300 }, (_, i) => `p3-${i}`), 2300);
        });
        const all = await loadAllErrorItems(getPage);
        expect(all).toHaveLength(2300);
        expect(all[0].id).toBe("p1-0");
        expect(all[1000].id).toBe("p2-0");
        expect(all[2000].id).toBe("p3-0");
        expect(getPage).toHaveBeenCalledTimes(3);
    });
});

describe("安排日志 readScheduleMap / markScheduled", () => {
    it("坏数据 / 缺字段都退化为空 map", () => {
        expect(readScheduleMap(null).size).toBe(0);
        expect(readScheduleMap("not json").size).toBe(0);
        expect(readScheduleMap('["a","b"]').size).toBe(0);
        expect(readScheduleMap('{"a":"oops","b":123}').size).toBe(1);
    });

    it("markScheduled 刷新指定 id 的时间，保留其它记录且不改原 map", () => {
        const prev = new Map([["x", 100], ["old", 50]]);
        const next = markScheduled(prev, ["x", "new"], 999);
        expect(next.get("x")).toBe(999);
        expect(next.get("new")).toBe(999);
        expect(next.get("old")).toBe(50);
        expect(prev.get("x")).toBe(100); // 原 map 不变
    });

    it("序列化后能原样读回（localStorage 往返）", () => {
        const map = markScheduled(new Map(), ["a", "b"], 12345);
        const restored = readScheduleMap(JSON.stringify(Object.fromEntries(map)));
        expect(restored.get("a")).toBe(12345);
        expect(restored.get("b")).toBe(12345);
    });
});
