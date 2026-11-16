import { describe, it, expect } from "vitest";
import { scoreMood } from "@/lib/paper-score";

describe("scoreMood：扫码批改打分文案", () => {
    it("90 分及以上 → 太棒了，great 氛围", () => {
        expect(scoreMood(100).tone).toBe("great");
        expect(scoreMood(90).tone).toBe("great");
        expect(scoreMood(95).title).toContain("太棒");
    });

    it("60–89 分 → 很不错哦，good 氛围", () => {
        expect(scoreMood(89).tone).toBe("good");
        expect(scoreMood(60).tone).toBe("good");
        expect(scoreMood(75).title).toContain("很不错");
    });

    it("60 分以下 → 掌握还不足，keep 氛围（不出撒花）", () => {
        expect(scoreMood(59).tone).toBe("keep");
        expect(scoreMood(0).title).toContain("掌握还不足");
    });

    it("边界值连续无空隙", () => {
        expect(scoreMood(89).tone).toBe("good");
        expect(scoreMood(90).tone).toBe("great");
        expect(scoreMood(59).tone).toBe("keep");
        expect(scoreMood(60).tone).toBe("good");
    });
});
