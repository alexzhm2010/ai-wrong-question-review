export type ReanswerRequestBody = {
    questionText: string;
    language: 'zh' | 'en';
    subject: string;
    imageBase64?: string;
    gradeSemester?: string;
    /** 本题的思考深度：deep=深度思考，fast=关闭思考 */
    reasoningMode?: 'deep' | 'fast';
};

export function buildReanswerRequestBody({
    questionText,
    language,
    subject,
    imagePreview,
    gradeSemester,
    reasoningMode,
}: {
    questionText: string;
    language: 'zh' | 'en';
    subject: string;
    imagePreview?: string | null;
    gradeSemester?: string;
    reasoningMode?: 'deep' | 'fast';
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

    return requestBody;
}
