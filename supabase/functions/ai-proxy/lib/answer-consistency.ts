/**
 * 参考答案 ↔ 解析结论 一致性守卫（前端 + Edge Function 同源副本）
 *
 * 根因记录（v1.18.3）：此前让 AI 把最终答案写两遍——<analysis> 正文推导一次、
 * 末尾 <final_answer> 再独立写一次，服务端又无条件采信后者覆盖参考答案。模型
 * 只要在第二次输出时抄错端点或开闭，参考答案就会与解析正文矛盾；两次事故
 * (1/2,2] 与 (-½,½] 同源。提示词纪律是软约束（enableThinking 下模型照样把
 * 「但需注意」「然而，还需验证」写进正文），前端「只看最后一句」的守卫在末尾
 * 是文字结论时也会漏报。
 *
 * 现在的结构：以「解析正文里确定性推出的结论」为唯一真相源。
 *  - findConclusionExpr：全文扫描结论语境提取最终表达式，不依赖最后一句；
 *  - deriveAnswerFromAnalysis（服务端）：三方交叉校验，不一致时以解析结论为准；
 *  - detectAnswerConflict（前端）：对历史数据 / 旧函数结果做兜底提示。
 *
 * 安全边界：只在「参考答案本身是区间表达式」且「解析里能高置信提取到结论区间」
 * 时才覆盖。选择题、数值、文字结论等非区间答案一律不动，避免误改。
 */

/** 抽取形如 [-1,0)、(1/2,2] 的区间/集合表达式 */
const INTERVAL_RE = /[\[(]([^\[\]()]{1,48})[\])]/g;

/** 强结论语境：综上/因此/所以/故/得/取值范围/最终答案… 后紧邻区间 */
const STRONG_CONCLUSION_RE =
  /(?:综上(?:所述)?|因此|所以|故|可得|由此|得|取值范围(?:是|为)?|最终(?:答案|结论)|答案为|答案是)\s*[：:]?\s*(?:m\s*(?:∈|\\in)\s*)?([\[(][^\[\]()]{1,48}[\])])/g;

/** 弱结论语境：m ∈ 区间（无引导词，作为兜底） */
const VAR_CONCLUSION_RE =
  /\bm\s*(?:∈|\\in)\s*[：:]?\s*([\[(][^\[\]()]{1,48}[\])])/g;

/** 解析末尾的总结引导词；仅作为最后兜底（旧逻辑保留，避免行为倒退） */
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

/**
 * 从解析全文确定性提取「最终结论表达式」，返回原文片段（保留 LaTeX）。
 *
 * 与旧 tailConclusion 的区别：不看最后一句，而是全文找「结论语境 + 区间」，
 * 取最后一次命中。这样即使解析末尾补了端点验证、边界说明等文字（如
 * 「所以 m=-1 满足条件」），也能稳定提取到第三步写下的 [-1, 1/2)。
 *
 * 刻意要求引导词与区间紧邻（中间只允许 m∈），因此「因此，在 x≤0 时 …
 * g(x) 在 [-2,0] 上单调递增」「由于 g 在 [0,2] 递减」这类前提/性质区间
 * 不会被误当成结论。
 */
