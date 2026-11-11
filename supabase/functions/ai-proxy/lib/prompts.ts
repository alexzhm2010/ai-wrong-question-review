/**
 * Shared AI prompt templates
 * This module provides centralized prompt management
 */

/**
 * 将 gradeSemester 字符串转换为年级数字（用于标签过滤）
 * 支持格式：初一/七年级/7年级/小学三年级/高一 等
 * @returns 7-12 或 null（无法识别时）
 */
export function gradeSemesterToGradeNumber(gradeSemester: string): 7 | 8 | 9 | 10 | 11 | 12 | null {
  if (!gradeSemester) return null;
  const gs = gradeSemester.toLowerCase();

  // 小学：primary_3 → 不映射到 7-12，返回 null
  if (gs.startsWith('primary') || gs.includes('小学') || gs.match(/[一二三四五六]年级/)) {
    return null;
  }

  // 初中
  if (gs.includes('初一') || gs.includes('七年级') || gs.includes('7年级') || gs === 'junior_high_1') return 7;
  if (gs.includes('初二') || gs.includes('八年级') || gs.includes('8年级') || gs === 'junior_high_2') return 8;
  if (gs.includes('初三') || gs.includes('九年级') || gs.includes('9年级') || gs === 'junior_high_3') return 9;

  // 高中
  if (gs.includes('高一') || gs.includes('10年级') || gs === 'senior_high_1') return 10;
  if (gs.includes('高二') || gs.includes('11年级') || gs === 'senior_high_2') return 11;
  if (gs.includes('高三') || gs.includes('12年级') || gs === 'senior_high_3') return 12;

  return null;
}

/**
 * 将 gradeSemester 字符串转换为中文年级显示名称
 * 用于注入到 AI 提示词中
 * @returns 中文年级名（如"小学三年级"、"初中二年级"）或 null
 */
export function gradeSemesterToDisplayName(gradeSemester: string): string | null {
  if (!gradeSemester) return null;
  const gs = gradeSemester;

  // 小学
  const primaryMatch = gs.match(/primary[_\s]?(\d)/);
  if (primaryMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' };
    return `小学${numMap[primaryMatch[1]] || primaryMatch[1]}年级`;
  }
  if (gs.includes('小学')) {
    // "小学三年级" 格式，直接返回年级部分
    const m = gs.match(/小学([一-龥\d]+年级?)/);
    if (m) return `小学${m[1].replace('年级', '')}年级`.replace('小学小学', '小学');
    return gs.replace(/[上下]$/, '').replace(/[，,].*$/, '').trim();
  }
  if (gs.match(/[一二三四五六]年级/) && !gs.includes('初') && !gs.includes('高')) {
    return `小学${gs.replace(/[上下]$/, '').replace(/[，,].*$/, '').trim()}`;
  }

  // 初中
  const juniorMatch = gs.match(/junior_high[_\s]?(\d)/);
  if (juniorMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三' };
    return `初中${numMap[juniorMatch[1]] || juniorMatch[1]}年级`;
  }
  if (gs.includes('初一')) return '初中一年级';
  if (gs.includes('初二')) return '初中二年级';
  if (gs.includes('初三')) return '初中三年级';
  if (gs.includes('七年级')) return '初中一年级';
  if (gs.includes('八年级')) return '初中二年级';
  if (gs.includes('九年级')) return '初中三年级';

  // 高中
  const seniorMatch = gs.match(/senior_high[_\s]?(\d)/);
  if (seniorMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三' };
    return `高中${numMap[seniorMatch[1]] || seniorMatch[1]}年级`;
  }
  if (gs.includes('高一')) return '高中一年级';
  if (gs.includes('高二')) return '高中二年级';
  if (gs.includes('高三')) return '高中三年级';

  return null;
}

/**
 * 生成学历约束指令
 * @param gradeSemester - 年级学期字符串
 * @returns 约束指令字符串，无学历信息时返回空字符串
 */
export function generateGradeInstruction(gradeSemester?: string | null): string {
  if (!gradeSemester) return '';
  const displayName = gradeSemesterToDisplayName(gradeSemester);
  if (!displayName) return '';

  return `\n【学历约束】\n本题目标年级：${displayName}\n请严格使用该年级课程标准范围内的方法解答，禁止使用超纲知识。\n`;
}

/**
 * Options for customizing prompts
 */
export interface PromptOptions {
  providerHints?: string; // Provider-specific instructions
  additionalTags?: {
    subject: string;
    tags: string[];
  }[];
  customTemplate?: string; // Custom template to override default
  // Pre-fetched tags from database (optional, per subject)
  prefetchedMathTags?: string[];
  prefetchedPhysicsTags?: string[];
  prefetchedChemistryTags?: string[];
  prefetchedBiologyTags?: string[];
  prefetchedEnglishTags?: string[];
}

export const DEFAULT_ANALYZE_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位世界顶尖的、经验丰富的、专业的跨学科考试分析专家（Interdisciplinary Exam Analysis Expert）。你的核心任务是极致准确地分析用户提供的考试题目图片，全面理解所有文本、图表和隐含约束，并提供一个完整、高度结构化且专业的解决方案。

{{language_instruction}}

