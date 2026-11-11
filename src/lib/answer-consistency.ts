/**
 * 参考答案 ↔ 解析结论 一致性守卫
 *
 * 背景：AI 一次响应里 `answerText`（参考答案）与 `analysis`（解析思路）是两个
 * 独立字段，模型偶尔会给出互相矛盾的结论——例如答案写 (1/2, 2]，解析末尾
 * 却推出 [-1, 1/2)。静态版无法修改线上 Edge Function 的提示词，因此在前端做
 * 保守检测 + 用户确认后的一键修正：只提示，绝不静默覆盖。
 *
 * 设计取舍：宁可漏报也不误报。只有「解析末尾能提取到明确结论」且「参考答案
 * 里的区间表达式不在该结论里」时才判定冲突。
 */

/** 抽取形如 [-1,0)、(1/2,2] 的区间/集合表达式 */
const INTERVAL_RE = /[\[(]([^\[\]()]{1,48})[\])]/g;

/** 解析末尾的总结引导词；取最后一次出现处作为「结论区」 */
const SUMMARY_RE =
  /(?:综上(?:所述)?|因此|所以|故|最终(?:答案|结论)?|可得|由此|答案为|取值范围(?:是|为)?|则|即|m\s*∈|m\s*\\in)\s*[：:]?\s*/g;

/** 归一化数学文本，让 \frac{1}{2} 与 1/2、\cup 与 ∪ 等价 */
function normalize(s: string): string {
  return s
    .replace(/\\(?:d|t)?frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\left|\\right|\\,|\\!|\\;/g, "")
    .replace(/\\cup/g, "∪")
    .replace(/\\in/g, "∈")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
    .replace(/[，,]\s*/g, ",")
    .replace(/\s+/g, "");
}

function intervals(text: string): string[] {
  return [...text.matchAll(INTERVAL_RE)].map((m) => normalize(m[0]));
}

/** 取解析最后一段总结句（截到句号/换行，最多 240 字） */
function tailConclusion(analysis: string): string {
  const matches = [...analysis.matchAll(SUMMARY_RE)];
  if (!matches.length) return "";
  const last = matches[matches.length - 1];
  const start = (last.index ?? 0) + last[0].length;
  let tail = analysis.slice(start, start + 240);
  const stop = tail.search(/[。\n]/);
  if (stop >= 0) tail = tail.slice(0, stop);
  return tail.trim();
}

export interface AnswerConflict {
  conflict: boolean;
  /** 解析末尾的最终结论表达式，供用户一键采用 */
  suggested: string;
  /** 参考答案里提取到的表达式 */
  answerExpr: string;
  /** 解析末尾提取到的最终表达式 */
  conclusionExpr: string;
}

const NO_CONFLICT: AnswerConflict = {
  conflict: false,
  suggested: "",
  answerExpr: "",
  conclusionExpr: "",
};

export function detectAnswerConflict(
  answerText: string,
  analysis: string,
): AnswerConflict {
  if (!answerText || !analysis) return NO_CONFLICT;

  const answerExprs = intervals(answerText);
  if (!answerExprs.length) return NO_CONFLICT;

  const conclusionExprs = intervals(tailConclusion(analysis));
  if (!conclusionExprs.length) return NO_CONFLICT;

  // 答案一般只有一个主表达式，取最后一个；解析末尾可能有多个等价写法，
  // 取最后一个（通常是化简后的最终结论）。
  const answerExpr = answerExprs[answerExprs.length - 1];
  const conclusionExpr = conclusionExprs[conclusionExprs.length - 1];

  // 答案表达式出现在解析末尾结论里 → 一致，不打扰用户。
  if (conclusionExprs.includes(answerExpr)) {
    return { ...NO_CONFLICT, answerExpr, conclusionExpr };
  }

  return {
    conflict: true,
    suggested: conclusionExpr,
    answerExpr,
    conclusionExpr,
  };
}