export function findConclusionExpr(analysis: string): string {
  if (!analysis) return "";
  const flat = analysis
    .replace(/<final_answer>[\s\S]*?<\/final_answer>/gi, " ")
    .replace(/\\left|\\right/g, "")
    .replace(/\$/g, " ");
  const strong = [...flat.matchAll(STRONG_CONCLUSION_RE)];
  if (strong.length) return strong[strong.length - 1][1].trim();
  const weak = [...flat.matchAll(VAR_CONCLUSION_RE)];
  if (weak.length) return weak[weak.length - 1][1].trim();
  return "";
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

/**
 * 前端兜底守卫。conclusionExprOverride 可传入服务端已经确定性提取好的结论，
 * 避免前端重复解析；不传时自行全文提取，再退回旧的末尾总结句。
 */
export function detectAnswerConflict(
  answerText: string,
  analysis: string,
  conclusionExprOverride?: string,
): AnswerConflict {
  if (!answerText || !analysis) return NO_CONFLICT;

  const answerExprs = intervals(answerText);
  if (!answerExprs.length) return NO_CONFLICT;

  const conclusionRaw =
    conclusionExprOverride || findConclusionExpr(analysis) || tailConclusion(analysis);
  const conclusionExprs = intervals(conclusionRaw);
  if (!conclusionExprs.length) return NO_CONFLICT;

  const answerExpr = answerExprs[answerExprs.length - 1];
  const conclusionExpr = conclusionExprs[conclusionExprs.length - 1];

  // 答案表达式出现在解析结论里 → 一致，不打扰用户。
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

export interface DerivedAnswer {
  /** 最终写入参考答案字段的文本 */
  answerText: string;
  /** 从解析正文确定性提取到的结论（无则为空） */
  derived: string;
  /** 模型答案与解析结论是否冲突 */
  conflict: boolean;
  /** analysis = 已按解析结论校正；model = 采用模型原答案 */
  source: "analysis" | "model";
  /** 冲突被校正时，保留模型原答案供前端展示 */
  originalAnswerText?: string;
}

/**
 * 服务端单一真相源：以解析正文推导出的结论为准，交叉校验 AI 的两次答案输出。
 *
 * 只在「模型答案本身是区间」且「解析里能提取到结论区间」时才会覆盖；
 * 其余情况一律原样返回，宁可漏改也不误改。
 */
export function deriveAnswerFromAnalysis(
  rawAnalysis: string,
  rawAnswer: string,
  finalAnswer: string,
): DerivedAnswer {
  const modelAnswer = (finalAnswer || rawAnswer || "").trim();
  const derived = findConclusionExpr(rawAnalysis);
  const modelExprs = intervals(modelAnswer);

  if (!derived || !modelExprs.length) {
    return { answerText: modelAnswer, derived: "", conflict: false, source: "model" };
  }

  const nDerived = normalize(derived);
  const nModel = normalize(modelAnswer);
  const agree =
    nModel === nDerived || nModel.includes(nDerived) || modelExprs.includes(nDerived);

  if (agree) {
    return { answerText: modelAnswer, derived, conflict: false, source: "model" };
  }

  // 覆盖时保留模型答案的 $ 定界符：解析正文里的表达式是裸的，
  // 若模型原本用 $...$ 包裹，直接替换会让前端 KaTeX 不再渲染。
  const corrected = modelAnswer.includes("$") ? `$${derived}$` : derived;

  return {
    answerText: corrected,
    derived,
    conflict: true,
    source: "analysis",
    originalAnswerText: modelAnswer,
  };
}

// ---------------------------------------------------------------------------
// 双模型交叉校验（方案 B）：两个不同厂商模型并行解题，结果互校，
// 不一致时转人工复核，不自动裁判。
// ---------------------------------------------------------------------------

export interface ModelVerdict {
  /** 是否启用了第二模型（未配密钥则单模型模式） */
  enabled: boolean;
  /** 两模型最终答案是否一致 */
  agree: boolean;
  /** 不一致 → 转人工复核 */
  needsReview: boolean;
  /** high=双模型一致 / low=分歧 / single=仅单模型 */
  confidence: "high" | "low" | "single";
  /** 主模型最终答案（已按自身解析校正） */
  primaryAnswer: string;
  /** 第二模型最终答案（已按自身解析校正），未启用为空 */
  secondaryAnswer: string;
  primaryModel: string;
  secondaryModel: string;
  note?: string;
}

/** 两个答案是否等价：区间集合精确相等，或非区间文本归一化后相等。
 *  故意不做「子集/超集」容错——交叉校验的目标是抓分歧，把仅写出定义域
 *  （如 [-1,2]）误判为与 [-1,1/2) 一致会掩盖真实分歧。 */
export function answersEquivalent(a: string, b: string): boolean {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ia = intervals(a), ib = intervals(b);
  if (ia.length && ib.length) {
    return ia.length === ib.length && ia.every((v, i) => v === ib[i]);
  }
  return false;
}

/**
 * 双模型交叉校验（方案 B 核心）。
 *
 * 每个模型先按 v1.18.3 的单一真相源把自身「答案」与「解析结论」对齐，
 * 再比较两个对齐后的最终答案：
 *  - 未启用第二模型 → confidence:"single"（退回单模型行为，零破坏）
 *  - 两模型一致     → confidence:"high"
 *  - 两模型不一致   → needsReview:true，但【不自动裁判】，保留主模型结果交人工复核
 *
 * 设计边界（务必牢记）：一致 ≠ 一定正确——两模型可能一起错（共用相似启发式）。
 * 本函数只给出「信心信号」与「分歧提示」，不替用户决定正确答案；真正的
 * 确定性校验（代回原题做符号/数值验算）需引入数学引擎，不在本次范围内。
 */
export function compareModelAnswers(params: {
  primaryRaw: { analysis: string; answerText: string; finalAnswer: string };
  secondaryRaw?: { analysis: string; answerText: string; finalAnswer: string } | null;
  primaryModel: string;
  secondaryModel: string;
}): ModelVerdict {
  const p = deriveAnswerFromAnalysis(params.primaryRaw.analysis, params.primaryRaw.answerText, params.primaryRaw.finalAnswer);
  const primaryAnswer = p.answerText;
  if (!params.secondaryRaw) {
    return {
      enabled: false, agree: true, needsReview: false, confidence: "single",
      primaryAnswer, secondaryAnswer: "", primaryModel: params.primaryModel, secondaryModel: "",
    };
  }
  const s = deriveAnswerFromAnalysis(params.secondaryRaw.analysis, params.secondaryRaw.answerText, params.secondaryRaw.finalAnswer);
  const secondaryAnswer = s.answerText;
  const agree = answersEquivalent(primaryAnswer, secondaryAnswer);
  if (agree) {
    return {
      enabled: true, agree: true, needsReview: false, confidence: "high",
      primaryAnswer, secondaryAnswer, primaryModel: params.primaryModel, secondaryModel: params.secondaryModel,
    };
  }
  return {
    enabled: true, agree: false, needsReview: true, confidence: "low",
    primaryAnswer, secondaryAnswer, primaryModel: params.primaryModel, secondaryModel: params.secondaryModel,
    note: "两个模型给出的参考答案不一致，已保留主模型结果，请人工复核正确答案。",
  };
}
