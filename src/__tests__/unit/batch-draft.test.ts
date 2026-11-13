import { describe, expect, it, vi, afterEach } from "vitest";
import { DRAFT_TTL_DAYS, draftDaysLeft } from "@/lib/batch-draft";

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
