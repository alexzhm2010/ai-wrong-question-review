import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    printFileName,
    printAnswerHeading,
    getPrintPreviewCountLabel,
    getPrintPreviewEmptyState,
    getSelectedPrintItems,
    shouldReserveAnswerSpace,
} from '@/lib/print-preview';

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('print preview helpers', () => {
    const items = [
        { id: 'item-1', questionText: '题目 1' },
        { id: 'item-2', questionText: '题目 2' },
        { id: 'item-3', questionText: '题目 3' },
    ];

    it('只返回当前选中的题目，并保持原顺序', () => {
        const selected = getSelectedPrintItems(items, new Set(['item-3', 'item-1']));

        expect(selected.map((item) => item.id)).toEqual(['item-1', 'item-3']);
    });

    it('作答区只由高度决定，勾了附答案/附解析也照常留白', () => {
        expect(shouldReserveAnswerSpace(0)).toBe(false);
        expect(shouldReserveAnswerSpace(4)).toBe(true);
        expect(shouldReserveAnswerSpace(6)).toBe(true);
        expect(shouldReserveAnswerSpace(9)).toBe(true);
    });

    it('卷末标题随勾选组合变化，只勾解析时不叫参考答案', () => {
        expect(printAnswerHeading(true, false)).toBe('参考答案');
        expect(printAnswerHeading(false, true)).toBe('题目解析');
        expect(printAnswerHeading(true, true)).toBe('参考答案与解析');
    });

    it('局部选择时显示已选数量和总数量', () => {
        expect(getPrintPreviewCountLabel(88, 88)).toBe('88');
        expect(getPrintPreviewCountLabel(88, 2)).toBe('2/88');
    });

    it('区分无匹配题目和有题但未选择', () => {
        expect(getPrintPreviewEmptyState(0, 0)).toBe('noItems');
        expect(getPrintPreviewEmptyState(88, 0)).toBe('noSelection');
        expect(getPrintPreviewEmptyState(88, 2)).toBeNull();
    });
});

describe('打印页：作答区与卷末答案区的数据链路护栏', () => {
    const page = read('src/app/print-preview/page.tsx');
    const routes = read('src/lib/supabase/routes/error-items.ts');

    it('作答区不再被「附答案/附解析」开关关掉', () => {
        expect(page).toContain('shouldReserveAnswerSpace(SPACE_CM[space])');
        expect(page).not.toContain('!showAnswers && !showAnalysis');
    });

    it('两条取数路径都带 includeText，把答案/解析正文取回来', () => {
        expect((page.match(/q\.set\("includeText", "true"\)/g) || []).length).toBe(2);
        expect(routes).toContain('qget(q, "includeText")');
        expect(routes).toContain('PRINT_TEXT_FIELDS');
        const decl = routes.match(/const PRINT_TEXT_FIELDS = \[([^\]]*)\]/)?.[1] || '';
        expect(decl).toContain('answerText');
        expect(decl).toContain('analysis');
        // 轻量字段集不能把 base64 原图一次性带回，否则几十题首屏会卡死
        expect(decl).not.toContain('originalImageUrl');
    });

    it('答案区块只由开关决定，不因某几道题恰好没答案而整块消失', () => {
        expect(page).toContain('(showAnswers || showAnalysis) && total > 0');
        expect(page).not.toContain('orderedItems.some((i) => i.answerText)');
        expect(page).toContain('（暂无答案）');
        expect(page).toContain('（暂无解析）');
        expect(page).toContain('printAnswerHeading(showAnswers, showAnalysis)');
    });

    it('屏幕预览不强制分页，只有打印时另起一页', () => {
        expect(page).toContain('print:break-before-page');
        expect(page).not.toContain('border-dashed break-before-page print:break-before-page');
    });

    it('预览页除图片外所有文字统一粗体', () => {
        expect(page).toContain('wq-print-all-bold');
        const css = read('src/app/globals.css');
        expect(css).toContain('.wq-print-all-bold *');
        expect(css).toContain('font-weight: 700 !important');
    });
});

describe('打印文件名', () => {
    const at = new Date(2026, 10, 13, 20, 10, 33); // 2026-11-13 20:10:33

    it('错题本名 + 年月日时分秒', () => {
        expect(printFileName(['高二数学'], at)).toBe('高二数学_20261113_201033');
    });

    it('清掉文件名非法字符，空格换下划线', () => {
        expect(printFileName(['高二/数学: 必修*?'], at)).toBe('高二数学_必修_20261113_201033');
    });

    it('多个学科收敛成「主学科等N科」，同名去重', () => {
        expect(printFileName(['数学', '物理'], at)).toBe('数学等2科_20261113_201033');
        expect(printFileName(['数学', '数学', '物理'], at)).toBe('数学等2科_20261113_201033');
    });

    it('拿不到学科时退回通用名', () => {
        expect(printFileName([], at)).toBe('错题本_20261113_201033');
        expect(printFileName(['', '  '], at)).toBe('错题本_20261113_201033');
    });

    it('超长学科名截断到 120 字，不产生非法长文件名', () => {
        expect(printFileName(['数'.repeat(300)], at).length).toBe(120);
    });
});
