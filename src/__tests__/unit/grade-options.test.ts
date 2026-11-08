import { describe, it, expect } from 'vitest';
import {
    GRADE_SEMESTER_OPTIONS,
    normalizeGradeSemester,
    isGradeSemester,
} from '@/lib/grade-options';

describe('grade-options', () => {
    it('提供 12 个初高中标准年级学期值且无重复', () => {
        expect(GRADE_SEMESTER_OPTIONS).toHaveLength(12);
        expect(new Set(GRADE_SEMESTER_OPTIONS).size).toBe(12);
        expect(GRADE_SEMESTER_OPTIONS[0]).toBe('七年级上');
        expect(GRADE_SEMESTER_OPTIONS[11]).toBe('高三下');
    });

    it('保留标准值并去除首尾空白', () => {
        expect(normalizeGradeSemester('高一上')).toBe('高一上');
        expect(normalizeGradeSemester('  高二下  ')).toBe('高二下');
        expect(isGradeSemester('九年级上')).toBe(true);
    });

    it('丢弃历史脏值「已毕业上」等无法识别的内容', () => {
        expect(normalizeGradeSemester('已毕业上')).toBe('');
        expect(normalizeGradeSemester('初一上')).toBe('');
        expect(normalizeGradeSemester('Graduated, 1st Semester')).toBe('');
        expect(isGradeSemester('已毕业上')).toBe(false);
    });

    it('空值统一返回未设置', () => {
        expect(normalizeGradeSemester(undefined)).toBe('');
        expect(normalizeGradeSemester(null)).toBe('');
        expect(normalizeGradeSemester('')).toBe('');
    });
});
