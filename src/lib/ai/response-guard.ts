/**
 * AI 输出护栏：防呆标签解析 + 内容清洗 + 作答判定裁决。
 *
 * 背景：模型偶发会把「自我纠错过程」和 XML 标签当作正文输出，
 * 旧解析器（indexOf 开标签 + lastIndexOf 闭标签）会把整段独白连同后续字段
 * 一起吞进错因分析，界面因此出现「先判 B 错、过一会儿又改判 B 对」。
 *
 * 本模块只含纯函数，服务端（provider / API route）与客户端组件均可安全引用。
 */

import { normalizeMistakeStatus, type MistakeStatus } from '../mistake-status';

export const AI_TAG_NAMES = [
    'subject',
    'knowledge_points',
    'requires_image',
    'question_text',
    'answer_text',
    'analysis',
    'wrong_answer_text',
    'mistake_status',
    'mistake_analysis',
] as const;

/**
 * 正文里出现内部字段名、状态枚举值或自我纠错句式，说明模型把思维链写进了输出。
 * 这些字符串不会出现在正常讲解中，可安全作为污染信号。
 */
const META_TALK_RE = /mistake_status|wrong_answer_text|mistake_analysis|answer_text|wrong_attempt|not_attempted|【最重要的工作顺序】|判定规则|重新审视规则|这是误判|必须修正|重新输出|重新判定|此前(?:的)?分析|经重新严格对照|应为\s*correct|判\s*correct|[⚠!❗][\s\ufe0f]*修正/i;

/** 形如 <tag> / </tag> 的残留标签；不匹配数学不等式里的裸 < 和 > */
const TAG_LITERAL_RE = /<\/?[a-zA-Z_][a-zA-Z0-9_]{2,30}>/;
const LEAKED_TAG_RE = new RegExp(TAG_LITERAL_RE.source, 'g');

/** 判断文本是否已被自我纠错/规则复述污染 */
export function containsMetaTalk(text?: string | null): boolean {
    return Boolean(text) && META_TALK_RE.test(text as string);
}

