import { describe, expect, it } from 'vitest';
import {
    getMistakeStatusLabel,
    normalizeMistakeStatus,
    normalizeMistakeStatusForSave,
} from '@/lib/mistake-status';

describe('mistake status helpers', () => {
    it('应该只接受合法作答状态', () => {
        expect(normalizeMistakeStatus('wrong_attempt')).toBe('wrong_attempt');
        expect(normalizeMistakeStatus('not_attempted')).toBe('not_attempted');
        expect(normalizeMistakeStatus('unknown')).toBe('unknown');
        expect(normalizeMistakeStatus('invalid')).toBe('unknown');
        expect(normalizeMistakeStatus(null)).toBe('unknown');
    });

    it('保存时不再因错误解答文本把状态强推为做错了', () => {
        // 学生答对却被摘录 (B) 时，旧逻辑会误判为 wrong_attempt
        expect(normalizeMistakeStatusForSave('unknown', 'x = 4')).toBe('unknown');
        expect(normalizeMistakeStatusForSave('correct', '(B)')).toBe('correct');
    });

    it('保存时不应仅因为错因分析有内容就覆盖作答状态', () => {
        expect(normalizeMistakeStatusForSave('not_attempted', '')).toBe('not_attempted');
        expect(normalizeMistakeStatusForSave('unknown', '')).toBe('unknown');
    });

    it('保存时缺省或非法状态应保持未判断而不是误判为不会做', () => {
        expect(normalizeMistakeStatusForSave(undefined, '')).toBe('unknown');
        expect(normalizeMistakeStatusForSave('bad-value', '')).toBe('unknown');
    });

    it('判定答对时不应被残留的学生答案覆盖为做错了', () => {
        expect(normalizeMistakeStatus('correct')).toBe('correct');
        expect(normalizeMistakeStatusForSave('correct', 'B. (1/4, +∞)')).toBe('correct');
        expect(normalizeMistakeStatusForSave('correct', '')).toBe('correct');
    });

    it('应该按语言显示状态标签', () => {
        expect(getMistakeStatusLabel('wrong_attempt', 'zh')).toBe('做错了');
        expect(getMistakeStatusLabel('correct', 'zh')).toBe('答对了');
        expect(getMistakeStatusLabel('not_attempted', 'en')).toBe('Not attempted');
        expect(getMistakeStatusLabel('bad-value', 'zh')).toBe('未判断');
    });
});