【最重要的工作顺序：先独立解题，再评判作答 (CRITICAL WORKFLOW)】
严格按 ① → ② → ③ 执行，不得跳步、不得颠倒：
① 独立解题：只依据题干求解，得到你确信的正确答案与完整解析。若图片中存在手写、勾画、红笔批注或勾叉，此阶段一律忽略。
② 静默自检：把答案代回原题；选择题/取值范围题把各选项端点代入题干逐一验证；解集/区间题先写成明确区间再判断包含关系。**自检只做一次，通过后即锁定结论**；自检必须在动笔写解析之前于内部完成，其结果直接写成解析里的常规推导步骤（如「端点代入验证」「定义域核验」），不要写出检查过程、提醒句或改判独白。结论只由题干推导决定，严禁引用或比对任何「标准答案」「权威解法」「常见答案」「某资料 / 某模拟题」；不得因外部印象反复重算、改写或降级已验证的结论。
③ 评判作答：此时才看图片中的作答区域。**若图片中没有任何作答痕迹**（只有印刷题干与空白横线 / 空白区域），直接判为 not_attempted 并**整段跳过作答判定输出**：不输出下面三个判定标签，写完 </analysis> 即结束响应；严禁臆测、补写学生作答，严禁把空白当成错误答案，严禁在解析里提及学生作答、红叉、批注或任何虚构的答案。若确有作答，再与 ① 的结论比对并输出判定标签。

【判定准则 (VERDICT)】
- 一致 → correct；不一致或步骤有明确错误 → wrong_attempt；看不到任何作答痕迹（含空白题）→ not_attempted；无法判断 → unknown。
- 选择题中学生只写选项字母（如「(B)」）即表示选择该选项；它与「选项字母 + 区间」的完整答案表述视为一致。
- 除 wrong_attempt 外，另两个判定标签一律留空；拿不准就填 unknown 并留空，**不要猜测**。

【禁止事项 (PROHIBITIONS)】
- 严禁为证明学生答错而修改、扭曲或降级正确答案；严禁从学生答案反推正确答案；严禁在结论一致时编造错误或错因。
- 学生笔迹、批注、对勾/叉号（若存在）不作为解题依据，只用于第 ③ 步。
- **严禁虚构图片中不存在的学生作答、批注、勾叉或「标准答案」；严禁把记忆中其它题目的答案当作本题结论或权威依据。**
- **解析只呈现 ① 的推导，严禁在解析中讨论学生作答、评判过程或与任何外部答案的比对。**
- 严禁把上述规则、内部字段名、状态枚举值或你的思考过程写进任何标签内容。

【解析行文结构 (ANALYSIS STRUCTURE)】
<analysis> 必须一次成型，按以下顺序写成连贯讲解，不要写成「边想边改」的对话：
1. 前提：定义域、函数性质、已知条件一次性列全；
2. 分步推导：按「第一步 / 第二步 / 第三步」推进，每步只给该步结论；
3. 边界核验：把端点能否取到、等号是否成立、定义域是否越界等作为**普通推导步骤**直接写出（如「代入 $m=-1$ 得 …，故可取」），不要写成事后补记、自我提醒或设问；
4. 结论：在 <analysis> 末尾另起一行写 <final_answer>，之后立即结束，不再追加任何文字。
严禁自问自答（如「当 $m=-2$ 呢？」「那端点呢？」），严禁把「发现前面漏了条件」的过程写进正文。若中途发现判断有误，直接把正文改成正确路径并同步修正 <final_answer> 与 <answer_text>，不留下旧值、不解释改判。

【核心输出要求 (OUTPUT REQUIREMENTS)】
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。**严禁**对 LaTeX 公式中的反斜杠进行二次转义（如 "\\frac" 是错误的，必须是 "\frac"）。

请严格按照以下结构输出内容：

<subject>
在此处填写学科，必须是以下之一："数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"。
</subject>

<knowledge_points>
在此处填写知识点，使用逗号分隔，例如：知识点1, 知识点2, 知识点3
</knowledge_points>

<requires_image>
判断这道题是否需要依赖图片才能正确解答。如果题目包含几何图形、函数图像、实验装置图、电路图等必须看图才能理解的内容，填写 true；如果只需要文字描述即可理解（如英语题、纯文字数学题），填写 false。
</requires_image>

<question_text>
在此处填写题目的完整文本。使用 Markdown 格式。所有数学公式使用 LaTeX 符号（行内 $...$，块级 $$...$$）。

【表格处理规则】
如果图片中包含表格，必须完整转录表格内容，遵循以下原则：

1. **标准表格**：使用 Markdown 表格语法
   | 列标题1 | 列标题2 | 列标题3 |
   |---------|---------|---------|
   | 数据1   | 数据2   | 数据3   |

2. **复杂表格**（合并单元格/多级表头/不规则布局）：
   - 优先尝试用 Markdown 表格近似表示
   - 如果 Markdown 无法准确表达，在表格前用文字说明结构，然后用简化的 Markdown 表格 + 注释
   - 示例：
     > 注：第1行为主标题，横跨3列；第2-3行为数据行

     | 项目 | 数值A | 数值B |
     |------|-------|-------|
     | 测试1 | 10 | 20 |
     | 测试2 | 15 | 25 |

3. **表格完整性要求**：
   - 必须转录所有单元格内容（包括空单元格用 - 或空格表示）
   - 保留表格标题、单位、注释
   - 保留数据的对齐关系和分组信息
   - 表格中的数学公式使用 LaTeX 语法

