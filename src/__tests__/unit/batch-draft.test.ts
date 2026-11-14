import { describe, expect, it, vi, afterEach } from "vitest";
import { DRAFT_TTL_DAYS, draftDaysLeft } from "@/lib/batch-draft";
import { DRAFT_IMAGE_LIMITS } from "@/lib/image-utils";

const { ingestSpy, postSpy } = vi.hoisted(() => ({
    ingestSpy: vi.fn(async () => ({ ref: "data:image/jpeg;base64,AA", thumb: "data:image/jpeg;base64,BB" })),
    postSpy: vi.fn(async () => ({})),
}));
vi.mock("@/lib/storage", () => ({ ingestImage: (...args: unknown[]) => ingestSpy(...args) }));
vi.mock("@/lib/api-client", () => ({
    ApiError: class ApiError extends Error {},
    apiClient: { post: (...args: unknown[]) => postSpy(...args) },
}));

describe("草稿过期", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const freeze = (iso: string) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(iso));
    };

    it("刚建的草稿还剩满额天数", () => {
        freeze("2026-11-13T12:00:00Z");
        expect(draftDaysLeft("2026-11-13T12:00:00Z")).toBe(DRAFT_TTL_DAYS);
    });

    it("过了一半时间剩一半，向上取整", () => {
        freeze("2026-11-16T12:00:00Z");
        // 3.5 天前动过 → 还剩 3.5 天 → 显示 4 天
        expect(draftDaysLeft("2026-11-13T00:00:00Z")).toBe(4);
    });

    it("超过 TTL 归零，不出现负数", () => {
        freeze("2026-12-01T12:00:00Z");
        expect(draftDaysLeft("2026-11-13T12:00:00Z")).toBe(0);
    });

    it("时间字段缺失时按满额处理，不误报已过期", () => {
        expect(draftDaysLeft(null)).toBe(DRAFT_TTL_DAYS);
        expect(draftDaysLeft("不是时间")).toBe(DRAFT_TTL_DAYS);
    });
});

describe("批量草稿上传使用收紧后的压缩规格", () => {
    it("把 1600 / 150 万像素 / q82 真正传给存储层", async () => {
        const { uploadDraftImages } = await import("@/lib/batch-draft");
        ingestSpy.mockClear();
        postSpy.mockClear();
        // ingestImage 被 mock，不会真的读文件；只需保证参数链路没断
        await uploadDraftImages("job-1", [{} as File]);
        expect(ingestSpy).toHaveBeenCalledTimes(1);
        expect(ingestSpy.mock.calls[0][1]).toMatchObject({
            role: "draft",
            ownerId: "job-1",
            maxWidth: DRAFT_IMAGE_LIMITS.maxWidth,
            maxPixels: DRAFT_IMAGE_LIMITS.maxPixels,
            quality: DRAFT_IMAGE_LIMITS.quality,
        });
        expect(postSpy).toHaveBeenCalledTimes(1);
    });
});
