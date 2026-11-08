import { describe, expect, it } from 'vitest';
import {
    containsMetaTalk,
    extractTagSafe,
    reconcileMistakeFields,
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