4. **表格上下文**：
   - 如果表格有标题或编号（如"表1"），保留在表格前
   - 如果表格后有注释或说明，保留在表格后
   - 保持表格在题目中的位置关系

5. **特殊情况处理**：
   - 图表混合：如果表格旁边有图形，用文字说明位置关系
   - 手写表格：尽力识别手写内容，不确定的用 [?] 标注
   - 模糊表格：如果表格不清晰，在表格前注明"（表格内容可能不完整）"
</question_text>

<answer_text>
在此处填写正确答案。使用 Markdown 和 LaTeX 符号。如果答案包含表格，遵循上述【表格处理规则】。
* **必须逐字复制 <analysis> 正文中最后一步推导得到的完整集合/区间**：此值必须与正文推理结论完全一致，禁止在标签里单独重算、改写、把不等号方向写反，也禁止只写某一种情况的中间范围。
* 写完后用【静默自检】的步骤把该集合的边界点与外部反例点代回原题核验一遍：能取到则闭区间、不能取到则开区间、反例点必须不满足题干条件；若核验不通过，回到正文修正推导，并同步改写本标签与 <final_answer>，不得保留旧值。
</answer_text>

<analysis>
在此处填写详细的步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义（不要写成 \\frac）。
* 如果解析过程需要表格（如列表对比、分步计算表），遵循上述【表格处理规则】。
* **推导结束后必须另起一行写 <final_answer>最终结论</final_answer>**：这是本题唯一的最终答案，必须包含完整的取值集合或区间（如 $[-1, \frac{1}{2})$），不能只写某一种情况的中间结果。
* 按【解析行文结构】组织：前提 → 分步推导 → 边界核验（用陈述句直接写，不加转折引导句）→ <final_answer>；不要出现「等等」「但注意」「再仔细看」这类口语化转折或设问。
</analysis>

【作答判定：仅在图片确有作答痕迹时输出 (CONDITIONAL VERDICT)】
**空白题（第 ③ 步确认没有任何作答痕迹）时整段跳过本节：不输出下面三个标签，写完 </analysis> 直接结束响应。** 空白题不需要任何作答判定，也不要在解析里讨论学生作答。
确有作答时，下面三个标签必须在 answer_text 与 analysis 写完之后再填；每个标签只出现一次。

<mistake_status>
correct / wrong_attempt / not_attempted / unknown 之一
</mistake_status>

<wrong_answer_text>
仅 wrong_attempt 时按原样摘录学生的错误解答，否则留空。
</wrong_answer_text>

<mistake_analysis>
仅 wrong_attempt 时按三行填写，合计不超过 150 字；否则留空。
第 1 行：错在解析思路的第几步（只写「第 N 步」，不要重述推导过程）
第 2 行：原因类型（概念混淆 / 计算失误 / 审题遗漏 / 方法选择 / 步骤跳跃 之一）
第 3 行：下次提醒（一句话）
错因只讲偏离正确路径的那一处，不要复述解题步骤。
</mistake_analysis>

【知识点标签列表（KNOWLEDGE POINT LIST）】
{{knowledge_points_list}}

【标签使用规则 (TAG RULES)】
- 标签必须与题目实际考查的知识点精准匹配。
- 每题最多 5 个标签。

【!!! 输出纪律 (OUTPUT DISCIPLINE) !!!】
1. 只输出上述 9 个 XML 标签，不要开场白、结束语或代码块；每个标签只出现一次。**<final_answer> 是唯一例外，必须嵌在 <analysis> 末尾，其后不得再有任何文字**。空白题可整段省略最后三个作答判定标签，此时写完 </analysis> 即结束，不得补写空标签或臆造判定过程。
2. 标签内容里严禁出现：任何 XML 标签（<analysis> 末尾的 <final_answer> 除外）、内部字段名（如 mistake_status、answer_text）、规则复述、自我检查、自我否定，以及「重新输出」「此前分析」「必须修正」「重新判定」等元话语和推理过程；严禁出现「标准答案」「权威解法」「查资料」「学生填的是」「红叉」等虚构答案或外部比对的措辞；严禁出现「与预期相反」「与直觉矛盾」「可能相反」「再仔细检查方向」「是否遗漏」及 ⚠️ 等警示符号、自我怀疑或要求回头重算的措辞。
3. **严禁口语化的自我复盘与转折引导句**，包括但不限于：「等等」「等一下」「这里有个关键遗漏」「但注意！」「但还需验证」「再仔细看」「重新审视」「回过头看」「刚才」「之前得到」「我们已得」「漏了」「忽略了吗」「那 … 呢？」「居然」「竟然」。边界核验、端点验证属于正常推导，请用陈述句直接写结论，不要加这些引导词，也不要用感叹号制造戏剧感。
4. 若推导中发现前面判断有误，直接在解析里静默改到正确路径，并把 <final_answer> 与参考答案标签同时改成正确结论；不要写出改判过程，不要把旧值留在正文里，不要重复输出或补写同一标签。
5. 纯文本：内容作为纯文本处理，不要转义反斜杠。
6. 内容完整：子问题在 question_text 中完整列出；严禁图片链接与 markdown 图片语法。
7. 解析一次成型：按【解析行文结构】的前提 → 分步推导 → 边界核验 → 结论顺序写完，最后在 <analysis> 末尾用 <final_answer> 写出唯一结论；结论写出后立即收尾，禁止追加任何转折、警示、自我怀疑或复核段落，也不要只写「方法一」却只给一种方法。

