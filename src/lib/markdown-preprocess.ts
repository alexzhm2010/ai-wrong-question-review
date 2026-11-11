/**
 * Markdown / LaTeX 预处理（纯函数，便于单测）
 *
 * 历史问题：AI 有时会返回字面的 `\n`（反斜杠 + n）而不是真实换行，
 * 因此旧实现先做 `.replace(/\\n/g, '\n')`。但 LaTeX 里大量命令以 `\n` 开头
 * （\notin、\neq、\nabla、\nsubseteq …），这一步会把 `\notin` 变成 `otin`，
 * 页面上就会出现 `3otin[-2,2]` 这种坏公式。
 *
 * 修复思路：把数学区（$...$ / $$...$$）整体暂存为占位符，等所有基于换行的
 * 规则跑完再原样还原；数学区之外仍保留原有换行归一化，但用 `(?![a-zA-Z])`
 * 保护没有用 $ 包裹的 LaTeX 命令。这样既保留「字面 \n 转换行」的能力，
 * 又不会破坏反斜杠命令。
 */

/** 行内公式 $...$ 与块级公式 $$...$$（块级优先，非贪婪） */
const MATH_BLOCK_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g;
const MATH_TOKEN_RE = /@@MATHBLOCK(\d+)@@/g;

/**
 * 行内公式紧贴中文/数字时补空格，否则 remark-math 可能识别不到。
 * 必须按「真实公式边界」逐个判断：旧实现用 ([^\s$])(\$[^$]+\$) 会让 [^$]+
 * 跨过两个公式之间的正文，把 `$a$ 文字 $b$` 误配成一对定界符并插入空格。
 */
function spaceTightMath(text: string): string {
    return text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, (block, offset: number, whole: string) => {
        const before = whole[offset - 1];
        const after = whole[offset + block.length];
        const tightBefore = before !== undefined && !/[\s$]/.test(before);
        const tightAfter = after !== undefined && !/[\s$]/.test(after);
        return `${tightBefore ? ' ' : ''}${block}${tightAfter ? ' ' : ''}`;
    });
}

export function preprocessMarkdown(content: string): string {
    if (!content) return '';

    // ① 先修正公式定界符间距（此时公式还是原文）
    let text = spaceTightMath(content);

    // ② 暂存数学区：占位符不含反斜杠与换行，后续规则无法伤及其中内容
    const mathBlocks: string[] = [];
    text = text.replace(MATH_BLOCK_RE, (block) => {
        mathBlocks.push(block);
        return `@@MATHBLOCK${mathBlocks.length - 1}@@`;
    });

    // ③ 原有段落归一化；字面 \n 仅在后面不是字母时才转成换行
    text = text
        .replace(/\\n(?![a-zA-Z])/g, '\n')
        .replace(/\n\n/g, '\n\n###PRESERVE_BREAK###\n\n')
        .replace(/([。！？；])\n(?!\n)/g, '$1\n\n')   // 中文标点后单换行 → 分段
        .replace(/([.!?;])\s*\n(?!\n)/g, '$1\n\n')    // 英文标点后单换行 → 分段
        .replace(/(\d+\))\s*\n(?!\n)/g, '$1\n\n')     // (1) (2) 编号项
        .replace(/([\u2460-\u2473])\s*\n(?!\n)/g, '$1\n\n') // ①②③
        .replace(/\n\s+([\u2460-\u2473])/g, '\n$1')   // 去缩进，避免误判代码块
        .replace(/\n\s+(\d+\))/g, '\n$1')
        .replace(/\s*###PRESERVE_BREAK###\s*/g, '\n\n');

    // ④ 还原数学区：所有基于换行的规则已执行完，公式原样落回
    return text.replace(MATH_TOKEN_RE, (_match, index) => mathBlocks[Number(index)] ?? '');
}
