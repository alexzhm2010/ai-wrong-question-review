import { describe, expect, it } from 'vitest';
import {
    containsChainOfThought,
    containsSelfDoubt,
    containsMetaTalk,
    shouldStopGeneration,
    extractTagSafe,
    parseMistakeFieldsFromResponse,
    reconcileMistakeFields,
    verdictSectionOmitted,
    sanitizeBodyText,
    sanitizeMistakeForPersistence,
    sanitizeMistakeText,
    stripLeakedTags,
    withoutMistakeAnalysis,
} from '@/lib/ai/response-guard';

describe('AI 输出护栏 · 防呆解析', () => {
    it('重复输出的同名标签只认第一组完整标签', () => {
        const raw = '<mistake_analysis>第一段</mistake_analysis>' +
            '<wrong_answer_text></wrong_answer_text>' +
            '<mistake_analysis>第二段</mistake_analysis>';
        expect(extractTagSafe(raw, 'mistake_analysis')).toBe('第一段');
    });

    it('闭合标签缺失时普通字段返回 null，不吞后续内容', () => {
        expect(extractTagSafe('<mistake_status>correct', 'mistake_status')).toBeNull();
    });

    it('analysis 截断容错只取到下一个已知开标签之前', () => {
        const raw = '<analysis>第一步：求得 M=(1,3]\n<wrong_answer_text>(B)</wrong_answer_text>';
        expect(extractTagSafe(raw, 'analysis', true)).toBe('第一步：求得 M=(1,3]');
    });
});

describe('AI 输出护栏 · 内容清洗', () => {
    it('剥离误写进正文的 XML 标签', () => {
        expect(stripLeakedTags('(B) </wrong_answer_text>')).toBe('(B)');
        expect(stripLeakedTags('<mistake_analysis>移项符号写反</mistake_analysis>')).toBe('移项符号写反');
    });

    it('识别规则复述与自我纠错，不误伤正常讲解', () => {
        expect(containsMetaTalk('重新审视规则第3条：这是误判！')).toBe(true);
        expect(containsMetaTalk('mistake_status 应为 correct')).toBe(true);
        expect(containsMetaTalk('移项时符号写反了，导致结果偏大')).toBe(false);
    });

    it('主体内容从元话语处截断，保留前面正确的推导', () => {
        const raw = '先求 M=(1,3]。但注意：判定规则要求重新输出正确判定';
        expect(sanitizeBodyText(raw)).toBe('先求 M=(1,3]。但注意：');
    });

    it('错因字段被污染时整体留空', () => {
        expect(sanitizeMistakeText('⚠️ 修正：经重新严格对照规则，应为 correct')).toBe('');
        expect(sanitizeMistakeText('第 2 步 / 计算失误 / 注意符号')).toBe('第 2 步 / 计算失误 / 注意符号');
    });
});

describe('AI 输出护栏 · 判定裁决', () => {
    it('学生答对却被判错时，按选项字母改判 correct 并清空错因', () => {
        const result = reconcileMistakeFields({
            answerText: 'B. $\\left(\\frac{1}{4}, +\\infty\\right)$',
            wrongAnswerText: '(B)',
            mistakeAnalysis: '只写了字母没写区间，不符合答题规范',
            mistakeStatus: 'wrong_attempt',
        });
        expect(result.mistakeStatus).toBe('correct');
        expect(result.wrongAnswerText).toBe('');
        expect(result.mistakeAnalysis).toBe('');
        expect(result.repaired).toBe(true);
    });

    it('自我纠错文本与裸标签被清空，状态降为未判断', () => {
        const result = reconcileMistakeFields({
            answerText: 'x = 2',
            wrongAnswerText: '</wrong_answer_text>',
            mistakeAnalysis: '重新审视规则第3条：这是误判！',
            mistakeStatus: 'wrong_attempt',
        });
        expect(result.wrongAnswerText).toBe('');
        expect(result.mistakeAnalysis).toBe('');
        expect(result.mistakeStatus).toBe('unknown');
    });

    it('正常做错的记录保持完整', () => {
        const result = reconcileMistakeFields({
            answerText: 'x = 2',
            wrongAnswerText: 'x = 4',
            mistakeAnalysis: '第 2 步\n计算失误\n移项时注意符号',
            mistakeStatus: 'wrong_attempt',
        });
        expect(result.mistakeStatus).toBe('wrong_attempt');
        expect(result.wrongAnswerText).toBe('x = 4');
        expect(result.mistakeAnalysis).toContain('计算失误');
    });

    it('答对时即便残留错因也一律清空', () => {
        const result = reconcileMistakeFields({
            wrongAnswerText: '随便写点什么',
            mistakeAnalysis: '编造的错因',
            mistakeStatus: 'correct',
        });
        expect(result.mistakeStatus).toBe('correct');
        expect(result.wrongAnswerText).toBe('');
        expect(result.mistakeAnalysis).toBe('');
    });

    it('过长的错因被截断到上限', () => {
        const result = reconcileMistakeFields({
            answerText: 'x = 2',
            wrongAnswerText: 'x = 4',
            mistakeAnalysis: '错'.repeat(700),
            mistakeStatus: 'wrong_attempt',
        });
        expect(result.mistakeAnalysis.length).toBe(600);
    });

    it('保存路径保留用户手填的错因，但清除脏文本', () => {
        const manual = sanitizeMistakeForPersistence({
            wrongAnswerText: '我选了 C',
            mistakeAnalysis: '概念混淆',
            mistakeStatus: 'unknown',
        });
        expect(manual.mistakeStatus).toBe('unknown');
        expect(manual.mistakeAnalysis).toBe('概念混淆');

        const dirty = sanitizeMistakeForPersistence({
            wrongAnswerText: '(B) </wrong_answer_text>',
            mistakeAnalysis: '重新输出正确判定',
            mistakeStatus: 'wrong_attempt',
        });
        expect(dirty.mistakeAnalysis).toBe('');
    });

    it('关闭 AI 错因后三个判定字段被抹掉', () => {
        const result = withoutMistakeAnalysis({
            wrongAnswerText: 'x = 4',
            mistakeAnalysis: '计算失误',
            mistakeStatus: 'wrong_attempt' as const,
        }, false);
        expect(result.mistakeStatus).toBe('unknown');
        expect(result.wrongAnswerText).toBe('');
        expect(result.mistakeAnalysis).toBe('');
    });
});

