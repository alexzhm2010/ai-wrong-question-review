import { describe, expect, it } from 'vitest';
import {
    printFileName,
    getPrintPreviewCountLabel,
    getPrintPreviewEmptyState,
    getSelectedPrintItems,
    shouldReserveAnswerSpace,
} from '@/lib/print-preview';

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

    it('只有在答案和解析都不显示时才预留作答空间', () => {
        expect(shouldReserveAnswerSpace(false, false)).toBe(true);
        expect(shouldReserveAnswerSpace(true, false)).toBe(false);
        expect(shouldReserveAnswerSpace(false, true)).toBe(false);
        expect(shouldReserveAnswerSpace(true, true)).toBe(false);
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
