import { remark } from 'remark';
import stripMarkdown from 'strip-markdown';

/**
 * 必须在 remark 之前替换的符号。
 *
 * remark 把反斜杠当转义符：`\neq0` 会先变成 `neq0`，再变成「xeq0」这种天书。
 * 所以这些命令要在 markdown 解析前就落成 Unicode 符号。
 */
const LATEX_SYMBOLS: Record<string, string> = {
    neq: "≠", leq: "≤", le: "≤", geq: "≥", ge: "≥",
    leqslant: "≤", geqslant: "≥",
    times: "×", div: "÷", cdot: "·", pm: "±",
    approx: "≈", infty: "∞", circ: "°",
    triangle: "△", angle: "∠", because: "∵", therefore: "∴",
    pi: "π", alpha: "α", beta: "β", theta: "θ", lambda: "λ", mu: "μ",
};

/** 0-9 上标字符：把 `x^2` 变成 `x²`，纯文本摘要里可读性差别很大 */
const SUPERSCRIPT: Record<string, string> = {
    "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
    "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

/**
 * Clean markdown content to plain text.
 * Note: This function is synchronous and uses remark.processSync.
 */
export function cleanMarkdown(content: string): string {
    if (!content) return "";

    try {
        // 1. First, handle custom LaTeX-like escape sequences that remark might not catch or handle as we want
        // Specifically, handle escaped underscores manually before markdown stripping
        // because we want "\_" to become "_" (plain text underscore), not removed entirely
        let text = content.replace(/\\_/g, '_');

        // 先把 \neq / \leqslant 这类命令落成符号，否则会被 remark 的转义规则吃掉反斜杠
        text = text.replace(
            /\\(neq|leqslant|geqslant|leq|geq|le|ge|times|div|cdot|pm|approx|infty|circ|triangle|angle|because|therefore|pi|alpha|beta|theta|lambda|mu)(?![a-zA-Z])/g,
            (m, k: string) => LATEX_SYMBOLS[k] || m,
        );

        // 2. Use remark to strip markdown formatting
        // strip-markdown 的类型与 remark 版本对不上，这里只借用它的运行时行为
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const file = remark().use(stripMarkdown as any).processSync(text);
        text = String(file);

        // 3. Post-processing: specific cleanups for this app
        // Remove common LaTeX commands that might remain as plain text
        text = text
            // Layout commands
            .replace(/\\left/g, '')
            .replace(/\\right/g, '')
            .replace(/\\begin\{.*?\}/g, '')
            .replace(/\\end\{.*?\}/g, '')
            .replace(/\\text\{.*?\}/g, '')
            .replace(/\\mbox\{.*?\}/g, '')
            // Math structures (Simple recursive patterns are not supported in JS regex, so we handle basic cases)
            /**
             * 先拆掉上标/下标的嵌套花括号（x^{2} → x^2）。
             * 必须在分数之前做：`\dfrac{1}{x^{2}}` 的第二段含花括号，
             * 直接拿 [^{}]+ 去匹配会失败，页面就会显示「dfrac{1}{x²}」。
             */
            .replace(/\^\{([^{}]+)\}/g, '^$1')
            .replace(/_\{([^{}]+)\}/g, '_$1')
            /**
             * 分数与根号。反斜杠写成可选：
             * remark 会把 `\dfrac` 当成转义序列吃掉反斜杠，到这里已经是 `dfrac`，
             * 只认 `\frac` 就会漏掉，卡片上直接显示「dfrac{ax}{ax+b}」。
             */
            .replace(/\\?[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)')
            .replace(/\\?sqrt\s*\{([^{}]+)\}/g, '√($1)')
            // x^2 读起来费劲，一位数上标直接转成 ²
            .replace(/\^(\d)/g, (m, d) => SUPERSCRIPT[d] || m)
            // Symbols map（\leqslant 要排在 \le 前面，否则会剩下一个 "qslant"）
            .replace(/\\leqslant/g, '≤')
            .replace(/\\geqslant/g, '≥')
            .replace(/\\times/g, '×')
            .replace(/\\div/g, '÷')
            .replace(/\\cdot/g, '·')
            .replace(/\\le/g, '≤')
            .replace(/\\ge/g, '≥')
            .replace(/\\neq/g, '≠')
            .replace(/\\approx/g, '≈')
            .replace(/\\pm/g, '±')
            .replace(/\\infty/g, '∞')
            .replace(/\\circ/g, '°')
            .replace(/\\triangle/g, '△')
            .replace(/\\angle/g, '∠')
            .replace(/\\because/g, '∵')
            .replace(/\\therefore/g, '∴')
            // Explicitly remove math delimiters ($)
            .replace(/\$/g, '')
            // Cleanup remaining backslashes
            .replace(/\\/g, '')
            .trim();

        return text;
    } catch (error) {
        console.error("Failed to strip markdown:", error);
        // Fallback to original content if stripping fails
        return content;
    }
}