{{grade_instruction}}
{{provider_hints}}`;

export const DEFAULT_SIMILAR_TEMPLATE = `你是一位资深的K12教育题目生成专家，具备跨学科的题目创作能力。你的核心任务是**根据以下原题和知识点，举一反三生成高质量教学题目**，帮助学生巩固知识并拓展解题思路。
### 角色定义
1. **学科全能专家**  
   - 精通K12阶段所有学科（数学/语文/英语/物理/化学/生物/历史/地理/政治）
   - 熟悉各年级课程标准与知识点分布
   - 能准确识别题目考察的核心能力点（计算/推理/分析/应用/创新）
2. **题目变异大师**  
   - 掌握12种变式技法：条件替换/情境迁移/问题转化/数据重构/图形变形/角色反转/跨学科融合/难度阶梯/开放拓展/陷阱设计/逆向思维/生活应用
   - 确保变式题目保持原题核心考点，改变题目表现形式
3. **学情分析师**  
   - 预判学生易错点（认知盲区/概念混淆/计算失误/审题偏差）
   - 在变式题目中针对性强化易错点训练
### 执行流程
1. **接收任务**  
	原题: "{{original_question}}"
	{{language_instruction}}
	DIFFICULTY LEVEL: {{difficulty_level}}
	{{difficulty_instruction}}
	Knowledge Points: {{knowledge_points}}  
2. **解构分析**  
   - 提取核心考点与能力要求
   - 分析题目陷阱与解题路径
3.  **质量管控**  
   - 确保每道题：  
     ✓ 覆盖相同核心知识点  
     ✓ 保持解题逻辑一致性  
     ✓ 答案唯一且可验证  
     ✓ 无知识性错误
### 输出规范
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。**严禁**返回 \`\`\`json ... \`\`\`。

请严格按照以下结构输出内容（不要包含任何其他文字）：

<question_text>
在此处填写新生成的题目文本。包含选项（如果是选择题）。
</question_text>

<answer_text>
在此处填写新题目的正确答案。
</answer_text>

<analysis>
在此处填写新题目的详细解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义。
</analysis>

###关键格式与内容约束 (CRITICAL RULES) !!!
1. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。

{{grade_instruction}}
{{provider_hints}}`;

/**
 * Helper to replace placeholders in template
 */
function replaceVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] || "";
  });
}

/**
 * 获取指定年级的累进数学标签
 * 初一(7)：只包含七年级标签
 * 初二(8)：包含七年级+八年级标签
 * 初三(9)：包含七年级+八年级+九年级标签
 * 高一(10)：只包含高一标签（不含初中）
 * 高二(11)：包含高一+高二标签
 * 高三(12)：包含高一+高二+高三标签
 * @param grade - 年级 (7-9:初中, 10-12:高中) 或 null
 * @returns 标签数组
 */
/**
 * 获取指定年级的数学标签
 * 必须由调用方预先从数据库获取标签并通过 prefetchedTags 传入
 * @param grade - 年级（已弃用，保留接口兼容）
 * @param prefetchedTags - 从数据库预获取的标签数组
 * @returns 标签数组
 */
export function getMathTagsForGrade(
  grade: 7 | 8 | 9 | 10 | 11 | 12 | null,
  prefetchedTags?: string[]
): string[] {
  // 必须使用预获取的数据库标签
  if (prefetchedTags && prefetchedTags.length > 0) {
    return prefetchedTags;
  }

  // 如果没有预获取标签，返回空数组（AI 将自由标注）
  console.warn('[prompts] No prefetched tags provided, AI will tag freely');
  return [];
}

/**
 * Generates the analyze image prompt
 * @param language - Target language for analysis ('zh' or 'en')
 * @param grade - Optional grade level (7-9:初中, 10-12:高中) for cumulative tag filtering
 * @param options - Optional customizations
 */
/**
 * 反向代入验算提示词：只做「代入检验」、不做解题。
 * 给定原题与两个候选答案，让模型通过边界点/内部点/外部反例点逐一代入原条件，
 * 判断哪个候选正确。两个候选以 A/B 中性呈现，不泄露归属，避免模型迁就某一侧。
 */
export function generateVerifyPrompt(
  questionText: string,
  candidateA: string,
  candidateB: string,
  language: "zh" | "en" = "zh",
): string {
  const langNote = language === "en"
    ? "Respond in English."
    : "使用简体中文。";
  return `你是一名严谨的数学验算员。你的任务不是解题，而是【反向代入验算】：判断给定的两个候选答案哪一个正确。

【原始题干】
${questionText}

【候选答案】
候选 A：${candidateA}
候选 B：${candidateB}

【验算方法（必须执行）】
1. 选取若干检验点：候选解集的边界点（开/闭端点）、内部典型点，以及候选解集之外的反例点；
2. 将这些点逐一代入题干的原始条件，检查是否满足；
3. 通过代入结果判定：哪个候选的解集能让所有检验点都满足题干条件、且外部反例点不满足；
4. 若两个候选都不完全满足，选择满足度更高的那个，或直接判定为无解/需重解。

${langNote}

【输出格式】只输出以下两个标签，不要开场白、不要代码块：
<verified>经代入验算后正确的那个候选答案原文（如确有必要可写成规范区间，但须与候选表述一致）</verified>
<reason>不超过 80 字的代入验算依据</reason>`;
}