/** 剥离误写进正文的 XML 标签 */
export function stripLeakedTags(text: string): string {
    if (!text) return '';
    return text.replace(LEAKED_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 清洗主体内容（题目/答案/解析）：剥离残留标签，
 * 若出现自我纠错段落，则从该处截断，保留前面已经正确的解题内容。
 */
export function sanitizeBodyText(text: string): string {
    if (!text) return text;
    const stripped = stripLeakedTags(text);
    const idx = stripped.search(META_TALK_RE);
    return (idx === -1 ? stripped : stripped.slice(0, idx)).trimEnd();
}

/** 错因类字段：整体被污染时宁可留空，也不带病展示 */
export function sanitizeMistakeText(text?: string | null): string {
    if (!text) return '';
    if (META_TALK_RE.test(text)) return '';
    return stripLeakedTags(text);
}

function findNextOpenTag(tail: string): number {
    let earliest = -1;
    for (const tag of AI_TAG_NAMES) {
        const idx = tail.indexOf(`<${tag}>`);
        if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    return earliest;
}

/**
 * 防呆提取：只认第一组完整标签（开标签之后的第一个闭合标签），
 * 忽略模型后续重复输出的同名标签，避免 lastIndexOf 把中间内容整段吞入。
 *
 * @param allowTruncated 仅长文本主体字段（analysis）允许闭合标签缺失时读到末尾；
 *                       即便如此也只取到下一个已知开标签之前。
 */
export function extractTagSafe(text: string, tagName: string, allowTruncated = false): string | null {
    const open = `<${tagName}>`;
    const close = `</${tagName}>`;
    const start = text.indexOf(open);
    if (start === -1) return null;

    const contentStart = start + open.length;
    const end = text.indexOf(close, contentStart);
    if (end !== -1) return text.slice(contentStart, end).trim();

    if (!allowTruncated) return null;

    let tail = text.slice(contentStart);
    const nextOpen = findNextOpenTag(tail);
    if (nextOpen !== -1) tail = tail.slice(0, nextOpen);
    return tail.replace(/^\s*\n+/, '').trimEnd();
}

export interface MistakeFieldInput {
    answerText?: string | null;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    mistakeStatus?: string | null;
    /** 用户手动编辑/保存时，保留「未判断」状态下自行填写的错因 */
    preserveManual?: boolean;
}

export interface ReconciledMistakeFields {
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
    /** 是否发生了清洗或纠正（便于日志排查） */
    repaired: boolean;
}

const MAX_MISTAKE_ANALYSIS_LENGTH = 600;

/**
 * 选择题：学生作答是纯选项标记（(B) / B / 选B），且参考答案明确给出同一选项时，
 * 视为答对。用于纠正「AI 先把正确答案判成错误」的情形。
 */
function studentChoseCorrectOption(answerText: string, wrongAnswerText: string): boolean {
    const student = wrongAnswerText.trim();
    if (!/^(?:[（(]?\s*[A-Da-d]\s*[)）]?|选\s*[A-Da-d]|答案\s*[A-Da-d])$/.test(student)) {
        return false;
    }
    const match = student.match(/[A-Da-d]/);
    if (!match) return false;
    const letter = match[0].toUpperCase();
    const answer = answerText.trim();
    return (
        new RegExp(`(^|[\\s\\n（(])${letter}\\s*[.．、)）:：]`).test(answer) ||
        answer.toUpperCase().startsWith(`${letter} `) ||
        answer.toUpperCase() === letter
    );
}

/**
 * 独立的判定裁决层：AI 只提供候选，最终状态由这里确定。
 * - 剥离残留标签与自我纠错文本；
 * - 学生作答与参考答案一致时强制改判 correct；
 * - 答对/未判断/不会做时清空错因；
 * - 判做错却没有任何依据时降为 unknown。
 */
export function reconcileMistakeFields(input: MistakeFieldInput): ReconciledMistakeFields {
    const rawWrong = (input.wrongAnswerText || '').trim();
    const rawAnalysis = (input.mistakeAnalysis || '').trim();

    const polluted = containsMetaTalk(rawWrong) || containsMetaTalk(rawAnalysis) ||
        TAG_LITERAL_RE.test(rawWrong + rawAnalysis);

    let status = normalizeMistakeStatus(input.mistakeStatus);
    let wrong = stripLeakedTags(rawWrong);
    let analysis = stripLeakedTags(rawAnalysis);
    let repaired = polluted;

    if (polluted) {
        wrong = '';
        analysis = '';
        if (status === 'wrong_attempt') status = 'unknown';
    }

    if (input.answerText && wrong && studentChoseCorrectOption(input.answerText, wrong)) {
        status = 'correct';
        repaired = true;
    }

    if (status === 'correct' || status === 'not_attempted' ||
        (status === 'unknown' && !input.preserveManual)) {
        wrong = '';
        analysis = '';
    } else if (!wrong && !analysis) {
        status = 'unknown';
    }

    if (analysis.length > MAX_MISTAKE_ANALYSIS_LENGTH) {
        analysis = analysis.slice(0, MAX_MISTAKE_ANALYSIS_LENGTH);
        repaired = true;
    }

    return { wrongAnswerText: wrong, mistakeAnalysis: analysis, mistakeStatus: status, repaired };
}

/** 保存路径：清洗脏文本并裁决状态，但保留用户手填的内容 */
export function sanitizeMistakeForPersistence(input: MistakeFieldInput): ReconciledMistakeFields {
    return reconcileMistakeFields({ ...input, preserveManual: true });
}

/** 关闭「AI 错因分析」时，统一抹掉三个判定字段 */
export function withoutMistakeAnalysis<T extends {
    wrongAnswerText?: string;
    mistakeAnalysis?: string;
    mistakeStatus?: MistakeStatus;
}>(result: T, enabled: boolean): T {
    if (enabled) return result;
    return {
        ...result,
        wrongAnswerText: '',
        mistakeAnalysis: '',
        mistakeStatus: 'unknown',
    };
}
