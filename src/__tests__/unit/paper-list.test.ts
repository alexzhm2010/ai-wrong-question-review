import { describe, it, expect } from "vitest";
import { paperStatus, markHref, formatPaperTime, parseScannedCode } from "@/lib/paper-list";

describe("paperStatus：批改中心试卷状态", () => {
    it("未提交 → 待批改", () => {
        expect(paperStatus({ score: null, correctCount: null, itemCount: 12 })).toEqual({
            label: "待批改",
            tone: "pending",
            detail: "12 题 · 做完扫码批改",
        });
    });

    it("已提交 → 显示分数与答对数", () => {
        expect(paperStatus({ score: 83, correctCount: 10, itemCount: 12 })).toEqual({
            label: "83 分",
            tone: "done",
            detail: "答对 10/12 题",
        });
    });

    it("0 分也算已批改（不能用真值判断 score）", () => {
        const s = paperStatus({ score: 0, correctCount: 0, itemCount: 8 });
        expect(s.tone).toBe("done");
        expect(s.label).toBe("0 分");
    });

    it("correctCount 缺失时兜底为 0", () => {
        const s = paperStatus({ score: 50, correctCount: null, itemCount: 6 });
        expect(s.detail).toBe("答对 0/6 题");
    });
});

describe("markHref：进入批改页地址", () => {
    it("带凭证 code 并做 URL 编码", () => {
        expect(markHref("261116ABCdef")).toBe("/mark?c=261116ABCdef");
    });

    it("特殊字符被编码，避免破坏 query", () => {
        expect(markHref("a b&c")).toBe("/mark?c=a%20b%26c");
    });
});

describe("parseScannedCode：从二维码内容解析试卷编号", () => {
    it("完整网址（含 basePath）取 ?c=", () => {
        expect(
            parseScannedCode(
                "https://example.github.io/ai-wrong-question-review/mark?c=261116ABC123",
            ),
        ).toBe("261116ABC123");
    });

    it("凭证含编码字符时被正确解码", () => {
        expect(
            parseScannedCode(
                "https://x.io/ai-wrong-question-review/mark?c=a%20b%26c",
            ),
        ).toBe("a b&c");
    });

    it("相对链接形式也能解析", () => {
        expect(parseScannedCode("/ai-wrong-question-review/mark?c=CODE9")).toBe("CODE9");
        expect(parseScannedCode("/mark?c=CODE8")).toBe("CODE8");
    });

    it("纯 code（二维码直接存的编号）原样返回", () => {
        expect(parseScannedCode("261116ABC123")).toBe("261116ABC123");
    });

    it("无关网址、空串、垃圾内容返回空", () => {
        expect(parseScannedCode("https://example.com/nope?x=1")).toBe("");
        expect(parseScannedCode("")).toBe("");
        expect(parseScannedCode("   ")).toBe("");
        expect(parseScannedCode("hello world")).toBe("");
    });
});

describe("formatPaperTime：列表时间", () => {
    it("正常 ISO 时间格式化为 MM-DD HH:mm", () => {
        expect(formatPaperTime("2026-11-16T10:05:00+08:00")).toBe("11-16 10:05");
    });

    it("空值与非法时间返回空串", () => {
        expect(formatPaperTime(null)).toBe("");
        expect(formatPaperTime(undefined)).toBe("");
        expect(formatPaperTime("not-a-date")).toBe("");
    });
});
