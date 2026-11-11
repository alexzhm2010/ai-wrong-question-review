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
    _wrongAnswerText?: string | null
): MistakeStatus {
    // 状态只由判定结果决定。旧逻辑会在「错误解答原文」非空时无条件改成
    // wrong_attempt，导致学生答对却被误判为做错了，且 AI 事后改口 correct
    // 也覆盖不回来。保留参数仅为兼容既有调用点。
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
