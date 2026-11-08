import { describe, expect, it } from 'vitest';
import { hasPartialContent, parsePartialXml } from '@/lib/partial-parse';

describe('parsePartialXml', () => {
    it('空字符串返回空对象', () => {
        expect(parsePartialXml('')).toEqual({});
        expect(hasPartialContent(parsePartialXml(''))).toBe(false);
    });

    it('未闭合的 question_text 也能取到已生成内容', () => {
        const raw = '<subject>数学</subject>\n<question_text>\n已知函数 f(x)=';
        const data = parsePartialXml(raw);
        expect(data.subject).toBe('数学');
        expect(data.questionText).toBe('已知函数 f(x)=');
        expect(hasPartialContent(data)).toBe(true);
    });

    it('完整标签全部解析', () => {
        const raw = [
            '<subject>数学</subject>',
            '<knowledge_points>集合, 不等式</knowledge_points>',
            '<requires_image>false</requires_image>',
            '<question_text>题干</question_text>',
            '<answer_text>B</answer_text>',
            '<analysis>解析内容</analysis>',
            '<mistake_status>correct</mistake_status>',
        ].join('\n');
        const data = parsePartialXml(raw);
        expect(data.subject).toBe('数学');
        expect(data.knowledgePoints).toEqual(['集合', '不等式']);
        expect(data.requiresImage).toBe(false);
        expect(data.questionText).toBe('题干');
        expect(data.answerText).toBe('B');
        expect(data.analysis).toBe('解析内容');
        expect(data.mistakeStatus).toBe('correct');
    });

    it('未闭合的 analysis 会一直取到末尾', () => {
        const raw = '<analysis>第一步：求解 M';
        const data = parsePartialXml(raw);
        expect(data.analysis).toBe('第一步：求解 M');
    });

    it('标签尚未出现时字段为 undefined', () => {
        const data = parsePartialXml('<subject>物理</subject>');
        expect(data.questionText).toBeUndefined();
        expect(data.answerText).toBeUndefined();
    });
});
