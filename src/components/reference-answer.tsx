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
export function toTex(input: string): string | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  // 只要文本里出现 $ 定界符，就交给 Markdown 渲染。
  // 模型常返回「(1) $…$；(2) $…$。」这种多段混排：整段塞给 KaTeX 时，KaTeX 不认 $，
  // 会把原文一字不改地吐出来（实测输出与输入完全一致），页面就显示成一堆 LaTeX 源码。
  // remark-math 本来就支持「文字 + 行内公式 + 文字」混排，这里不该抢它的活。
  if (raw.includes("$")) return null;

  // 去掉可能自带的 \[...\] 定界符，交给 katex 以纯 TeX 渲染
  const tex = raw
    .replace(/^\s*\\\[([\s\S]*)\\\]\s*$/, "$1")
    .trim();
  if (!tex) return null;
  // 含中文的叙述类答案 → 退回 markdown
  if (/[一-鿿]/.test(tex)) return null;
  // 带编号/分号/多句的答案不是「一个公式」，交给 markdown 逐段处理
  if (/[；;。]|\(\d+\)/.test(tex)) return null;
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