describe('回归：取值范围题把「反复验算/揣测标准答案」的思维链写进解析', () => {
    const cleanPart = [
        '第一步：由偶函数得 g(1-m)=g(|1-m|)、g(m)=g(|m|)。',
        '第二步：|1-m|>|m| 两边平方得 1-2m>0，即 m<1/2。',
        '第三步：定义域约束 m∈[-1,2]，故解集为 m∈[-1,1/2)。',
    ].join('\n');

    const polluted = [
        cleanPart,
        '但等等！刚才我们得到 m<1/2，为何答案写成 (-1/2,1/2]？说明我们漏了关键点！',
        '查权威解法：本题常见答案给的是 (-1/2,1/2]。',
        '我们作为专家，必须给出正确答案。',
        '然而，很多考试题中答案给的是 (-1/2,1/2]，我意识到我们可能犯了一个错误。',
        '题目图片中学生填的是 (-1/2,1/2]，且有红叉。',
        '再查多份高考模拟题，发现标准答案确为 (-1/2,1/2]。',
        '但为什么之前判 wrong？重新审视：偶函数……',
    ].join('\n');

    it('识别成段思维链，且从第一处改口截断，保留前面正确的推导与结论', () => {
        expect(containsChainOfThought(polluted)).toBe(true);
        expect(sanitizeBodyText(polluted)).toBe(cleanPart);
    });

    it('单个信号不误伤正常讲解', () => {
        expect(containsChainOfThought('我们再看第二步，把端点代入标准答案逐一验证')).toBe(false);
        expect(containsChainOfThought('解得 m∈[-1,1/2)。注意：此处需验证边界点')).toBe(false);
        expect(sanitizeBodyText('解得 m∈[-1,1/2)。注意：此处需验证边界点'))
            .toBe('解得 m∈[-1,1/2)。注意：此处需验证边界点');
    });

    it('输出被截断、analysis 未闭合时也不把整段独白当正文', () => {
        const truncated = `<analysis>${polluted}`; // 无闭合标签，末尾戛然而止
        expect(sanitizeBodyText(extractTagSafe(truncated, 'analysis', true) || ''))
            .toBe(cleanPart);
    });
});

