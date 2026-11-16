import { describe, it, expect } from "vitest";
import { markUrl } from "@/components/paper-qr-code";

describe("markUrl：扫码批改二维码内容", () => {
    it("拼出线上完整地址（含 basePath 与 mark 路径）", () => {
        const url = markUrl("https://example.github.io", "261116ABC123");
        expect(url).toBe(
            "https://example.github.io/ai-wrong-question-review/mark?c=261116ABC123",
        );
    });

    it("凭证 code 做 URL 编码，避免特殊字符破坏链接", () => {
        const url = markUrl("https://x.io", "a b&c");
        expect(url).toContain("c=a%20b%26c");
    });
});
