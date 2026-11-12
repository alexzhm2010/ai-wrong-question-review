export type ReanswerRequestBody = {
    questionText: string;
    language: 'zh' | 'en';
    subject: string;
    imageBase64?: string;
    gradeSemester?: string;
    /** 本题的思考深度：deep=深度思考，fast=关闭思考 */
    reasoningMode?: 'deep' | 'fast';
    /** 人工纠错说明：用户给出的正确结论 / 必须采用的方法，优先级高于模型自身判断 */
    guidance?: string;
    /** 锁定答案：模型不得改动参考答案，只补解析 */
    lockedAnswerText?: string;
};

export function buildReanswerRequestBody({
    questionText,
    language,
    subject,
    imagePreview,
    gradeSemester,
    reasoningMode,
    guidance,
    lockedAnswerText,
}: {
    questionText: string;
    language: 'zh' | 'en';
    subject: string;
    imagePreview?: string | null;
    gradeSemester?: string;
    reasoningMode?: 'deep' | 'fast';
    guidance?: string;
    lockedAnswerText?: string;
}): ReanswerRequestBody {
    const requestBody: ReanswerRequestBody = {
        questionText,
        language,
        subject,
    };

    if (imagePreview) {
        requestBody.imageBase64 = imagePreview;
    }

    if (gradeSemester) {
        requestBody.gradeSemester = gradeSemester;
    }

    if (reasoningMode) {
        requestBody.reasoningMode = reasoningMode;
    }

    if (guidance?.trim()) {
        requestBody.guidance = guidance.trim();
    }

    if (lockedAnswerText?.trim()) {
        requestBody.lockedAnswerText = lockedAnswerText.trim();
    }

    return requestBody;
}
