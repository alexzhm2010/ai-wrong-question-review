import { describe, it, expect } from "vitest";
import { cleanMarkdown } from "@/lib/markdown-utils";

/**
 * 卡片/列表摘要用的是 cleanMarkdown 的纯文本输出。
 * 之前 `\dfrac{ax}{ax+b}` 会原样显示成「dfrac{ax}{ax+b}」——学生一眼看不懂，
 * 这正是「纯文字卡片不直观」的一部分原因。
 */
describe("cleanMarkdown：公式转可读文本", () => {
    it("\\frac 转成 (分子)/(分母)", () => {
        expect(cleanMarkdown("$\\frac{1}{2}$")).toContain("(1)/(2)");
    });

    it("\\dfrac 与 \\tfrac 同样处理", () => {
        expect(cleanMarkdown("$y=\\dfrac{ax}{ax+b}$")).toContain("(ax)/(ax+b)");
        expect(cleanMarkdown("$\\tfrac{a}{b}$")).toContain("(a)/(b)");
    });

    it("remark 吃掉反斜杠后仍能兜住（端到端）", () => {
        const out = cleanMarkdown("已知 $f(x)=\\dfrac{1}{x^2}$，求导");
        expect(out).not.toContain("dfrac");
        expect(out).toContain("(1)/(x²)");
    });

    it("根号转 √", () => {
        expect(cleanMarkdown("$\\sqrt{x+1}$")).toContain("√(x+1)");
    });

    it("一位数上标转成 ²", () => {
        expect(cleanMarkdown("$x^2+1$")).toContain("x²");
    });

    it("分母带嵌套上标时也能拆（x^{2} → x²）", () => {
        const out = cleanMarkdown("$f\\left(x-\\dfrac{1}{x}\\right)=x^{2}+\\dfrac{1}{x^{2}}$");
        expect(out).not.toContain("dfrac");
        expect(out).toContain("x²");
    });

    it("\\leqslant / \\geqslant 不留下 qslant 尾巴", () => {
        const out = cleanMarkdown("$x\\leqslant -1$ 且 $x\\geqslant 2$");
        expect(out).toContain("≤");
        expect(out).toContain("≥");
        expect(out).not.toContain("qslant");
    });

    it("普通中文题干不被误伤", () => {
        const s = "如图，在矩形 ABCD 中，AB=3，求 BC 的长。";
        expect(cleanMarkdown(s)).toBe(s);
    });

    it("空输入返回空串", () => {
        expect(cleanMarkdown("")).toBe("");
    });
});
