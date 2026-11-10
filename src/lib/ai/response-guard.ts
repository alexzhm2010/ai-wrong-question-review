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

/**
 * 「解题式思维链」信号：模型把反复验算、自我怀疑、揣测标准答案、
 * 评论学生作答的过程写进 <analysis> 正文。这类表述单独出现时可能只是
 * 正常讲解（如「我们再看第二步」「对照标准答案验证端点」），因此要求
 * 同时命中 ≥2 类信号才判定为污染，避免把合法解析误截断。
 */
const COT_SIGNAL_RES: RegExp[] = [
    /但等等|等等[！!]|哦[！!]关键|重新审视|犯了一个错误|漏了关键|说明我们|这矛盾|可能.{0,12}有误/,
    /标准答案|权威解法|许多资料|多份.{0,8}(?:模拟题|高考题|试卷)|常见答案/,
    /我们作为专家|我意识到|我们再(?:查|仔细验算)|查权威|再查多份|然而，很多/,
    /学生填的是|且有红叉|题目图片中学生/,
    /为何答案写成|但为什么|为什么.{0,12}答案写成|为何.{0,12}答案/,
];

/**
 * 「结论后自我怀疑」信号：解析已经写出结论（或中途算出结果），
 * 却又追加转折、警示，宣称与直觉/预期矛盾，要求回头重算方向。
 * 这类是模型写给自己看的元话语，不会出现在规范解析里——
 * 规范的边界核验会说「代入端点验证」，不会说「与直觉矛盾，再检查方向」。
 * 与 COT_SIGNAL_RES 不同：每条都是强否定信号，单条命中即可处理。
 */
const SELF_DOUBT_RES: RegExp[] = [
    /与[^。；\n]{0,6}(?:直觉|预期|常识)[^。；\n]{0,10}(?:矛盾|相反|不符|冲突|对不上)/,
    /(?:这个|上述|前面(?:的)?)?(?:结果|结论)[^。；\n]{0,14}(?:与[^。；\n]{0,10}(?:相反|矛盾)|(?:可能|似乎|好像)[^。；\n]{0,8}(?:相反|有误|不对|有问题|错了))/,
    /(?:可能|似乎|好像)[^。；\n]{0,6}(?:相反|搞反|弄反|有问题|有误)/,
    /(?:然而|但是|但|不过)[^。；\n]{0,36}(?:再|重新)[^。；\n]{0,10}(?:检查|审视|验算|核对|推导|求解|考虑)/,
    /(?:再|重新)(?:仔细)?(?:检查|审视|验算|核对|推导)[^。；\n]{0,12}(?:方向|单调性|是否|一遍|一下|有没有|对不对)/,
    /(?:需|要|得)(?:重新|再)[^。；\n]{0,8}(?:检查|审视|验算|核对|推导|求解)/,
    /[⚠❗][^。；\n]{0,8}(?:注意|小心|警告)[^。；\n]{0,36}(?:相反|矛盾|可能|是否|遗漏|有误|不对)/,
    /(?:推翻|否定|怀疑)[^。；\n]{0,10}(?:前面|上述|自己|刚(?:才)?|已(?:经)?)[^。；\n]{0,10}(?:结论|推导|结果)/,
];

/** 是否出现了成段的解题式思维链（≥2 类信号才算，避免误伤） */
export function containsChainOfThought(text?: string | null): boolean {
    if (!text) return false;
    return COT_SIGNAL_RES.filter((re) => re.test(text as string)).length >= 2;
}

/** 是否出现了零散的自我怀疑 / 要求回头重算的元话语 */
export function containsSelfDoubt(text?: string | null): boolean {
    if (!text) return false;
    return SELF_DOUBT_RES.some((re) => re.test(text as string));
}

/** 最早一处思维链信号的位置，用于保留前面已经正确的推导 */
function firstChainOfThoughtIndex(text: string): number {
    let earliest = -1;
    for (const re of COT_SIGNAL_RES) {
        const idx = text.search(re);
        if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
    }
    return earliest;
}

/**
 * 逐句剔除自我怀疑句，而不是从该处整体截断。
 * 这类警告常出现在推导中途（例如刚解出 m<1/2 就插一句「与预期相反」），
 * 若直接截断会把它后面正确的定义域推导与最终结论一起砍掉。
 * 按行 + 句末标点切分，只丢命中的那一句，保留其余有效推导。
 */
