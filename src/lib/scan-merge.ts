/**
 * 拍照批改的结果合并：同一道题可能被好几次识别看到。
 *
 * 三种重复来源，处理方式不同：
 *   1. **同一页相邻两段的重叠区**：段与段留了 6% 重叠，编号正好压在缝上时两边都会读到。
 *      边缘那一段很可能只拍到半个作答框，于是给出 "skip"，这不是真冲突，只是裁切噪声。
 *   2. **同一页被拍了两张**：用户重拍留下两页，同一编号出现两次，这是真重复，值得提示。
 *   3. **第二轮复核**：低置信的题会放大重读一次，两轮判定不一致必须让人看一眼。
 *
 * 所以合并规则不是「取置信度最高的那条」——那会把 skip 噪声盖到正确答案上，
 * 反过来也可能用一条边缘误读盖掉真实的 "对/错"。
 */

export type Verdict = "correct" | "wrong" | "skip";

export interface ScanHit {
    code: string;
    verdict: Verdict;
    confidence: number;
    studentAnswer: string;
    /** 来自哪一段。第一轮是 `<pageId>-<i>`，第二轮是 `<pageId>-<i>:r2` */
    stripKey: string;
    pageId: string;
    /** 第几轮识别，1 = 首轮，2 = 复核 */
    pass: 1 | 2;
}

export interface HitSource {
    stripKey: string;
    pageId: string;
    verdict: Verdict;
    confidence: number;
    pass: 1 | 2;
}

export interface MergedHit {
    code: string;
    verdict: Verdict;
    confidence: number;
    studentAnswer: string;
    sources: HitSource[];
    /** 判定在两次识别之间不一致（对 vs 错，或两轮判定不同） */
    conflict: boolean;
    /** 同一编号出现在两张不同的页 */
    multiPage: boolean;
    /** 第二轮复核推翻了首轮判定 */
    corrected: boolean;
    /** 第二轮复核维持了首轮判定，置信度已抬高 */
    verified: boolean;
    /** 首轮整条没读到，复核专门去看了一眼，确认框里是空的 */
    reviewedBlank: boolean;
}

/** 低于这个置信度的「读到笔迹」基本等于瞎猜，不值得拿来压过「空白」 */
const TRUST_NON_SKIP = 0.35;

/**
 * 给一条命中打分，用于在同编号多条记录里挑「主判定」。
 *
 * 关键的一条：**只要有一段以 ≥35% 的把握读到了笔迹，就认为这题有作答**。
 * 因为重叠区边缘那一段常常只拍到半个作答框，它会很自信地说「空白」——
 * 那是裁切造成的假象，不是真的没写。反过来，只有 20% 置信的"读到"就是瞎猜，
 * 这时宁可信「空白」。
 */
function rank(hit: ScanHit, group: ScanHit[]): number {
    if (hit.verdict === "skip") {
        const bestOther = Math.max(0, ...group.filter((h) => h.verdict !== "skip").map((h) => h.confidence));
        if (bestOther >= TRUST_NON_SKIP) return hit.confidence - 1;
    }
    return hit.confidence;
}