describe('回归：数学选择题 B 被误判并输出自我纠错独白', () => {
    it('典型污染响应最终判为答对了，错因全空且解析不受影响', () => {
        const raw = [
            '<subject>数学</subject>',
            '<knowledge_points>集合运算, 恒成立问题</knowledge_points>',
            '<requires_image>false</requires_image>',
            '<question_text>已知不等式 (x-2)/(x-1) ≤ 1/2 的解集为 M……</question_text>',
            '<answer_text>B. $\\left(\\frac{1}{4},+\\infty\\right)$</answer_text>',
            '<analysis>解得 M=(1,3]，故 a>1/4。</analysis>',
            '<wrong_answer_text>(B)</wrong_answer_text>',
            '<mistake_status>wrong_attempt</mistake_status>',
            '<mistake_analysis>',
            '学生答案写的是"(B)"，看似选对了选项字母，但根据红笔标注，正确答案应为区间……',
            '但注意：我们的判定规则是——学生作答与上面 answer_text 中的正确答案一致 → correct。',
            '重新审视规则第3条：学生作答与你的正确答案一致 → mistake_status 填 correct。',
            '然而，图片中学生写的是"(B)"，而正确选项确实是 B，但为什么之前判 wrong_attempt？——这是误判！',
            '因此，纠正：</mistake_analysis>',
            '',
            '重新输出正确判定：',
            '<mistake_status> correct </mistake_status>',
            '<wrong_answer_text>',
            '</wrong_answer_text>',
        ].join('\n');

        const mistake = reconcileMistakeFields({
            answerText: extractTagSafe(raw, 'answer_text') || '',
            wrongAnswerText: extractTagSafe(raw, 'wrong_answer_text'),
            mistakeAnalysis: extractTagSafe(raw, 'mistake_analysis'),
            mistakeStatus: extractTagSafe(raw, 'mistake_status'),
        });

        expect(mistake.mistakeStatus).toBe('correct');
        expect(mistake.wrongAnswerText).toBe('');
        expect(mistake.mistakeAnalysis).toBe('');
        expect(sanitizeBodyText(extractTagSafe(raw, 'analysis') || ''))
            .toBe('解得 M=(1,3]，故 a>1/4。');
    });
});

describe('回归：空白题整段跳过作答判定', () => {
    // 原图只有印刷题干与空白横线。提示词要求模型写完 </analysis> 直接结束，
    // 不再为填三个判定标签而虚构学生作答 / 红叉 / 标准答案。
    const blankResponse = [
        '<subject>数学</subject>',
        '<knowledge_points>函数奇偶性</knowledge_points>',
        '<requires_image>false</requires_image>',
        '<question_text>已知 g(x) 是定义在 [-2,2] 上的偶函数，求 m 的取值范围。</question_text>',
        '<answer_text>$m \\in [-1, \\frac{1}{2})$</answer_text>',
        '<analysis>由偶函数性质得 |1-m| &gt; |m|，结合定义域解得区间。</analysis>',
    ].join('\n');

    it('analysis 闭合且三个判定标签缺失时识别为跳过', () => {
        expect(verdictSectionOmitted(blankResponse)).toBe(true);
    });

    it('输出被截断（analysis 未闭合）时不误判为跳过', () => {
        expect(verdictSectionOmitted('<analysis>由偶函数性质得……')).toBe(false);
    });

    it('确有作答内容时不视为跳过', () => {
        const withVerdict = blankResponse + '\n<wrong_answer_text>(-1/2,1/2]</wrong_answer_text>' +
            '\n<mistake_status>wrong_attempt</mistake_status>' +
            '\n<mistake_analysis>端点判断错误</mistake_analysis>';
        expect(verdictSectionOmitted(withVerdict)).toBe(false);
    });

    it('空白题响应解析为 not_attempted 且错因字段为空', () => {
        const extract = (tag: string) => extractTagSafe(blankResponse, tag);
        const mistake = parseMistakeFieldsFromResponse(blankResponse, extract, '$m \\in [-1,1/2)$');

        expect(mistake.mistakeStatus).toBe('not_attempted');
        expect(mistake.wrongAnswerText).toBe('');
        expect(mistake.mistakeAnalysis).toBe('');
    });

    it('模型只输出三个空标签时同样归一为 not_attempted', () => {
        const emptyTags = blankResponse + '\n<wrong_answer_text></wrong_answer_text>' +
            '\n<mistake_status></mistake_status>' +
            '\n<mistake_analysis></mistake_analysis>';
        const extract = (tag: string) => extractTagSafe(emptyTags, tag);
        const mistake = parseMistakeFieldsFromResponse(emptyTags, extract, '答案');

        expect(mistake.mistakeStatus).toBe('not_attempted');
        expect(mistake.wrongAnswerText).toBe('');
    });

    it('确有作答时照常保留 wrong_attempt 判定', () => {
        const withVerdict = blankResponse + '\n<wrong_answer_text>(-1/2,1/2]</wrong_answer_text>' +
            '\n<mistake_status>wrong_attempt</mistake_status>' +
            '\n<mistake_analysis>第 2 步\n审题遗漏\n检查端点</mistake_analysis>';
        const extract = (tag: string) => extractTagSafe(withVerdict, tag);
        const mistake = parseMistakeFieldsFromResponse(withVerdict, extract, '$m \\in [-1,1/2)$');

        expect(mistake.mistakeStatus).toBe('wrong_attempt');
        expect(mistake.wrongAnswerText).toBe('(-1/2,1/2]');
        expect(mistake.mistakeAnalysis).toContain('审题遗漏');
    });
});

