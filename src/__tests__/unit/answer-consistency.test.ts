import { describe, it, expect } from "vitest";
import { detectAnswerConflict, intervals, answersEquivalent } from "@/lib/answer-consistency";

describe("区间归一化（全角括号 / Unicode 减号 / ½ 符号）", () => {
    it("全角括号打头的区间也能被提取", () => {
        expect(intervals("（−½, ½]")).toEqual(["(-1/2,1/2]"]);
    });

    it("½ 与 1/2、− 与 - 视为等价（模型常见写法差异）", () => {
        expect(answersEquivalent("（−½, ½]", "(-1/2, 1/2]")).toBe(true);
    });

    it("不同区间不因归一化被误判为等价", () => {
        expect(answersEquivalent("（−½, ½]", "[1/2, 2]")).toBe(false);
    });
});

describe("detectAnswerConflict", () => {
    it("抓到「参考答案 (1/2,2] 与解析结论 [-1,1/2) 矛盾」这一真实案例", () => {
        const r = detectAnswerConflict(
            "$m \\in (\\frac{1}{2}, 2]$",
            "四、分情况讨论并取并集。综上，由 $m \\in [-1,0) \\cup [0,\\frac{1}{2})$，即 $m \\in [-1,\\frac{1}{2})$。",
        );
        expect(r.conflict).toBe(true);
        expect(r.answerExpr).toBe("(1/2,2]");
        expect(r.conclusionExpr).toBe("[-1,1/2)");
        expect(r.suggested).toBe("[-1,1/2)");
    });

    it("答案与解析结论一致时不报警", () => {
        const r = detectAnswerConflict("m ∈ [-1, 1/2)", "综上，m ∈ [-1, 1/2)。");
        expect(r.conflict).toBe(false);
    });

    it("LaTeX 与纯文本等价写法视为一致", () => {
        const r = detectAnswerConflict(
            "m \\in [\\frac{1}{2}, 2]",
            "综上，m \\in [\\frac{1}{2}, 2]。",
        );
        expect(r.conflict).toBe(false);
    });

    it("答案不含区间表达式时保守跳过", () => {
        expect(detectAnswerConflict("选 A", "因为 A 正确，所以选 A。").conflict).toBe(false);
    });

    it("解析里没有总结句时保守跳过，避免把中间步骤误判成结论", () => {
        const r = detectAnswerConflict(
            "(1/2, 2]",
            "先求定义域 [-2,2]，再讨论 m≥0 与 m<0 两种情形。",
        );
        expect(r.conflict).toBe(false);
    });

    it("空内容不报错", () => {
        expect(detectAnswerConflict("", "").conflict).toBe(false);
    });
});
