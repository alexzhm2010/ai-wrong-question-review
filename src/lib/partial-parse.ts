/**
 * 流式增量解析：在 AI 还在输出 XML 标签时，尽可能提前取出已完成/正在生成的字段。
 * 用于「边接收边填充」的界面，不保证字段完整或合法。
 *
 * 注意：题目/答案/解析需要逐字呈现，所以允许未闭合时读到当前末尾；
 * 但会截断到下一个已知开标签之前，避免模型跑偏时把后续字段吞进来。
 */
import { AI_TAG_NAMES, containsMetaTalk, stripLeakedTags } from './ai/response-guard';

export interface PartialParsed {
    subject?: string;
    knowledgePoints?: string[];
    requiresImage?: boolean;
    questionText?: string;
    answerText?: string;
    analysis?: string;
    wrongAnswerText?: string;
    mistakeAnalysis?: string;
    mistakeStatus?: string;
}

function findNextOpenTag(tail: string): number {
    let earliest = -1;
    for (const tag of AI_TAG_NAMES) {
        const idx = tail.indexOf(`<${tag}>`);
        if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    return earliest;
}

/** 取出某个标签的内容；若闭合标签还没到，返回从开标签到下一个开标签之前的未完成内容 */
function extractPartial(text: string, tag: string): string | undefined {
    const open = `<${tag}>`;
    const start = text.indexOf(open);
    if (start === -1) return undefined;
    const contentStart = start + open.length;
    const close = `</${tag}>`;
    const end = text.indexOf(close, contentStart);

    let raw = end === -1 ? text.slice(contentStart) : text.slice(contentStart, end);
    if (end === -1) {
        // 未闭合时只取到下一个已知开标签之前，防止吞掉后续字段
        const nextOpen = findNextOpenTag(raw);
        if (nextOpen !== -1) raw = raw.slice(0, nextOpen);
    }
    raw = raw.replace(/^\s*\n+/, '');

    // 错因类字段一旦出现自我纠错独白或裸标签，流式阶段直接不展示
    if (tag === 'mistake_analysis' || tag === 'wrong_answer_text') {
        if (containsMetaTalk(raw)) return '';
        return stripLeakedTags(raw);
    }
    return raw;
}

export function parsePartialXml(text: string): PartialParsed {
    if (!text) return {};
    const result: PartialParsed = {};

    const subject = extractPartial(text, "subject");
    if (subject && subject.trim()) result.subject = subject.trim();

    const kp = extractPartial(text, "knowledge_points");
    if (kp !== undefined) {
        result.knowledgePoints = kp
            .split(/[,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    const requiresImage = extractPartial(text, "requires_image");
    if (requiresImage !== undefined) {
        result.requiresImage = requiresImage.trim().toLowerCase().startsWith("true");
    }

    const questionText = extractPartial(text, "question_text");
    if (questionText !== undefined) result.questionText = questionText;

    const answerText = extractPartial(text, "answer_text");
    if (answerText !== undefined) result.answerText = answerText;

    const analysis = extractPartial(text, "analysis");
    if (analysis !== undefined) result.analysis = analysis;

    const wrongAnswerText = extractPartial(text, "wrong_answer_text");
    if (wrongAnswerText !== undefined) result.wrongAnswerText = wrongAnswerText;

    const mistakeAnalysis = extractPartial(text, "mistake_analysis");
    if (mistakeAnalysis !== undefined) result.mistakeAnalysis = mistakeAnalysis;

    const mistakeStatus = extractPartial(text, "mistake_status");
    if (mistakeStatus !== undefined) result.mistakeStatus = mistakeStatus.trim();

    return result;
}

/** 是否已经收到了任何可展示的字段 */
export function hasPartialContent(data: PartialParsed): boolean {
    return Boolean(
        data.questionText ||
        data.answerText ||
        data.analysis ||
        data.mistakeAnalysis ||
        data.wrongAnswerText
    );
}
