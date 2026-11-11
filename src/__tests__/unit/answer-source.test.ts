import { describe, it, expect } from "vitest";
import {
  findConclusionExpr,
  detectAnswerConflict,
  deriveAnswerFromAnalysis,
} from "@/lib/answer-consistency";

/**
 * 2026-11-11 15:26 用户截图里的真实文本。
 * 参考答案写成了 (-½, ½]，解析第三步推导出的正确结论是 [-1, ½)，
 * 且解析末尾以「所以 m=-1 满足条件」收尾（没有区间），旧守卫因此漏报。
 */
const SCREENSHOT_ANALYSIS = String.raw`第三步：结合前两步结果：
$m < \frac{1}{2}$ 且 $m \in [-1,2]$，得 $m \in [-1, \frac{1}{2})$。

但需注意：当 $|1-m|=|m|$ 时，$g(1-m)=g(m)$，不满足严格小于；而我们已通过平方得到严格不等式对应 $m < \frac{1}{2}$，边界 $m = \frac{1}{2}$ 时：
$|1-\frac{1}{2}| = \frac{1}{2} = |m| \Rightarrow g(1-m)=g(m)$
不满足原不等式，故 $m = \frac{1}{2}$ 不包含。

然而，还需验证端点 $m=-1$ 是否可行：
$m = -1$ 时，$1-m = 2$，均在定义域内；
$|1-(-1)| = |2| = 2, |m| = 1$，故 $|1-m| > |m|$ 成立；
因此 $g(2) < g(-1) = g(1)$，由于 $g$ 在 $[0,2]$ 递减，$2 > 1 \ge 0 \Rightarrow g(2) < g(1)$，成立。
所以 $m = -1$ 满足条件。`;

const WRONG_ANSWER = String.raw`(-\frac{1}{2}, \frac{1}{2}]`;
const RIGHT_ANSWER = String.raw`[-1, \frac{1}{2})`;

describe("findConclusionExpr — 全文确定性提取最终结论", () => {
  it("本次截图：末尾是文字结论也能提取到第三步的 [-1, 1/2)", () => {
    expect(findConclusionExpr(SCREENSHOT_ANALYSIS)).toBe(RIGHT_ANSWER);
  });

  it("不把前提/函数性质区间误当成结论", () => {
    const text = String.raw`因此，在 $x \le 0$ 时，g(x) 在 [-2,0] 上单调递增；综上，g(x) 在 [0,2] 上递减。第一步解得 m < \frac{1}{2}，故 $m \in [-1, \frac{1}{2})$。`;
    expect(findConclusionExpr(text)).toBe(RIGHT_ANSWER);
  });

  it("上一次事故的行文（综上…取值范围是）同样能提取", () => {
    const text = String.raw`综上，m 的取值范围是 [-1, \frac{1}{2})。`;
    expect(findConclusionExpr(text)).toBe(RIGHT_ANSWER);
  });

  it("无结论区间时返回空串（交给兜底逻辑，不硬猜）", () => {
    expect(findConclusionExpr(String.raw`本题考查偶函数性质，答案为 A。`)).toBe("");
  });

  it("<final_answer> 里的错误值不参与正文结论提取", () => {
    const text = `${SCREENSHOT_ANALYSIS}\n<final_answer>${WRONG_ANSWER}</final_answer>`;
    expect(findConclusionExpr(text)).toBe(RIGHT_ANSWER);
  });
});

describe("detectAnswerConflict — 前端兜底守卫", () => {
  it("本次截图案例必须报警（旧逻辑漏报）", () => {
    const r = detectAnswerConflict(WRONG_ANSWER, SCREENSHOT_ANALYSIS);
    expect(r.conflict).toBe(true);
    expect(r.answerExpr).toBe("(-1/2,1/2]");
    expect(r.conclusionExpr).toBe("[-1,1/2)");
    expect(r.suggested).toBe("[-1,1/2)");
  });

  it("上一次事故案例仍能检出", () => {
    const r = detectAnswerConflict(
      "(1/2, 2]",
      String.raw`综上，m 的取值范围是 [-1, \frac{1}{2})。`,
    );
    expect(r.conflict).toBe(true);
    expect(r.suggested).toBe("[-1,1/2)");
  });

  it("答案与解析一致时不误报", () => {
    const r = detectAnswerConflict(RIGHT_ANSWER, SCREENSHOT_ANALYSIS);
    expect(r.conflict).toBe(false);
  });

  it("可传入服务端已提取的结论，避免重复解析", () => {
    const r = detectAnswerConflict(WRONG_ANSWER, "任意解析文本", RIGHT_ANSWER);
    expect(r.conflict).toBe(true);
    expect(r.conclusionExpr).toBe("[-1,1/2)");
  });

  it("非区间参考答案不误报", () => {
    expect(detectAnswerConflict("A", SCREENSHOT_ANALYSIS).conflict).toBe(false);
  });
});

