"use client";

import { MarkdownRenderer } from "@/components/markdown-renderer";
import katex from "katex";

/**
 * 参考答案渲染：直接用 KaTeX 渲染整段答案，绕过 MarkdownRenderer 的 preprocessMarkdown。
 *
 * 根因：findConclusionExpr / 模型答案常返回「裸 LaTeX」（如 [-1, 1/2)），不含 $ 定界符。
 * preprocessMarkdown 只保护 $...$ 数学区，裸反斜杠命令会被当普通文本吞掉 → 显示乱码。
 * 这里整段交给 KaTeX 渲染即可正确显示。含中文的叙述类答案（无论是否夹带公式）退回
 * Markdown 渲染，因为 markdown 本就能正确处理 $...$ 内联公式。
 */
function toTex(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  // 去掉可能自带的定界符，交给 katex 以纯 TeX 渲染
  const tex = raw
    .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
    .replace(/^\$([\s\S]*)\$$/, "$1")
    .replace(/^\s*\\\[([\s\S]*)\\\]\s*$/, "$1")
    .trim();
  if (!tex) return null;
  // 含中文的叙述类答案 → 退回 markdown（保留其 $...$ 内联公式能力）
  if (/[一-鿿]/.test(tex)) return null;
  return tex;
}

export function ReferenceAnswer({ text, className = "" }: { text: string; className?: string }) {
  const tex = toTex(text);
  if (tex) {
    try {
      const html = katex.renderToString(tex, { throwOnError: false, displayMode: true });
      return (
        <div
          className={`text-lg leading-relaxed break-words ${className}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    } catch {
      /* 渲染失败退回 markdown */
    }
  }
  return <MarkdownRenderer content={text} className={className} />;
}