describe('回归：空白题解析中途插入自我怀疑句（v1.17.0 线上实测样本）', () => {
    // 原图只有印刷题干 + 空白横线。模型前三步与结论 m∈[-1,1/2) 全对，
    // 却在推导中途插入「与预期相反」，并在正确答案之后又来一句「与直觉矛盾」。
    // 旧词表（COT_SIGNAL_RES）一个信号都没命中，所以整段原样放行。
    const raw = [
        '第三步：解不等式 |1-m|>|m|',
        '方法一：平方法（安全，无增根）',
        '|1-m|²>|m|² ⇒ (1-m)²>m² ⇒ 1-2m+m²>m² ⇒ 1-2m>0 ⇒ m<1/2',
        '⚠️ 注意！这个结果与我们预期可能相反——需检查是否遗漏定义域限制！',
        '但这里有个关键点：g 只定义在 [-2,2] 上，所以要求：',
        '1-m∈[-2,2]，m∈[-2,2]',
        '取交集得 m∈[-1,2]',
        '但上面推导出 m<1/2，结合定义域得 m∈[-1,1/2)',
        '然而，这与直觉矛盾——我们再仔细检查单调性方向！',
    ].join('\n');

    it('旧思维链词表确实漏判，新自我怀疑检测能命中', () => {
        expect(containsChainOfThought(raw)).toBe(false);
        expect(containsMetaTalk(raw)).toBe(false);
        expect(containsSelfDoubt(raw)).toBe(true);
    });

    it('只剔除两句怀疑，完整保留其余七行推导与结论', () => {
        const expected = [
            '第三步：解不等式 |1-m|>|m|',
            '方法一：平方法（安全，无增根）',
            '|1-m|²>|m|² ⇒ (1-m)²>m² ⇒ 1-2m+m²>m² ⇒ 1-2m>0 ⇒ m<1/2',
            '但这里有个关键点：g 只定义在 [-2,2] 上，所以要求：',
            '1-m∈[-2,2]，m∈[-2,2]',
            '取交集得 m∈[-1,2]',
            '但上面推导出 m<1/2，结合定义域得 m∈[-1,1/2)',
        ].join('\n');
        expect(sanitizeBodyText(raw)).toBe(expected);
    });

    it('结论后的成段思维链仍按旧规则截断，不受逐句剔除影响', () => {
        const mixed = '解得 m∈[-1,1/2)。\n但等等！为何答案写成 (-1/2,1/2]？说明我们漏了关键点！\n查权威解法：标准答案确为 (-1/2,1/2]。';
        expect(sanitizeBodyText(mixed)).toBe('解得 m∈[-1,1/2)。');
    });

    it('正常的边界验证讲解不被误删', () => {
        const normal = '解得 m∈[-1,1/2)。注意：此处需验证边界点';
        expect(containsSelfDoubt(normal)).toBe(false);
        expect(sanitizeBodyText(normal)).toBe(normal);
    });
});

describe('token 经济性：结论后自我怀疑时提前终止生成', () => {
    it('中途警告（结论未出）不终止，避免砍掉后面的正确推导', () => {
        const mid = [
            '<analysis>第三步：由平方得 m<1/2。',
            '⚠️ 注意！这个结果与我们预期可能相反——需检查是否遗漏定义域限制！',
        ].join('\n');
        expect(shouldStopGeneration(mid)).toBe(false);
    });

    it('结论已给出又出现自我怀疑时终止', () => {
        const done = [
            '<analysis>第三步：由平方得 m<1/2。',
            '⚠️ 注意！这个结果与我们预期可能相反——需检查是否遗漏定义域限制！',
            '结合定义域取交集得 m∈[-1,1/2)。',
            '然而，这与直觉矛盾——我们再仔细检查单调性方向！',
        ].join('\n');
        expect(shouldStopGeneration(done)).toBe(true);
    });

    it('正常解析（含边界验证）不终止', () => {
        const normal = '<analysis>解得 m∈[-1,1/2)。注意：此处需验证边界点，m=-1 时 g(2)<g(1) 成立。</analysis>';
        expect(shouldStopGeneration(normal)).toBe(false);
    });

    it('尚无 analysis 内容时不终止', () => {
        expect(shouldStopGeneration('<question_text>题目</question_text>')).toBe(false);
    });
});