function dedupeSources(sources: HitSource[]): HitSource[] {
    const seen = new Set<string>();
    const out: HitSource[] = [];
    for (const s of sources) {
        const key = `${s.stripKey}|${s.pass}|${s.verdict}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

/** 把一个编号的所有命中合并成一条 */
function mergeOne(code: string, hits: ScanHit[]): MergedHit {
    const byRank = (a: ScanHit, b: ScanHit) => rank(b, hits) - rank(a, hits) || b.confidence - a.confidence;
    const sorted = [...hits].sort(byRank);
    const head = sorted[0];

    const p1 = hits.filter((h) => h.pass === 1);
    const p2 = hits.filter((h) => h.pass === 2);

    // 首轮内部：对/错同时出现才算冲突；skip 与任何一种共存都当作裁切噪声
    const p1Verdicts = new Set(p1.map((h) => h.verdict));
    const p1Clash = p1Verdicts.has("correct") && p1Verdicts.has("wrong");

    // 复核轮：与首轮主判定不同才是冲突
    const p1Best = [...p1].sort(byRank)[0];
    const p2Best = [...p2].sort(byRank)[0];
    const reviewClash = !!(p1Best && p2Best && p1Best.verdict !== p2Best.verdict);

    // 复核轮是有意重读的，冲突时以它为准，但打上冲突标记让人确认
    const verdict = p2Best ? p2Best.verdict : head.verdict;
    const fromReview = !!p2Best;

    const pages = new Set(hits.map((h) => h.pageId));

    return {
        code,
        verdict,
        confidence: fromReview
            ? reviewClash
                ? Math.min(p2Best.confidence, 0.55)
                : Math.max(p2Best.confidence, p1Best?.confidence ?? 0, 0.75)
            : head.confidence,
        studentAnswer: (fromReview && p2Best.studentAnswer ? p2Best : head).studentAnswer,
        sources: dedupeSources(hits),
        conflict: p1Clash || reviewClash,
        multiPage: pages.size > 1,
        corrected: reviewClash,
        verified: !!p2Best && !!p1Best && p2Best.verdict === p1Best.verdict,
        // 首轮没读出这道题、复核后判为空白：这不是"漏了"，是"看过，确实没写"
        reviewedBlank: !p1Best && !!p2Best && verdict === "skip",
    };
}

/** 全量合并。保持编号首次出现的顺序，页面再按题序排 */
export function mergeHits(hits: ScanHit[]): MergedHit[] {
    const groups = new Map<string, ScanHit[]>();
    for (const h of hits) {
        if (!h.code) continue;
        const list = groups.get(h.code);
        if (list) list.push(h);
        else groups.set(h.code, [h]);
    }
    return [...groups.entries()].map(([code, list]) => mergeOne(code, list));
}

/**
 * 这一条是否该让人看一眼。
 * 冲突必看；首轮低置信（且不是本地字母比对定的）也看。
 */
export function needsReview(
    hit: { conflict: boolean; confidence: number; verdict: Verdict },
    opts: { localChecked?: boolean; threshold?: number } = {},
): boolean {
    if (hit.conflict) return true;
    if (opts.localChecked) return false;
    return hit.confidence < (opts.threshold ?? 0.62);
}

/** 判定结果的中文标签，扫描页与批改页共用一套说法 */
export const VERDICT_TEXT: Record<Verdict, string> = {
    correct: "对",
    wrong: "错",
    skip: "没做",
};

/* ─────────────────────────── 复核的挑题与分组 ─────────────────────────── */

export interface ReviewPlanInput {
    /** 置信度低 / 结论打架、且已经知道来自哪一段的题 */
    uncertain: Array<{ code: string; stripKey: string | null }>;
    /** 整条都没识别出来的题，带它在打印批次里的序号 */
    missing: Array<{ code: string; order: number }>;
    /** 当前这批段，按页序、段序排列 */
    strips: Array<{ key: string }>;
    /** 这批一共几道题，用于按位置估段 */
    itemCount: number;
    maxStrips?: number;
    maxCodes?: number;
}

export interface ReviewTask {
    stripKey: string;
    codes: string[];
}

/**
 * 把要复核的题按「落在哪一段」分组，输出每段一次请求要带的编号。
 *
 * 漏识别的题位置未知，按它在这批题里的相对位置折算段序——题是按顺序印的，
 * 段也是按顺序切的，这条估算在「整页拍全」时几乎总是对的；
 * 估错也只多花一次请求，不会给出错误判定（模型在那段里找不到这个编号就不会输出）。
 */
export function planReview(input: ReviewPlanInput): ReviewTask[] {
    const maxStrips = Math.max(1, input.maxStrips ?? 4);
    const maxCodes = Math.max(1, input.maxCodes ?? 6);
    const tasks: ReviewTask[] = [];

    const attach = (stripKey: string, code: string) => {
        let task = tasks.find((t) => t.stripKey === stripKey);
        if (!task) {
            if (tasks.length >= maxStrips) return;
            task = { stripKey, codes: [] };
            tasks.push(task);
        }
        if (task.codes.length < maxCodes && !task.codes.includes(code)) task.codes.push(code);
    };

    for (const u of input.uncertain) {
        if (!u.stripKey) continue;
        if (!input.strips.some((s) => s.key === u.stripKey)) continue;
        attach(u.stripKey, u.code);
    }

    const total = input.itemCount;
    for (const m of input.missing) {
        if (!input.strips.length) break;
        const frac = total > 1 ? m.order / (total - 1) : 0.5;
        const idx = Math.min(input.strips.length - 1, Math.max(0, Math.round(frac * (input.strips.length - 1))));
        attach(input.strips[idx].key, m.code);
    }

    return tasks;
}
