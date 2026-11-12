import { describe, it, expect } from 'vitest';
import { toTex } from '@/components/reference-answer';
import { preprocessMarkdown } from '@/lib/markdown-preprocess';

describe('参考答案渲染路径', () => {
    it('多段/带编号的行内公式不再整段交给 KaTeX', () => {
        const text = '(1) $f(x)=x^2+2\\ (x\\in\\mathbb{R})$；(2) $f(x)=\\frac{2}{3}x+1$';
        expect(toTex(text)).toBeNull();
    });

    it('含中文的叙述型答案走 markdown', () => {
        expect(toTex('答案：$x=1$ 或 $x=2$')).toBeNull();
    });

    it('带分号/编号的纯公式串也走 markdown', () => {
        expect(toTex('$x=1$; $x=2$')).toBeNull();
    });

    it('真正的裸 LaTeX 仍然整段渲染', () => {
        expect(toTex('[-1, 1/2)')).toBe('[-1, 1/2)');
        expect(toTex('\\frac{1}{2}')).toBe('\\frac{1}{2}');
    });

    it('\\[...\\] 包裹时去掉定界符', () => {
        expect(toTex('\\[x^2+1\\]')).toBe('x^2+1');
    });
});

describe('LaTeX 输出兜底', () => {
    it('修正 \\xin 粘连命令', () => {
        const out = preprocessMarkdown('$f(x)=x^2+2\\ (\\xin\\mathbb{R})$');
        expect(out).toContain('x \\in');
        expect(out).not.toContain('\\xin');
    });

    it('不影响正常命令 \\xi 与 \\xrightarrow', () => {
        const out = preprocessMarkdown('$\\xi + \\xrightarrow{f}$');
        expect(out).toContain('\\xi');
        expect(out).toContain('\\xrightarrow');
    });

    it('统一 \\[ \\] 与 \\( \\) 定界符', () => {
        expect(preprocessMarkdown('\\[a+b\\]')).toContain('$$a+b$$');
        expect(preprocessMarkdown('\\(a+b\\)')).toContain('$a+b$');
    });
});