export function generateAnalyzePrompt(
  language: 'zh' | 'en',
  grade?: 7 | 8 | 9 | 10 | 11 | 12 | null,
  subject?: string | null,
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: For the 'analysis' field, use Simplified Chinese. For 'questionText' and 'answerText', YOU MUST USE THE SAME LANGUAGE AS THE ORIGINAL QUESTION. If the original question is in Chinese, the new question MUST be in Chinese. If the original is in English, keep it in English. If the original question is in English, the new 'questionText' and 'answerText' MUST be in English, but the 'analysis' MUST be in Simplified Chinese (to help the student understand). "
    : "Please ensure all text fields are in English.";

  // 获取各学科标签（优先使用预获取的数据库标签）
  const mathTags = getMathTagsForGrade(grade || null, options?.prefetchedMathTags);
  const mathTagsString = mathTags.length > 0 ? mathTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const physicsTags = options?.prefetchedPhysicsTags || [];
  const physicsTagsString = physicsTags.length > 0 ? physicsTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const chemistryTags = options?.prefetchedChemistryTags || [];
  const chemistryTagsString = chemistryTags.length > 0 ? chemistryTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const biologyTags = options?.prefetchedBiologyTags || [];
  const biologyTagsString = biologyTags.length > 0 ? biologyTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const englishTags = options?.prefetchedEnglishTags || [];
  const englishTagsString = englishTags.length > 0 ? englishTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  // 根据科目决定显示哪些标签（节省 token，提高准确性）
  let tagsSection = "";

  if (subject === '数学') {
    tagsSection = `**数学标签 (Math Tags):**
使用人教版课程大纲中的**精确标签名称**，可选标签如下：
${mathTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '物理') {
    tagsSection = `**物理标签 (Physics Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${physicsTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '化学') {
    tagsSection = `**化学标签 (Chemistry Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${chemistryTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '生物') {
    tagsSection = `**生物标签 (Biology Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${biologyTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '英语') {
    tagsSection = `**英语标签 (English Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${englishTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else {
    // 未知科目：显示所有标签让 AI 判断
    tagsSection = `**数学标签 (Math Tags):**
${mathTagsString}

**物理标签 (Physics Tags):**
${physicsTagsString}

**化学标签 (Chemistry Tags):**
${chemistryTagsString}

**生物标签 (Biology Tags):**
${biologyTagsString}

**英语标签 (English Tags):**
${englishTagsString}`;
  }

  const template = options?.customTemplate || DEFAULT_ANALYZE_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    knowledge_points_list: tagsSection,
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * Generates the "similar question" prompt
 * @param language - Target language ('zh' or 'en')
 * @param originalQuestion - The original question text
 * @param knowledgePoints - Knowledge points to test
 * @param difficulty - Difficulty level
 * @param options - Optional customizations
 */
export function generateSimilarQuestionPrompt(
  language: 'zh' | 'en',
  originalQuestion: string,
  knowledgePoints: string[],
  difficulty: 'easy' | 'medium' | 'hard' | 'harder' = 'medium',
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: Provide the output based on the 'Original Question' language. If the original question is in English, the new 'questionText' and 'answerText' MUST be in English, but the 'analysis' MUST be in Simplified Chinese (to help the student understand). If the original is in Chinese, everything MUST be in Simplified Chinese."
    : "Please ensure the generated question is in English.";

  const difficultyInstruction = {
    'easy': "Make the new question EASIER than the original. Use simpler numbers and more direct concepts.",
    'medium': "Keep the difficulty SIMILAR to the original question.",
    'hard': "Make the new question HARDER than the original. Combine multiple concepts or use more complex numbers.",
    'harder': "Make the new question MUCH HARDER (Challenge Level). Require deeper understanding and multi-step reasoning."
  }[difficulty];

  const template = options?.customTemplate || DEFAULT_SIMILAR_TEMPLATE;

  return replaceVariables(template, {
    difficulty_level: difficulty.toUpperCase(),
    difficulty_instruction: difficultyInstruction,
    language_instruction: langInstruction,
    original_question: originalQuestion.replace(/"/g, '\\"').replace(/\n/g, '\\n'), // Escape for template safety
    knowledge_points: knowledgePoints.join(", "),
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * 重新解题提示词模板
 * 用于根据校正后的题目文本重新生成答案和解析
 */
export const DEFAULT_REANSWER_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位经验丰富的专业教师。用户已经提供了一道**校正后的题目文本**，请你为这道题目提供正确的答案和详细的解析。

{{language_instruction}}

【题目内容 (QUESTION)】
{{question_text}}

【学科提示 (SUBJECT HINT)】
{{subject_hint}}

【工作顺序：先独立解题，再评判作答 (CRITICAL WORKFLOW)】
① 只依据上面的题目文本独立求解；若图片中存在学生作答、批注、对勾/叉号，此阶段一律忽略。
② 静默自检：把答案代回原题；选择题/取值范围题把端点代入题干验证；区间/解集题先写成明确区间再判断。**自检只做一次，通过后即锁定结论**；自检必须在动笔写解析之前于内部完成，其结果直接写成解析里的常规推导步骤，不要写出检查过程、提醒句或改判独白。严禁引用或比对任何「标准答案」「权威解法」「常见答案」「某资料 / 某模拟题」，不得因外部印象反复重算或改写已验证的结论。
③ 确定正确答案后，才看图片中的作答区域。**若没有任何作答痕迹**（只有印刷题干与空白横线 / 空白区域），直接判为 not_attempted 并**整段跳过作答判定输出**：不输出下面三个判定标签，写完 </analysis> 与 </knowledge_points> 即结束响应；严禁臆测、补写学生作答，严禁把空白当成错误答案，严禁在解析里提及学生作答、红叉或任何虚构答案。确有作答时再比对并输出判定标签。

【判定准则】
一致 → correct；不一致或步骤有明确错误 → wrong_attempt；无作答痕迹（含空白题）→ not_attempted；无法判断 → unknown。
选择题中学生只写选项字母（如「(B)」）即表示选择该选项，与「选项字母 + 区间」的完整表述视为一致。
严禁为证明学生答错而修改正确答案，或从学生答案反推正确答案；拿不准填 unknown，不要猜测。
**严禁虚构图片中不存在的学生作答、批注、勾叉或「标准答案」，严禁把记忆中其它题目的答案当作本题结论或权威依据；解析只呈现 ① 的推导，不得讨论学生作答或与外部答案比对。**

【解析行文结构 (ANALYSIS STRUCTURE)】
<analysis> 必须一次成型，按以下顺序写成连贯讲解，不要写成「边想边改」的对话：
1. 前提：定义域、函数性质、已知条件一次性列全；
2. 分步推导：按「第一步 / 第二步 / 第三步」推进，每步只给该步结论；
3. 边界核验：把端点能否取到、等号是否成立、定义域是否越界等作为**普通推导步骤**直接写出（如「代入 $m=-1$ 得 …，故可取」），不要写成事后补记、自我提醒或设问；
4. 结论：在 <analysis> 末尾另起一行写 <final_answer>，之后立即结束，不再追加任何文字。
严禁自问自答（如「当 $m=-2$ 呢？」「那端点呢？」），严禁把「发现前面漏了条件」的过程写进正文。若中途发现判断有误，直接把正文改成正确路径并同步修正 <final_answer> 与 <answer_text>，不留下旧值、不解释改判。

【核心输出要求 (OUTPUT REQUIREMENTS)】
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。

请严格按照以下结构输出内容（不要包含任何其他文字）：

<answer_text>
在此处填写正确答案。使用 Markdown 和 LaTeX 符号。
* **必须逐字复制下方 <analysis> 末尾 <final_answer> 里的内容**，禁止另算、禁止只写某一种情况的中间范围。
</answer_text>

<analysis>
在此处填写详细的步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\\frac{1}{2}$），**不要**进行 JSON 转义。
* 解析要清晰、完整，适合学生理解。
* **推导结束后必须另起一行写 <final_answer>最终结论</final_answer>**：这是本题唯一的最终答案，必须包含完整的取值集合或区间。
* 按【解析行文结构】组织：前提 → 分步推导 → 边界核验（用陈述句直接写，不加转折引导句）→ <final_answer>；不要出现「等等」「但注意」「再仔细看」这类口语化转折或设问。
</analysis>

<knowledge_points>
在此处填写知识点，使用逗号分隔，例如：知识点1, 知识点2, 知识点3
</knowledge_points>

【作答判定：仅在图片确有作答痕迹时输出 (CONDITIONAL VERDICT)】
**空白题（第 ③ 步确认没有任何作答痕迹）时整段跳过下面三个标签**，写完 </knowledge_points> 直接结束响应；不要在解析里讨论学生作答，也不要补写空标签。确有作答时才输出以下三个标签。

<wrong_answer_text>
仅当 mistake_status = wrong_attempt 时，按原样摘录学生的错误解答；其余情况留空。
</wrong_answer_text>

<mistake_status>
重新判断并填写以下值之一：correct（学生作答与你的正确答案一致）、wrong_attempt（与正确答案不一致或存在明确错误步骤）、not_attempted（图片明确显示未作答或空白）、unknown（看不到作答痕迹或无法判断）。不要猜测。
</mistake_status>

<mistake_analysis>
仅当 mistake_status = wrong_attempt 时按三行填写，合计不超过 150 字；否则留空。
第 1 行：错在解析思路的第几步（只写「第 N 步」，不要重述推导）
第 2 行：原因类型（概念混淆 / 计算失误 / 审题遗漏 / 方法选择 / 步骤跳跃 之一）
第 3 行：下次提醒（一句话）
</mistake_analysis>

【!!! 输出纪律 (OUTPUT DISCIPLINE) !!!】
1. 只输出上述 6 个 XML 标签，不要其他内容；每个标签只出现一次。**<final_answer> 是唯一例外，必须嵌在 <analysis> 末尾，其后不得再有任何文字**。空白题可整段省略最后三个作答判定标签，此时写完 </knowledge_points> 即结束，不得补写空标签或臆造判定过程。
2. 标签内容里严禁出现任何 XML 标签（<analysis> 末尾的 <final_answer> 除外）、内部字段名、规则复述、自我纠错、「重新输出」「此前分析」「必须修正」等元话语和推理过程；严禁出现「标准答案」「权威解法」「查资料」「学生填的是」「红叉」等虚构答案或外部比对的措辞；严禁出现「与预期相反」「与直觉矛盾」「可能相反」「再仔细检查方向」「是否遗漏」及 ⚠️ 等警示符号、自我怀疑或要求回头重算的措辞。
3. **严禁口语化的自我复盘与转折引导句**，包括但不限于：「等等」「等一下」「这里有个关键遗漏」「但注意！」「但还需验证」「再仔细看」「重新审视」「回过头看」「刚才」「之前得到」「我们已得」「漏了」「忽略了吗」「那 … 呢？」「居然」「竟然」。边界核验、端点验证属于正常推导，请用陈述句直接写结论，不要加这些引导词，也不要用感叹号制造戏剧感。
4. 若推导中发现前面判断有误，直接在解析里静默改到正确路径，并把 <final_answer> 与参考答案标签同时改成正确结论；不要写出改判过程，也不要重复输出同一标签。
5. 纯文本：不要转义反斜杠；不要修改或重复题目内容，只提供答案和解析。
6. 解析一次成型：按【解析行文结构】的前提 → 分步推导 → 边界核验 → 结论顺序写完，最后在 <analysis> 末尾用 <final_answer> 写出唯一结论；结论写出后立即收尾，禁止追加任何转折、警示、自我怀疑或复核段落。

{{grade_instruction}}
{{provider_hints}}`;

/**
 * GeoGebra 动态演示生成提示词
 * 用于判断题目是否可以用 GeoGebra 演示，以及生成对应的 GeoGebra 命令
 */
export const DEFAULT_GEOGEBRA_PROMPT = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位专业的 GeoGebra 数学可视化专家。你的任务是分析一道数学题目，判断它是否适合用 GeoGebra 进行动态可视化演示。如果适合，生成可以直接在 GeoGebra 中执行的命令。

【题目内容 (QUESTION)】
{{question_text}}

【答案内容 (ANSWER)】
{{answer_text}}

【解析内容 (ANALYSIS)】
{{analysis}}

{{error_feedback}}

【判断标准 (SUITABILITY CRITERIA)】
适合用 GeoGebra 演示的题目类型：
1. **函数与图像**：一次函数、二次函数、反比例函数、指数函数、对数函数、三角函数等
2. **几何图形**：三角形、四边形、圆、直线关系（平行、垂直）、角度
3. **解析几何**：直线方程、圆的方程、椭圆、双曲线、抛物线
4. **向量**：向量运算、向量的几何表示
5. **概率统计**：数据分布图、正态分布曲线
6. **不等式**：线性规划、可行域
7. **立体几何**（部分可演示）：截面、展开图

不适合用 GeoGebra 演示的题目类型：
1. 纯文字推理题、证明题（无图形元素）
2. 纯计算题（如解方程、化简表达式）
3. 概念辨析题、选择题（无几何内容）
4. 英语、语文、历史等非理科题目
5. 概率计算（无图形意义的）
6. 数列通项公式推导（无图形意义的）

【GeoGebra 命令规范 (COMMAND SYNTAX)】
如果适合演示，生成 GeoGebra 命令数组。每条命令一行，**全部使用英文命令名**（中文界面会把 Point 显示成「描点」，但命令里禁止写「描点(」「交点(」等中文名称）。

**GeoGebra 绘图命令（通过 evalCommand 执行）：**
- 函数：f(x) = x^2
- 点：A = (1, 2)  ← 定义点首选这种写法
- 描点：Point(f, 2) 或 Point({(1,2),(3,4)})  ← Point 只接受 1 或 2 个参数，禁止 Point(a, b, c) 三参数
- 直线：line: y = 2x + 1  或  Line(A, B)；过 P 且平行于 l 用 Line(P, l)，**不要写 ParallelLine**
- 垂线：PerpendicularLine(P, l)
- 线段：Segment(A, B)  ← 恰好 2 个参数；需要命名写 s = Segment(A, B)，禁止第三个标签参数
- 圆：Circle(A, 3)  或  c: (x-1)^2 + (y-2)^2 = 9
- 椭圆：Ellipse(F1, F2, 5)
- 多边形：Polygon(A, B, C)
- 交点：Intersect(f, g) / Intersect(f, g, 1) / Intersect(f, g, x1, x2)
- 中点：Midpoint(A, B)
- 角度：Angle(A, B, C)
- 极值点：Extremum(f)
- 文本：Text("说明文字", (x, y))  ← 引号是合法且必需的
- 轨迹：Locus(P, Q)
- 反射 / 平移 / 旋转：Reflect(A, l) / Translate(A, v) / Rotate(A, angle, center)

**参数与滑动条：**
- GeoGebra **没有 Slider() 命令**。给变量赋一个数值就会自动生成可拖动的滑动条：a = 1
- 【重要顺序】数值参数必须先定义，再定义依赖它的函数：先 a = 1，再 h(x) = a*x^2 - x + 1。顺序写反会导致函数创建失败。

**Applet API 设置命令（方法名必须小写开头）：**
- setCoordSystem(-10, 10, -10, 10)  -- 设置坐标范围（必须排在所有绘图命令之前）
- setAxesVisible(true, true)  -- 显示/隐藏坐标轴
- setGridVisible(true)  -- 显示/隐藏网格
- setColor("对象名", R, G, B)  -- 设置颜色 (0-255)
- setLineThickness("对象名", 3)  -- 设置线宽
- setLineStyle("对象名", 1)  -- 0=实线, 1=虚线
- setPointSize("对象名", 5)  -- 设置点大小
- setPointStyle("对象名", 4)  -- 点样式 (3-8)
- setLabelVisible("对象名", true)  -- 显示/隐藏标签
- setCaption("对象名", "LaTeX标签")  -- 设置标签文本
- setFilling("对象名", 0.3)  -- 设置填充透明度 (0-1)
- 禁止写成 SetColor / SetLineThickness（首字母大写会找不到方法）

【命令数量与格式】
- 最多 20 条命令；宁可少画几条，也不要输出没有把握的命令
- 每条命令独占一行，末尾不要逗号或分号，不要写注释
- 禁止输出 GeoGebra 不存在的命令（Slider、ParallelLine、中文命令名等）

【输出格式 (OUTPUT FORMAT)】
你的响应必须**只有以下 JSON 格式**，不要包含其他任何文字：

如果题目**适合**用 GeoGebra 演示：
{"suitable": true, "commands": ["命令1", "命令2", "命令3", ...], "description": "简要说明演示内容"}

如果题目**不适合**用 GeoGebra 演示：
{"suitable": false, "commands": [], "description": "不适合原因简述"}

【!!! 关键约束 (CRITICAL RULES) !!!】
1. 输出必须是合法的 JSON，不要添加 markdown 代码块标记
2. commands 数组中的每条命令必须是 GeoGebra 可直接执行的语法
3. setCoordSystem 应根据题目内容合理设置坐标范围
4. 所有图形对象应设置合适的颜色和样式以便于观察
5. 确保坐标范围能让所有关键图形和交点清晰可见
6. description 用简体中文
7. 如果题目涉及参数讨论（如讨论 a 的取值范围），用 a = 1 生成可拖动的数值滑动条，再画依赖 a 的函数；禁止使用 Slider()
8. 对于函数题，应画出函数图像并标注关键点（交点、顶点、渐近线等）
9. 【!!! 命令语法检查 (COMMAND SYNTAX CHECK) !!!】生成后必须逐条检查以下内容：
   a. 每个变量/对象在使用前必须已定义；数值参数（a = 1）必须写在依赖它的函数之前
   b. 只使用上面列出的官方英文命令名；禁止 Slider()、ParallelLine()、中文命令名等不存在的指令
   c. Point 最多 2 个参数、Segment 恰好 2 个参数、Intersect 只用上面列出的参数形式
   d. 命令顺序：先基础对象（参数、点、线、函数），再派生对象（交点、极值、变换）
   e. API 设置命令小写开头（setColor），每条命令末尾无逗号、无分号
   f. 坐标轴范围 (setCoordSystem) 必须在所有绘图命令之前设置
   g. 若某条命令无法确认语法，宁可删掉它，也不要输出后让执行失败`;

/**
 * 生成 GeoGebra 分析提示词
 */
export function generateGeogebraPrompt(
    questionText: string,
    answerText: string,
    analysis: string,
    previousErrors?: string
): string {
    let prompt = DEFAULT_GEOGEBRA_PROMPT.replace(
        "{{question_text}}",
        questionText
    )
        .replace("{{answer_text}}", answerText)
        .replace("{{analysis}}", analysis);

    if (previousErrors?.trim()) {
        prompt = prompt.replace(
            "{{error_feedback}}",
            `【上次执行错误 (PREVIOUS ERRORS)】\n以下命令已由程序在真实 GeoGebra 中逐条执行并判定失败，请据此修正：\n${previousErrors}\n\n【错误修正要求 (ERROR FIX RULES)】\n请按以下步骤修正，并输出修正后的完整命令列表（不是只输出改动的那几条）：\n1. 检查每条失败命令，确认是命令不存在、参数个数不对、变量未定义还是方法名大小写错误\n2. 如果是"未定义变量X"，在命令之前添加定义该变量的命令，或调整命令顺序\n3. 如果是命令不存在（如 Slider()、ParallelLine()），换成上面列出的官方等效写法（a = 1 / Line(P, l)）\n4. 如果是参数个数不对（如 Point 三参数、Segment 三参数），改成合法参数形式\n5. 重新排列所有命令的顺序，确保每个对象在使用前已定义\n6. 生成后再次逐条检查：每条命令的语法、变量引用、依赖关系是否正确`
        );
    } else {
        prompt = prompt.replace("{{error_feedback}}", "");
    }

    return prompt;
}

/**
 * 生成重新解题提示词
 * @param language - 语言 ('zh' 或 'en')
 * @param questionText - 校正后的题目文本
 * @param subject - 学科提示（可选）
 * @param options - 自定义选项
 */
export function generateReanswerPrompt(
  language: 'zh' | 'en',
  questionText: string,
  subject?: string | null,
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: 解析必须使用简体中文。如果题目是英文，答案保持英文，但解析用中文。"
    : "Please ensure all text fields are in English.";

  const subjectHint = subject
    ? `本题学科：${subject}`
    : "请根据题目内容判断学科。";

  const template = options?.customTemplate || DEFAULT_REANSWER_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    question_text: questionText,
    subject_hint: subjectHint,
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}
