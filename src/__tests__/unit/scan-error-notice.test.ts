import { describe, it, expect } from "vitest";
import { scanErrorNotice } from "@/lib/scan-error-notice";

describe("scanErrorNotice：拍照批改提示条文案/配色", () => {
    it("首轮报错但有复核补全的可用结果时，降级为中性提示，不报红", () => {
        const n = scanErrorNotice("API Error: 500", "", 2);
        expect(n?.red).toBe(false);
        expect(n?.text).toContain("已逐题复核补全 2 道");
        expect(n?.text).toContain("结果可正常使用");
    });

    it("首轮报错且没有任何可用结果时，保留红色错误", () => {
        const n = scanErrorNotice("API Error: 500", "", 0);
        expect(n?.red).toBe(true);
        expect(n?.text).toBe("API Error: 500");
    });

    it("无错误只有进度提示时，中性显示", () => {
        const n = scanErrorNotice("", "识别中 1/2 段…", 0);
        expect(n?.red).toBe(false);
        expect(n?.text).toBe("识别中 1/2 段…");
    });

    it("既有错误又有进度提示且无结果时，错误优先", () => {
        const n = scanErrorNotice("API Error: 500", "识别中 1/2 段…", 0);
        expect(n?.red).toBe(true);
        expect(n?.text).toBe("API Error: 500");
    });

    it("都没有时不显示提示条", () => {
        expect(scanErrorNotice("", "", 0)).toBeNull();
    });
});