describe("deriveAnswerFromAnalysis — 服务端单一真相源", () => {
  it("本次截图：按解析结论校正参考答案，并保留原值", () => {
    const r = deriveAnswerFromAnalysis(
      `${SCREENSHOT_ANALYSIS}\n<final_answer>${WRONG_ANSWER}</final_answer>`,
      WRONG_ANSWER,
      WRONG_ANSWER,
    );
    expect(r.source).toBe("analysis");
    expect(r.conflict).toBe(true);
    expect(r.answerText).toBe(RIGHT_ANSWER);
    expect(r.originalAnswerText).toBe(WRONG_ANSWER);
  });

  it("上一次事故同样被校正", () => {
    const r = deriveAnswerFromAnalysis(
      String.raw`综上，m 的取值范围是 [-1, \frac{1}{2})。<final_answer>(1/2, 2]</final_answer>`,
      "(1/2, 2]",
      "(1/2, 2]",
    );
    expect(r.answerText).toBe(RIGHT_ANSWER);
    expect(r.source).toBe("analysis");
  });

  it("模型答案带 $ 定界符时，校正结果仍带 $（保证前端 KaTeX 渲染）", () => {
    const wrapped = `$${WRONG_ANSWER}$`;
    const r = deriveAnswerFromAnalysis(SCREENSHOT_ANALYSIS, wrapped, wrapped);
    expect(r.conflict).toBe(true);
    expect(r.answerText).toBe(`$${RIGHT_ANSWER}$`);
  });

  it("模型答案与解析结论一致时不改动", () => {
    const r = deriveAnswerFromAnalysis(SCREENSHOT_ANALYSIS, RIGHT_ANSWER, RIGHT_ANSWER);
    expect(r.source).toBe("model");
    expect(r.conflict).toBe(false);
    expect(r.answerText).toBe(RIGHT_ANSWER);
  });

  it("参考答案带 m∈ 前缀也算一致", () => {
    const r = deriveAnswerFromAnalysis(
      SCREENSHOT_ANALYSIS,
      String.raw`$m \in [-1, \frac{1}{2})$`,
      "",
    );
    expect(r.conflict).toBe(false);
    expect(r.answerText).toBe(String.raw`$m \in [-1, \frac{1}{2})$`);
  });

  it("非区间答案（选择题/数值/文字）一律不覆盖", () => {
    for (const a of ["A", "3", "x=2 或 x=-2", ""]) {
      const r = deriveAnswerFromAnalysis(SCREENSHOT_ANALYSIS, a, a);
      expect(r.source).toBe("model");
      expect(r.answerText).toBe(a);
    }
  });

  it("解析里提不到结论区间时保持模型原值", () => {
    const r = deriveAnswerFromAnalysis(
      String.raw`本题考查偶函数与单调性，需分类讨论。`,
      WRONG_ANSWER,
      WRONG_ANSWER,
    );
    expect(r.source).toBe("model");
    expect(r.answerText).toBe(WRONG_ANSWER);
  });

  it("端到端：模拟完整 AI XML 响应，最终 answerText 应为正确结论", () => {
    const xml = [
      "<question_text>定义在 [-2,2] 上的偶函数 g(x)…</question_text>",
      `<answer_text>${WRONG_ANSWER}</answer_text>`,
      `<analysis>${SCREENSHOT_ANALYSIS}\n<final_answer>${WRONG_ANSWER}</final_answer></analysis>`,
    ].join("\n");
    const tag = (t: string) => {
      const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i"));
      return m ? m[1] : "";
    };
    const rawAnalysis = tag("analysis");
    const finalTag = rawAnalysis.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
    const finalAnswer = finalTag ? finalTag[1].trim() : "";
    const r = deriveAnswerFromAnalysis(rawAnalysis, tag("answer_text"), finalAnswer);
    expect(r.answerText).toBe(RIGHT_ANSWER);
    expect(r.source).toBe("analysis");
  });
});
