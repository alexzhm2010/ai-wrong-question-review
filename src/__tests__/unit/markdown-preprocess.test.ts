import { describe, it, expect } from "vitest";
import { preprocessMarkdown } from "@/lib/markdown-preprocess";

describe("preprocessMarkdown — LaTeX 反斜杠保护", () => {
    it("修复真实案例：$3 \\notin [-2,2]$ 不再变成 3otin", () => {
        const input = "当 $m=-2$ 时，$1-m=3 \\notin [-2,2]$，超出定义域。";
        const out = preprocessMarkdown(input);
        expect(out).toContain("\\notin");
        expect(out).not.toContain("3otin");
        expect(out).toContain("$m=-2$");
    });

    it("数学区内多个 \\n 开头的命令全部保留", () => {
        const input = "由 $a \\neq b$ 且 $\\nabla f = 0$，得 $A \\nsubseteq B$。";
        const out = preprocessMarkdown(input);
        expect(out).toContain("\\neq");
        expect(out).toContain("\\nabla");
        expect(out).toContain("\\nsubseteq");
    });

    it("未用 $ 包裹的裸 LaTeX 命令也被保护", () => {
        const out = preprocessMarkdown("因为 3 \\notin [-2,2]，所以不合法。");
        expect(out).toContain("\\notin");
        expect(out).not.toContain("otin[-2,2]");
    });

    it("\\frac 等其它命令不受影响", () => {
        const out = preprocessMarkdown("综上，$m \\in [-1, \\frac{1}{2})$。");
        expect(out).toContain("\\frac{1}{2}");
        expect(out).toContain("[-1, \\frac{1}{2})");
    });

    it("相邻两个公式之间的正文不被误当成公式边界", () => {
        const out = preprocessMarkdown("当 $m=-2$ 时，$1-m=3 \\notin [-2,2]$，超出定义域。");
        expect(out).toContain("$m=-2$");
        expect(out).toContain("$1-m=3 \\notin [-2,2]$");
    });
});

describe("preprocessMarkdown — 原有换行归一化回归", () => {
    it("AI 返回的字面 \\n 仍转成真实换行", () => {
        const out = preprocessMarkdown("第一步。\\n第二步。");
        expect(out).toContain("\n");
        expect(out).not.toContain("\\n");
    });

    it("字面 \\n 后接中文也转成换行", () => {
        const out = preprocessMarkdown("前提成立\\n故结论成立");
        expect(out).toContain("前提成立\n故结论成立");
    });

    it("中文句号后的单换行仍扩展为段落分隔", () => {
        const out = preprocessMarkdown("第一步完成。\n第二步开始。");
        expect(out).toContain("第一步完成。\n\n第二步开始。");
    });

    it("行内公式紧贴中文时仍补空格", () => {
        const out = preprocessMarkdown("当$m=-1$时成立");
        expect(out).toBe("当 $m=-1$ 时成立");
    });

    it("块级公式里的换行不被段落规则破坏", () => {
        const input = "推导如下：\n\n$$\na^2+b^2=c^2\n$$\n\n证毕。";
        const out = preprocessMarkdown(input);
        expect(out).toContain("$$\na^2+b^2=c^2\n$$");
        expect(out).toContain("证毕。");
    });

    it("空内容安全返回", () => {
        expect(preprocessMarkdown("")).toBe("");
    });
});
