export type MistakeStatus = 'correct' | 'not_attempted' | 'wrong_attempt' | 'unknown';

export function normalizeMistakeStatus(status?: unknown): MistakeStatus {
    if (
        status === 'correct' ||
        status === 'not_attempted' ||
        status === 'wrong_attempt' ||
        status === 'unknown'
    ) {
        return status;
    }
    return 'unknown';
}

export function normalizeMistakeStatusForSave(
    status?: unknown,
    wrongAnswerText?: string | null
): MistakeStatus {
    // 明确判定为「答对了」时，不被残留的学生作答文本覆盖
    if (status === 'correct') {
        return 'correct';
    }
    if ((wrongAnswerText || '').trim()) {
        return 'wrong_attempt';
    }
    return normalizeMistakeStatus(status);
}

export function getMistakeStatusLabel(status?: string | null, language: 'zh' | 'en' = 'zh') {
    const normalized = normalizeMistakeStatus(status);

    const labels = language === 'en'
        ? {
            correct: 'Correct',
            not_attempted: 'Not attempted',
            wrong_attempt: 'Wrong attempt',
            unknown: 'Unknown',
        }
        : {
            correct: '答对了',
            not_attempted: '不会做',
            wrong_attempt: '做错了',
            unknown: '未判断',
        };

    return labels[normalized];
}
