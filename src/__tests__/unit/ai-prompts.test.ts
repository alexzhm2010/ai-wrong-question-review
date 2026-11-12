/**
 * AI 提示词生成器单元测试
 * 测试提示词模板变量替换和生成逻辑
 */
import { describe, it, expect } from 'vitest';
import {
    generateAnalyzePrompt,
    generateSimilarQuestionPrompt,
    generateReanswerPrompt,
    generateGradeInstruction,
    gradeSemesterToDisplayName,
    gradeSemesterToGradeNumber,
    DEFAULT_ANALYZE_TEMPLATE,
    DEFAULT_SIMILAR_TEMPLATE,
    DEFAULT_REANSWER_TEMPLATE,
} from '@/lib/ai/prompts';

describe('AI Prompts', () => {
    describe('默认模板存在性', () => {
        it('应该导出 DEFAULT_ANALYZE_TEMPLATE', () => {
            expect(DEFAULT_ANALYZE_TEMPLATE).toBeDefined();
            expect(typeof DEFAULT_ANALYZE_TEMPLATE).toBe('string');
            expect(DEFAULT_ANALYZE_TEMPLATE.length).toBeGreaterThan(100);
        });

        it('应该导出 DEFAULT_SIMILAR_TEMPLATE', () => {
            expect(DEFAULT_SIMILAR_TEMPLATE).toBeDefined();
            expect(typeof DEFAULT_SIMILAR_TEMPLATE).toBe('string');
        });

        it('应该导出 DEFAULT_REANSWER_TEMPLATE', () => {
            expect(DEFAULT_REANSWER_TEMPLATE).toBeDefined();
            expect(typeof DEFAULT_REANSWER_TEMPLATE).toBe('string');
        });
    });

    describe('generateAnalyzePrompt', () => {
        it('应该生成中文提示词', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('中文');
            expect(typeof prompt).toBe('string');
        });

        it('应该生成英文提示词', () => {
            const prompt = generateAnalyzePrompt('en');
            expect(prompt).toContain('English');
            expect(typeof prompt).toBe('string');
        });

        it('应该包含学科提示（如果提供）', () => {
            const prompt = generateAnalyzePrompt('zh', null, '数学');
            expect(prompt).toContain('数学');
        });

        it('应该根据年级过滤数学标签（初一）', () => {
            const prompt = generateAnalyzePrompt('zh', 7, '数学');
            // 初一应该只包含七年级的标签
            expect(prompt).toBeDefined();
        });

        it('应该根据年级过滤数学标签（初三）', () => {
            const prompt = generateAnalyzePrompt('zh', 9, '数学');
            // 初三应该包含七、八、九年级的累进标签
            expect(prompt).toBeDefined();
        });

        it('应该根据年级过滤数学标签（高一）', () => {
            const prompt = generateAnalyzePrompt('zh', 10, '数学');
            expect(prompt).toBeDefined();
        });

        it('应该支持自定义选项 (providerHints)', () => {
            const prompt = generateAnalyzePrompt('zh', null, null, {
                providerHints: '请特别注意 LaTeX 格式',
            });
            expect(prompt).toContain('请特别注意 LaTeX 格式');
        });

        it('应该支持自定义模板', () => {
            const customTemplate = '自定义模板 {{language_instruction}}';
            const prompt = generateAnalyzePrompt('zh', null, null, {
                customTemplate,
            });
            expect(prompt).toContain('自定义模板');
            // language_instruction 会被替换为实际的语言指令（包含 Chinese）
            expect(prompt).toContain('Chinese');
        });

        it('生成的提示词不应包含未替换的变量占位符', () => {
            const prompt = generateAnalyzePrompt('zh', 8, '数学');
            // 检查常见的占位符是否已被替换
            expect(prompt).not.toContain('{{language_instruction}}');
            expect(prompt).not.toContain('{{tag_list}}');
            expect(prompt).not.toContain('{{provider_hints}}');
        });

        it('应该要求 AI 输出错因分析相关 XML 标签', () => {
            const prompt = generateAnalyzePrompt('zh', null, '数学');
            expect(prompt).toContain('<wrong_answer_text>');
            expect(prompt).toContain('<mistake_status>');
            expect(prompt).toContain('<mistake_analysis>');
            expect(prompt).toContain('wrong_attempt');
            expect(prompt).toContain('not_attempted');
            expect(prompt).toContain('unknown');
        });
    });

    describe('generateSimilarQuestionPrompt', () => {
        const originalQuestion = '已知 x + y = 5，求 x² + y² 的最小值';
        const knowledgePoints = ['一元二次方程', '最值问题'];

        it('应该生成中文类似题提示词', () => {
            const prompt = generateSimilarQuestionPrompt('zh', originalQuestion, knowledgePoints);
            expect(prompt).toContain(originalQuestion);
            expect(prompt).toContain('中文');
        });

        it('应该生成英文类似题提示词', () => {
            const prompt = generateSimilarQuestionPrompt('en', originalQuestion, knowledgePoints);
            expect(prompt).toContain(originalQuestion);
            expect(prompt).toContain('English');
        });

        it('应该包含知识点列表', () => {
            const prompt = generateSimilarQuestionPrompt('zh', originalQuestion, knowledgePoints);
            expect(prompt).toContain('一元二次方程');
            expect(prompt).toContain('最值问题');
        });

        it('应该根据难度级别调整提示词', () => {
            const easyPrompt = generateSimilarQuestionPrompt('zh', originalQuestion, knowledgePoints, 'easy');
            const hardPrompt = generateSimilarQuestionPrompt('zh', originalQuestion, knowledgePoints, 'hard');

            expect(easyPrompt.toUpperCase()).toContain('EASY');
            expect(hardPrompt.toUpperCase()).toContain('HARD');
        });

        it('应该支持所有难度级别', () => {
            const difficulties = ['easy', 'medium', 'hard', 'harder'] as const;

            difficulties.forEach(difficulty => {
                const prompt = generateSimilarQuestionPrompt('zh', originalQuestion, knowledgePoints, difficulty);
                expect(prompt).toBeDefined();
                expect(typeof prompt).toBe('string');
            });
        });

        it('默认难度应该是 MEDIUM', () => {
            const prompt = generateSimilarQuestionPrompt('zh', originalQuestion, knowledgePoints);
            expect(prompt.toUpperCase()).toContain('MEDIUM');
        });
    });

    describe('generateReanswerPrompt', () => {
        const questionText = '求解方程 2x + 3 = 7';

        it('应该生成中文重新解题提示词', () => {
            const prompt = generateReanswerPrompt('zh', questionText);
            expect(prompt).toContain(questionText);
            expect(prompt).toContain('中文');
        });

        it('应该生成英文重新解题提示词', () => {
            const prompt = generateReanswerPrompt('en', questionText);
            expect(prompt).toContain(questionText);
            expect(prompt).toContain('English');
        });

        it('应该包含学科提示（如果提供）', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '数学');
            expect(prompt).toContain('数学');
        });

        it('应该支持自定义 provider hints', () => {
            const prompt = generateReanswerPrompt('zh', questionText, null, {
                providerHints: '输出格式要求',
            });
            expect(prompt).toContain('输出格式要求');
        });

        it('生成的提示词不应包含未替换的变量占位符', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '数学');
            expect(prompt).not.toContain('{{question_text}}');
            expect(prompt).not.toContain('{{language_instruction}}');
            expect(prompt).not.toContain('{{provider_hints}}');
            expect(prompt).not.toContain('{{user_constraints}}');
        });

        it('人工补充说明应注入用户约束段，并声明优先级', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '化学', undefined, '高一上',
                '正确答案是偏低，因为俯视读数偏大');
            expect(prompt).toContain('正确答案是偏低，因为俯视读数偏大');
            expect(prompt).toContain('人工修正说明');
            expect(prompt).toContain('最高优先级');
        });

        it('锁定答案时应要求答案逐字一致、只补解析', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '化学', undefined, '高一上',
                null, '偏低');
            expect(prompt).toContain('参考答案已由用户锁定');
            expect(prompt).toContain('偏低');
            expect(prompt).toContain('禁止修改该答案');
        });

        it('无约束时用户约束段应给出无约束说明，不留下空占位', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '数学');
            expect(prompt).toContain('（无，按题目文本独立求解）');
        });

        it('重新解题提示词应该要求同步输出新的错因分析', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '数学');
            expect(prompt).toContain('<wrong_answer_text>');
            expect(prompt).toContain('<mistake_status>');
            expect(prompt).toContain('<mistake_analysis>');
            expect(prompt).toContain('重新判断');
        });

        it('重新解题提示词不应允许无依据推断学生错因', () => {
            const prompt = generateReanswerPrompt('zh', questionText, '数学');
            expect(prompt).not.toContain('推断');
            expect(prompt).toContain('不要猜测');
            expect(prompt).toContain('仅当 mistake_status = wrong_attempt');
        });
    });

    describe('模板变量替换', () => {
        it('应该正确处理多行文本', () => {
            const multiLineQuestion = `第一行
第二行
第三行`;
            const prompt = generateReanswerPrompt('zh', multiLineQuestion);
            expect(prompt).toContain('第一行');
            expect(prompt).toContain('第三行');
        });

        it('应该正确处理特殊字符', () => {
            const questionWithSpecialChars = '求解 x² + y² = r² 的圆的面积（其中 r > 0）';
            const prompt = generateReanswerPrompt('zh', questionWithSpecialChars);
            expect(prompt).toContain('x²');
            expect(prompt).toContain('r > 0');
        });
    });

    describe('gradeSemesterToDisplayName', () => {
        it('应该转换 primary_3 为 小学三年级', () => {
            expect(gradeSemesterToDisplayName('primary_3')).toBe('小学三年级');
        });

        it('应该转换 junior_high_2 为 初中二年级', () => {
            expect(gradeSemesterToDisplayName('junior_high_2')).toBe('初中二年级');
        });

        it('应该转换 senior_high_1 为 高中一年级', () => {
            expect(gradeSemesterToDisplayName('senior_high_1')).toBe('高中一年级');
        });

        it('应该转换 初一 为 初中一年级', () => {
            expect(gradeSemesterToDisplayName('初一')).toBe('初中一年级');
        });

        it('应该转换 初二上 为 初中二年级', () => {
            expect(gradeSemesterToDisplayName('初二上')).toBe('初中二年级');
        });

        it('应该转换 高一 为 高中一年级', () => {
            expect(gradeSemesterToDisplayName('高一')).toBe('高中一年级');
        });

        it('应该转换 七年级 为 初中一年级', () => {
            expect(gradeSemesterToDisplayName('七年级')).toBe('初中一年级');
        });

        it('应该转换 八年级上 为 初中二年级', () => {
            expect(gradeSemesterToDisplayName('八年级上')).toBe('初中二年级');
        });

        it('空字符串应返回 null', () => {
            expect(gradeSemesterToDisplayName('')).toBeNull();
        });

        it('无法识别的格式应返回 null', () => {
            expect(gradeSemesterToDisplayName('unknown_format')).toBeNull();
        });
    });

    describe('gradeSemesterToGradeNumber', () => {
        it('应该转换 初一 为 7', () => {
            expect(gradeSemesterToGradeNumber('初一')).toBe(7);
        });

        it('应该转换 初二 为 8', () => {
            expect(gradeSemesterToGradeNumber('初二')).toBe(8);
        });

        it('应该转换 高一 为 10', () => {
            expect(gradeSemesterToGradeNumber('高一')).toBe(10);
        });

        it('应该转换 junior_high_1 为 7', () => {
            expect(gradeSemesterToGradeNumber('junior_high_1')).toBe(7);
        });

        it('小学应返回 null', () => {
            expect(gradeSemesterToGradeNumber('primary_3')).toBeNull();
        });

        it('空字符串应返回 null', () => {
            expect(gradeSemesterToGradeNumber('')).toBeNull();
        });
    });

    describe('generateGradeInstruction', () => {
        it('无 gradeSemester 时返回空字符串', () => {
            expect(generateGradeInstruction()).toBe('');
            expect(generateGradeInstruction(null)).toBe('');
            expect(generateGradeInstruction('')).toBe('');
        });

        it('有效的 gradeSemester 应生成约束指令', () => {
            const instruction = generateGradeInstruction('初二上');
            expect(instruction).toContain('学历约束');
            expect(instruction).toContain('初中二年级');
            expect(instruction).toContain('禁止使用超纲知识');
        });

        it('无法识别的 gradeSemester 应返回空字符串', () => {
            expect(generateGradeInstruction('unknown_format')).toBe('');
        });
    });

    describe('gradeSemester 学历约束注入', () => {
        it('analyze 提示词应包含学历约束（当提供 gradeSemester 时）', () => {
            const prompt = generateAnalyzePrompt('zh', 8, '数学', undefined, '初二上');
            expect(prompt).toContain('学历约束');
            expect(prompt).toContain('初中二年级');
        });

        it('analyze 提示词不应包含学历约束（当未提供 gradeSemester 时）', () => {
            const prompt = generateAnalyzePrompt('zh', 8, '数学');
            expect(prompt).not.toContain('学历约束');
        });

        it('similar 提示词应包含学历约束（当提供 gradeSemester 时）', () => {
            const prompt = generateSimilarQuestionPrompt('zh', '1+1=?', ['算术'], 'medium', undefined, 'primary_3');
            expect(prompt).toContain('学历约束');
            expect(prompt).toContain('小学三年级');
        });

        it('similar 提示词不应包含学历约束（当未提供 gradeSemester 时）', () => {
            const prompt = generateSimilarQuestionPrompt('zh', '1+1=?', ['算术']);
            expect(prompt).not.toContain('学历约束');
        });

        it('reanswer 提示词应包含学历约束（当提供 gradeSemester 时）', () => {
            const prompt = generateReanswerPrompt('zh', '1+1=?', '数学', undefined, '高一');
            expect(prompt).toContain('学历约束');
            expect(prompt).toContain('高中一年级');
        });

        it('reanswer 提示词不应包含学历约束（当未提供 gradeSemester 时）', () => {
            const prompt = generateReanswerPrompt('zh', '1+1=?', '数学');
            expect(prompt).not.toContain('学历约束');
        });

        it('analyze 提示词不应包含未替换的 grade_instruction 占位符', () => {
            const prompt = generateAnalyzePrompt('zh', 8, '数学', undefined, '初二上');
            expect(prompt).not.toContain('{{grade_instruction}}');
        });
    });

    describe('回归：空白题被幻觉出「学生作答 / 标准答案」', () => {
        // 原题图片只有印刷题干与空白横线，模型却虚构了学生答案 + 红叉 + 权威标准答案，
        // 进而推翻自己正确的结论。根因是提示词无条件预设图片里一定有手写与作答。
        const templates = [DEFAULT_ANALYZE_TEMPLATE, DEFAULT_REANSWER_TEMPLATE];

        it('不再无条件预设图片里一定有手写、红笔或勾叉', () => {
            templates.forEach(tpl => {
                expect(tpl).not.toContain('忽略图片中的手写、勾画、红笔批注与对勾/叉号');
                expect(tpl).not.toContain('图片中的学生作答、批注、对勾/叉号不作为解题依据');
                expect(tpl).toContain('若图片中存在');
            });
        });

        it('空白题直接判 not_attempted，明确禁止臆测学生作答', () => {
            templates.forEach(tpl => {
                expect(tpl).toContain('空白横线');
                expect(tpl).toContain('直接判为 not_attempted');
                expect(tpl).toContain('严禁臆测');
            });
        });

        it('自检只做一次并锁定结论，禁止引用标准答案 / 权威解法', () => {
            templates.forEach(tpl => {
                expect(tpl).toContain('自检只做一次，通过后即锁定结论');
                expect(tpl).toContain('标准答案');
                expect(tpl).toContain('权威解法');
                expect(tpl).not.toContain('不通过就重新求解');
                expect(tpl).not.toContain('不通过则重新求解');
            });
        });

        it('输出纪律明确禁止虚构答案与外部比对措辞', () => {
            templates.forEach(tpl => {
                expect(tpl).toContain('严禁出现「标准答案」「权威解法」「查资料」「学生填的是」「红叉」');
            });
        });

        it('输出纪律禁止结论后的自我怀疑、警示与回头重算', () => {
            templates.forEach(tpl => {
                expect(tpl).toContain('与预期相反');
                expect(tpl).toContain('与直觉矛盾');
                expect(tpl).toContain('再仔细检查方向');
                expect(tpl).toContain('解析一次成型');
                expect(tpl).toContain('结论写出后立即收尾');
            });
        });

        it('空白题整段跳过作答判定输出，不补写空标签', () => {
            templates.forEach(tpl => {
                expect(tpl).toContain('整段跳过作答判定输出');
                expect(tpl).toContain('不输出下面三个判定标签');
                expect(tpl).toContain('仅在图片确有作答痕迹时输出');
                expect(tpl).toContain('空白题可整段省略最后三个作答判定标签');
            });
        });

        it('默认生成的提示词仍保留三个判定标签供确有作答时使用', () => {
            const prompts = [
                generateAnalyzePrompt('zh', null, '数学'),
                generateReanswerPrompt('zh', '已知……求取值范围', '数学'),
            ];
            prompts.forEach(prompt => {
                expect(prompt).toContain('<wrong_answer_text>');
                expect(prompt).toContain('<mistake_status>');
                expect(prompt).toContain('<mistake_analysis>');
            });
        });
    });

    describe('表格处理指令', () => {
        it('analyze 提示词应包含表格处理规则', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('表格处理规则');
            expect(prompt).toContain('Markdown 表格语法');
        });

        it('表格处理规则应包含标准表格示例', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('| 列标题1 | 列标题2 | 列标题3 |');
            expect(prompt).toContain('|---------|---------|---------|');
        });

        it('表格处理规则应包含复杂表格处理说明', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('复杂表格');
            expect(prompt).toContain('合并单元格');
            expect(prompt).toContain('多级表头');
        });

        it('表格处理规则应要求完整性', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('表格完整性要求');
            expect(prompt).toContain('必须转录所有单元格内容');
            expect(prompt).toContain('保留表格标题、单位、注释');
        });

        it('表格处理规则应包含特殊情况处理', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('特殊情况处理');
            expect(prompt).toContain('手写表格');
            expect(prompt).toContain('模糊表格');
        });

        it('answer_text 应引用表格处理规则', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('<answer_text>');
            expect(prompt).toMatch(/<answer_text>[\s\S]*表格处理规则[\s\S]*<\/answer_text>/);
        });

        it('analysis 应引用表格处理规则', () => {
            const prompt = generateAnalyzePrompt('zh');
            expect(prompt).toContain('<analysis>');
            expect(prompt).toMatch(/<analysis>[\s\S]*表格处理规则[\s\S]*<\/analysis>/);
        });
    });
});
