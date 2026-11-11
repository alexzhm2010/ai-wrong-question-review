import { describe, it, expect } from "vitest";
import {
  compareModelAnswers,
  answersEquivalent,
  deriveAnswerFromAnalysis,
} from "@/lib/answer-consistency";

// 每个模型先经 v1.18.3 单一真相源对齐（答案↔自身解析），再比较两个对齐后的最终答案。
const raw = (analysis: string, answerText: string, finalAnswer = answerText) => ({
  analysis,
  answerText,
  finalAnswer,
});

describe("answersEquivalent", () => {
  it("区间精确相等（含空格差异）视为一致", () => {
    expect(answersEquivalent("[-1, 1/2)", "[-1,1/2)")).toBe(true);
  });
  it("端点数值不同视为不一致", () => {
    expect(answersEquivalent("[-1,1/2)", "(1/2,2]")).toBe(false);
  });
  it("开闭不同视为不一致（本次事故同类）", () => {
    expect(answersEquivalent("(-1/2,1/2]", "[-1,1/2)")).toBe(false);
  });
  it("超集（仅定义域）不误判为一致", () => {
    expect(answersEquivalent("[-1,1/2)", "[-1,2]")).toBe(false);
  });
  it("非区间文本归一化相等视为一致", () => {
    expect(answersEquivalent(" B ", "B")).toBe(true);
  });
  it("非区间文本不同视为不一致", () => {
    expect(answersEquivalent("A", "B")).toBe(false);
  });
});

describe("compareModelAnswers — 单模型退化", () => {
  it("未启用第二模型：confidence=single，不报分歧", () => {
    const r = compareModelAnswers({
      primaryRaw: raw("得 m∈[-1,1/2)。", "[-1,1/2)"),
      secondaryRaw: null,
      primaryModel: "qwen3-vl-plus",
      secondaryModel: "",
    });
    expect(r.enabled).toBe(false);
    expect(r.confidence).toBe("single");
    expect(r.needsReview).toBe(false);
    expect(r.primaryAnswer).toBe("[-1,1/2)");
  });
});

describe("compareModelAnswers — 双模型一致", () => {
  it("两模型最终答案相同：confidence=high，不报分歧", () => {
    const r = compareModelAnswers({
      primaryRaw: raw("得 m∈[-1,1/2)。", "[-1,1/2)"),
      secondaryRaw: raw("因此 m∈[-1,1/2)。", "[-1,1/2)"),
      primaryModel: "qwen3-vl-plus",
      secondaryModel: "gemini-2.5-flash",
    });
    expect(r.enabled).toBe(true);
    expect(r.agree).toBe(true);
    expect(r.needsReview).toBe(false);
    expect(r.confidence).toBe("high");
  });

  it("选择题两模型都给 B：一致", () => {
    const r = compareModelAnswers({
      primaryRaw: raw("故选 B。", "B"),
      secondaryRaw: raw("因此选 B。", "B"),
      primaryModel: "qwen3-vl-plus",
      secondaryModel: "gemini-2.5-flash",
    });
    expect(r.agree).toBe(true);
    expect(r.needsReview).toBe(false);
  });
});

describe("compareModelAnswers — 双模型分歧（转人工）", () => {
  it("两模型解析结论本身不同 → needsReview=true，不自动裁判", () => {
    // 主模型答案抄错但解析对（v1.18.3 校正为 [-1,1/2)）；第二模型解析结论不同（(0,1]）。
    // 二者最终答案不同 → 真正分歧，转人工。
    const r = compareModelAnswers({
      primaryRaw: raw("得 m∈[-1,1/2)。", "(-1/2,1/2]"),
      secondaryRaw: raw("因此 m∈(0,1]。", "(0,1]"),
      primaryModel: "qwen3-vl-plus",
      secondaryModel: "gemini-2.5-flash",
    });
    expect(r.enabled).toBe(true);
    expect(r.agree).toBe(false);
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBe("low");
    // 保留主模型（已按自身解析校正）结果，绝不替用户定真
    expect(r.primaryAnswer).toBe("[-1,1/2)");
    expect(r.secondaryAnswer).toBe("(0,1]");
    expect(r.note).toContain("人工复核");
  });

  it("两模型数学结论真正相反（(1/2,2] vs [-1,1/2)）→ 分歧", () => {
    const r = compareModelAnswers({
      primaryRaw: raw("得 m∈(1/2,2]。", "(1/2,2]"),
      secondaryRaw: raw("得 m∈[-1,1/2)。", "[-1,1/2)"),
      primaryModel: "qwen3-vl-plus",
      secondaryModel: "gemini-2.5-flash",
    });
    expect(r.needsReview).toBe(true);
    expect(r.primaryAnswer).toBe("(1/2,2]");
    expect(r.secondaryAnswer).toBe("[-1,1/2)");
  });

  it("第二模型仅给出定义域（超集）→ 仍判分歧，不掩盖", () => {
    const r = compareModelAnswers({
      primaryRaw: raw("得 m∈[-1,1/2)。", "[-1,1/2)"),
      secondaryRaw: raw("由定义域得 m∈[-1,2]。", "[-1,2]"),
      primaryModel: "qwen3-vl-plus",
      secondaryModel: "gemini-2.5-flash",
    });
    expect(r.needsReview).toBe(true);
  });
});

describe("deriveAnswerFromAnalysis 仍是单一真相源", () => {
  it("答案与自身解析矛盾时以解析为准", () => {
    const r = deriveAnswerFromAnalysis("得 m∈[-1,1/2)。", "(-1/2,1/2]", "(-1/2,1/2]");
    expect(r.answerText).toBe("[-1,1/2)");
    expect(r.source).toBe("analysis");
    expect(r.originalAnswerText).toBe("(-1/2,1/2]");
  });
});