function stripSelfDoubtSentences(text: string): string {
    return text
        .split('\n')
        .flatMap((line) => {
            if (line.trim() === '') return ['']; // 保留原本就有的分段空行
            const sentences = line.match(/[^。；]*[。；]+|[^。；]+$/g) || [line];
            const kept = sentences
                .filter((sentence) => !SELF_DOUBT_RES.some((re) => re.test(sentence)))
                .join('');
            // 整行都是污染句时整行丢掉，避免留下孤立空行
            return kept.trim() === '' ? [] : [kept];
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

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
 * 按污染形态分三级处理，始终保留前面/后面已经正确的解题内容：
 * 1) 规则复述与自我纠错独白 —— 从这里起都是污染，直接截断；
 * 2) 成段思维链（≥2 类信号） —— 从第一处改口截断；
 * 3) 零散的自我怀疑句 —— 逐句剔除，不截断（它常夹在正确推导中间）。
 */
export function sanitizeBodyText(text: string): string {
    if (!text) return text;
    const stripped = stripLeakedTags(text);

    const metaIdx = stripped.search(META_TALK_RE);
    if (metaIdx !== -1) return stripped.slice(0, metaIdx).trimEnd();

    if (containsChainOfThought(stripped)) {
        const cotIdx = firstChainOfThoughtIndex(stripped);
        // 前面已有实质推导时才截断，避免把整段解析砍成空串
        if (cotIdx > 0) return stripped.slice(0, cotIdx).trimEnd();
    }

    if (containsSelfDoubt(stripped)) return stripSelfDoubtSentences(stripped);

    return stripped.trimEnd();
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

    // 先用「学生作答」这个客观证据裁决：即使错因文本被污染，
    // 学生写的 (B) 与参考答案 B 一致时也应改判为答对了。
    if (input.answerText && wrong && !containsMetaTalk(rawWrong) &&
        studentChoseCorrectOption(input.answerText, wrong)) {
        status = 'correct';
        repaired = true;
    }

    if (polluted) {
        wrong = '';
        analysis = '';
        if (status === 'wrong_attempt') status = 'unknown';
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

/**
 * 判定段是否被「整段跳过」。
 *
 * 空白题时提示词要求模型不输出三个作答判定标签，也不在解析里讨论学生作答，
 * 从源头掐掉「为了填判定而虚构学生答案 / 标准答案」的诱因。
 * 仅当 <analysis> 已正常闭合时才认定，避免把输出被截断误判成空白题。
 */
export function verdictSectionOmitted(text: string): boolean {
    if (!text || !text.includes('</analysis>')) return false;

    const status = extractTagSafe(text, 'mistake_status');
    if (status !== null && status.trim() !== '') return false;

    const wrong = extractTagSafe(text, 'wrong_answer_text');
    const analysis = extractTagSafe(text, 'mistake_analysis');
    return !wrong?.trim() && !analysis?.trim();
}

/**
 * 从原始 AI 响应解析作答判定字段，三个 provider 共用。
 * 判定段被省略时直接落为 not_attempted + 空错因，
 * 不再让模型为补齐标签而编造学生作答。
 */
export function parseMistakeFieldsFromResponse(
    text: string,
    extract: (tagName: string) => string | null,
    answerText: string
): ReconciledMistakeFields {
    return reconcileMistakeFields({
        answerText,
        wrongAnswerText: extract('wrong_answer_text'),
        mistakeAnalysis: extract('mistake_analysis'),
        mistakeStatus: verdictSectionOmitted(text) ? 'not_attempted' : extract('mistake_status'),
    });
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

/**
 * 流式生成是否应提前终止（token 经济性）。
 *
 * 百炼计费规则：请求中断时，输出 Token 只计算服务端收到终止请求前已生成的部分，
 * 所以掐断「结论已给出却又开始自我怀疑、无限重算」的循环能实打实省下预算。
 *
 * 触发条件刻意收紧为「解析里已有明确结论」+「出现自我怀疑 / 成段思维链」：
 * 中途那句警告之后往往还有正确的定义域推导与最终答案，过早中断反而会丢内容。
 * 本次实测样本正是在写完 m∈[-1,1/2) 之后才出现「然而，这与直觉矛盾」，
 * 在这一刻停止，既保住正确答案，又省掉后续整段重算。
 */
export function shouldStopGeneration(text: string): boolean {
    if (!text) return false;
    const analysis = extractTagSafe(text, 'analysis', true);
    if (!analysis || analysis.length < 40) return false;

    const hasConclusion = /(?:∈\s*\[|取值范围(?:是|为)|综上|故答案为|最终答案|所以[^。；\n]{0,24}得)/.test(analysis);
    if (!hasConclusion) return false;

    return containsSelfDoubt(analysis) || containsChainOfThought(analysis);
}
