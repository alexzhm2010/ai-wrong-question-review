/**
 * 今日复习卷：从错题里挑「今天最该做」的一小批。
 *
 * 排序由「掌握得怎么样 + 多久没碰」决定，人话规则：
 *   1. 已经掌握的（连续答对 ≥2 次）——直接不进候选，除非后来又答错让 streak 归零；
 *   2. 掌握度越差越优先：待攻克 > 巩固中 > 未开始；
 *   3. 越久没做越优先：距上次作答按 60 天线性计分，不再 30 天就封顶；
 *      从没做过的题另算「入库时长」分，且权重刻意低，避免新题挤掉真错题；
 *   4. 换一批时叠加 ±20 分抖动，保证分差大的题也能被换掉。
 * 选完再做一次知识点去重，避免整张卷子五道题都是同一个考点。
 *
 * 【做错题的间隔重做（2026-11-21 新增）】
 *   上次做错（lastResult=wrong）的题不立刻重做，而是「隔一周以上」再安排：
 *   - 每道题按自己的 id 稳定地映射到一个 [WRONG_REDO_MIN_DAYS, MIN+SPREAD] 天的
 *     随机到期日；到期前处于冷却期，不进今日卷；到期后恢复原打分自然获得高优先级。
 *   - 随机到期日让不同错题分散到不同日期，加上「单卷重做题上限」，避免一堆错题
 *     扎堆进同一张卷子。同一道题的到期日恒定（只依赖 id + 上次作答时间），不会因
 *     换一批或刷新页面而漂移。
 *   这条规则只作用于「上次做错」的题；没做过、已掌握的题行为不变。
 *
 * 【做对题的长冷却 + 分层优先级（2026-11-23 新增）】
 *   做对过的题（lastResult=correct）不再隔几天就被抽到：
 *   - 按题目 id 稳定映射到 [CORRECT_REDO_MIN_DAYS, MIN+SPREAD] 天的到期日（14~21 天），
 *     到期前处于长冷却，不进今日卷；
 *   - 选题按「没做过 > 做错到期 > 做对到期」分层：优先补新题与真错题，
 *     只有这两类都不足以凑满一卷时，才用已到期（≥14 天）的做对题兜底；
 *   - 连续答对 ≥2 次的题仍按原规则永久移出（isMastered），不受本条影响。
 *
 * 【到期错题保底（2026-11-26 新增）】
 *   仅靠分层优先级时，若「没做过」的新题数量就超过卷子容量，tier 1（做错到期）
 *   会被整层挤掉，导致错题再也没有重做机会。因此主选择前先单独挑一轮到期错题，
 *   占住 redoCap（约 1/3）的名额，剩余位置才交给新题：
 *   - 冷却期规则一律不变：tier 4（做错未满 7~14 天）仍被彻底排除，
 *     tier 3（做对未满 14~21 天）仍只在题库见底时兜底；
 *   - 保底只给「已到期」的错题，不会让冷却中的错题提前出现；
 *   - redoCap 同时是单卷错题硬上限，保底不会让错题扎堆到一张卷里。
 *
 * 【已安排未批改题的降权（2026-11-26 新增）】
 *   冷却只看 lastAttemptAt（真实作答时间），但「生成了卷子却没打印/没批改」的题
 *   lastAttemptAt 不会更新，于是同一批到期错题会连续多天霸占推荐。
 *   解法：调用方传入 scheduledAt（每道题最近一次被安排进卷的时间）。若某题
 *   scheduledAt 晚于它的 lastAttemptAt，说明「安排后还没作答」，把它压到最后兜底，
 *   只有其它题都不够时才用。冷却规则本身完全不动，只影响同批题的出场顺序/机会。
 */

import { isArchived, knowledgeNames } from "./mastery";

const DAY = 86_400_000;

/**
 * 做错题的最小重做间隔（天）：上次做错后，至少隔这么多天才重新进今日卷。
 * 用户要求「间隔大于一周」，取 7 天为下限；配合下面的随机_SPREAD 一定 > 7 天。
 */
export const WRONG_REDO_MIN_DAYS = 7;
/**
 * 在最小间隔之上叠加的随机天数区间（天）。
 * 每道题按 id 得到 [0, SPREAD) 的稳定随机值，到期日落在第 7~14 天之间，
 * 于是不同错题分散到不同日期，不会全部在同一天到期、扎堆进一张卷。
 */
export const WRONG_REDO_SPREAD_DAYS = 7;

/**
 * 做对题的最小重做间隔（天）：上次做对后，至少隔这么多天才可能被再次选中。
 * 用户要求「大于 14 天」，取 14 天为下限；配合随机 SPREAD 一定 > 14 天。
 */
export const CORRECT_REDO_MIN_DAYS = 14;
/**
 * 做对题在最小间隔之上叠加的随机天数区间（天）。
 * 每道题按 id 得到 [0, SPREAD) 的稳定随机值，到期日落在第 14~21 天之间，
 * 不同题分散到不同日期。且即便到期，也只是「最后兜底」优先级（见 pickReview 分层）。
 */
export const CORRECT_REDO_SPREAD_DAYS = 7;

export interface ReviewCandidate {
    id: string;
    wrongCount?: number | null;
    correctCount?: number | null;
    correctStreak?: number | null;
    masteryLevel?: number | null;
    lastResult?: string | null;
    lastAttemptAt?: string | null;
    createdAt?: string | null;
    tags?: Array<{ name?: string }>;
    knowledgePoints?: string | null;
}

export interface ReviewPick<T> {
    item: T;
    score: number;
    reason: string;
    daysSince: number | null;
}

/** 稳定的小抖动：同一个 seed 每次结果一样，换 seed 就换一批 */
function jitter(id: string, seed: number): number {
    let h = seed * 2654435761;
    for (let i = 0; i < id.length; i++) h = (h ^ id.charCodeAt(i)) * 16777619;
    return ((h >>> 0) % 1000) / 1000; // 0~1
}

/**
 * 按题目 id 算一个稳定的 0~1 随机值（与 seed 无关）。
 * 同一个 id 永远得到同一个值，所以某题的「重做到期日」不会因换一批/刷新而漂移；
 * 不同 id 均匀铺开，落到不同的到期日。用 FNV-1a 风格散列，分布足够均匀。
 */
function stableUnit(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
        h = (h ^ id.charCodeAt(i)) * 16777619;
    }
    return ((h >>> 0) % 10000) / 10000; // 0~0.9999
}

/** 这道题上次做错后，重做的间隔天数（含随机，恒 > 7 天） */
export function wrongRedoDelayDays(id: string): number {
    return WRONG_REDO_MIN_DAYS + stableUnit(id) * WRONG_REDO_SPREAD_DAYS;
}

/**
 * 一道「上次做错」的题，距离可以重做还差多少天。
 *   - 返回 null：这不是「上次做错」的题（做对/没做过/缺时间），不受间隔规则约束；
 *   - 返回 > 0：还在冷却期，还剩这么多天才到期（不应进今日卷）；
 *   - 返回 ≤ 0：已到期，可以重做。
 */
export function wrongRedoRemainingDays(
    item: ReviewCandidate,
    now: number = Date.now(),
): number | null {
    if (item.lastResult !== "wrong") return null;
    const lastAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : NaN;
    if (!Number.isFinite(lastAt)) return null;
    const delay = wrongRedoDelayDays(item.id) * DAY;
    return (lastAt + delay - now) / DAY;
}

/** 是否处于「做错后未满一周」的冷却期——冷却期内不进今日卷 */
export function isWrongRedoCoolingDown(
    item: ReviewCandidate,
    now: number = Date.now(),
): boolean {
    const remaining = wrongRedoRemainingDays(item, now);
    return remaining !== null && remaining > 0;
}

/** 这道题上次做对后，重做的间隔天数（含随机，恒 > 14 天） */
export function correctRedoDelayDays(id: string): number {
    return CORRECT_REDO_MIN_DAYS + stableUnit(id) * CORRECT_REDO_SPREAD_DAYS;
}

/**
 * 一道「上次做对」的题，距可以重做还差多少天。
 *   - null：不是「上次做对」的题（做错/没做过/缺时间），不受本规则约束；
 *   - > 0：仍在长冷却期（不应进今日卷，除非题库完全空）；
 *   - ≤ 0：已到期，可作为最后兜底被选中。
 */
export function correctRedoRemainingDays(
    item: ReviewCandidate,
    now: number = Date.now(),
): number | null {
    if (item.lastResult !== "correct") return null;
    const lastAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : NaN;
    if (!Number.isFinite(lastAt)) return null;
    const delay = correctRedoDelayDays(item.id) * DAY;
    return (lastAt + delay - now) / DAY;
}

/** 是否处于「做对后未满 14~21 天」的长冷却期 */
export function isCorrectRedoCoolingDown(
    item: ReviewCandidate,
    now: number = Date.now(),
): boolean {
    const remaining = correctRedoRemainingDays(item, now);
    return remaining !== null && remaining > 0;
}

/**
 * 题目的选题分层（数字越小越优先）。做错与做对的冷却是两套不同规则，必须分开：
 *   0 = 没做过（新题，最优先）
 *   1 = 做错过且已到期（真错题，次优先）
 *   2 = 做对过且已到期（14~21 天长冷却之后，正常候选）
 *   3 = 做对冷却期（上次做对未满 14~21 天）——最后兜底：前面全都不够才用
 *   4 = 做错冷却期（上次做错未满 7~14 天）——完全排除，不进今日卷
 * 用户原话「14 天内实在没题可选才选它」专指做对题（层 3）；做错题（层 4）沿用
 * 原有 7 天冷却规则，冷却期内一律不出现（不会"没题可选就破例选错题"）。
 * 已掌握/归档的题不在此列，由 pickReview 硬排除。
 */
export const TIER_CORRECT_COOLDOWN = 3;
export const TIER_WRONG_COOLDOWN = 4;

export function reviewTier(item: ReviewCandidate, now: number = Date.now()): number {
    if (!item.lastResult) return 0; // 从没作答过
    if (item.lastResult === "wrong") {
        return isWrongRedoCoolingDown(item, now) ? TIER_WRONG_COOLDOWN : 1;
    }
    if (item.lastResult === "correct") {
        return isCorrectRedoCoolingDown(item, now) ? TIER_CORRECT_COOLDOWN : 2;
    }
    return 0;
}

/** 连续答对 ≥2 次视为已掌握：不再进今日卷，答错后 streak 归零自动回归 */
export function isMastered(item: ReviewCandidate): boolean {
    return Number(item.correctStreak || 0) >= 2;
}

export function scoreItem(
    item: ReviewCandidate,
    now: number = Date.now(),
): { score: number; reason: string; daysSince: number | null } {
    const wc = Number(item.wrongCount || 0);
    const cc = Number(item.correctCount || 0);
    const streak = Number(item.correctStreak || 0);
    const attempts = wc + cc;

    const lastAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : NaN;
    const hasAttemptAt = Number.isFinite(lastAt);
    const daysSince = hasAttemptAt ? Math.max(0, (now - lastAt) / DAY) : null;
    const created = item.createdAt ? Date.parse(item.createdAt) : NaN;
    const ageDays = Number.isFinite(created) ? Math.max(0, (now - created) / DAY) : 0;

    let score = 0;

    // ① 掌握度档位分：待攻克 > 巩固中 > 未开始。已掌握由 pickReview 硬排除，不在这里给分。
    if (streak >= 2) {
        score -= 200; // 双保险：即便直接调用 scoreItem，也已掌握的也沉到最底
    } else if (streak === 1) {
        score += 6; // 巩固中：刚答对一次，还差一次确认
    } else if (attempts > 0) {
        score += 24; // 待攻克：做过但还没连续答对两次，最该练
    } else {
        score += 4; // 未开始：入库后一次都没做过
    }

    // ② 错次分：历史错得越多越优先（掌握度已由档位分兜底，这里只做细分）
    score += wc * 9;
    if (cc === 0 && attempts > 0) score += 16; // 做过但从没对过，最扎心

    // ③ 时间分：按最近一次作答拆成两路
    if (hasAttemptAt && daysSince !== null) {
        // 做过的：越久没碰越该练，线性计到 60 天（封顶 96 分）
        score += Math.min(daysSince, 60) * 1.6;
    } else {
        // 从没做过的：只按入库时长给低权重分（封顶约 18 分），不再拿「30 天」那份满额
        score += Math.min(ageDays, 30) * 0.6;
    }

    // ④ 最近一次结果
    if (item.lastResult === "wrong") score += 18;
    if (item.lastResult === "correct") score -= 6;

    let reason: string;
    if (streak >= 2) {
        reason = "最近连续答对 2 次，已掌握";
    } else if (item.lastResult === "skip") {
        // 上次是「未做/跳过」：只留痕、不计对错，提醒补做而不是说"入库没做"
        reason = daysSince !== null && daysSince >= 1
            ? `上次跳过没做，已隔 ${Math.round(daysSince)} 天，补做一次`
            : "上次跳过没做，补做一次";
    } else if (attempts === 0) {
        reason = ageDays >= 1 ? `入库 ${Math.round(ageDays)} 天，一直没做` : "新入库，先过一遍";
    } else if (item.lastResult === "wrong" && (daysSince ?? 0) >= WRONG_REDO_MIN_DAYS) {
        // 到期重做：明确告诉用户「隔了一周，这次专门再练」
        reason = `上次做错，已隔 ${Math.round(daysSince ?? 0)} 天，该重做`;
    } else if (wc >= 3) {
        reason = `错过 ${wc} 次，还没过关`;
    } else if (item.lastResult === "correct" && !isCorrectRedoCoolingDown(item, now)) {
        // 做对题已过长冷却才被兜底选中
        reason = `很久前做对过（已隔 ${Math.round(daysSince ?? 0)} 天），再巩固一次`;
    } else if (streak === 1) {
        reason = "上次做对了，再确认一次";
    } else if (item.lastResult === "wrong") {
        reason = "上次做错";
    } else {
        reason = cc > 0 ? "该复习了" : "还没掌握";
    }

    return { score, reason, daysSince };
}

/**
 * 挑出今天这一批。
 * @param size 题量，通常 6 / 12 / 20
 * @param seed 换一批时传不同值（每次 +1），结果整体重排
 */
export function pickReview<T extends ReviewCandidate>(
    items: T[],
    size: number,
    options: { now?: number; seed?: number; scheduledAt?: Map<string, number> } = {},
): ReviewPick<T>[] {
    const now = options.now ?? Date.now();
    const seed = options.seed ?? 0;
    const want = Math.max(1, Math.min(60, Math.floor(size) || 12));
    const scheduledAt = options.scheduledAt;

    // 归档的、已掌握的（连续答对 ≥2）永远硬排除，不参与任何分层。
    const candidates = items.filter((i) => !isArchived(i) && !isMastered(i));

    /**
     * 是否「最近一次被安排进卷之后还没作答」：
     * scheduledAt 晚于 lastAttemptAt（或从未作答）即判为待做。冷却规则本身不看这个标记，
     * 它只用来把刚出过卷、还没批改的题压到最后兜底，避免它们连续多天霸占推荐。
     */
    const isPending = (item: T): boolean => {
        if (!scheduledAt) return false;
        const sched = scheduledAt.get(item.id);
        if (!sched) return false;
        const lastAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : 0;
        return sched > (Number.isFinite(lastAt) ? lastAt : 0);
    };

    // 做错冷却（tier 4）完全排除，不参与任何选择。
    const scored = candidates
        .filter((item) => reviewTier(item, now) !== TIER_WRONG_COOLDOWN)
        .map((item) => {
            const base = scoreItem(item, now);
            // ±20 分抖动：同层内换一批能换掉一批题
            const score = base.score + (jitter(item.id, seed) - 0.5) * 40;
            return {
                item, score, reason: base.reason, daysSince: base.daysSince,
                tier: reviewTier(item, now),
                pending: isPending(item),
            };
        })
        // 先按分层（没做过 > 做错到期 > 做对到期 > 做对冷却兜底），层内按分数
        .sort((a, b) => a.tier - b.tier || b.score - a.score || a.item.id.localeCompare(b.item.id));

    // 同一知识点最多占 max(2, ceil(size/4)) 道，保证卷子覆盖面（软约束：凑不满时可突破）
    const cap = Math.max(2, Math.ceil(want / 4));
    // 单张卷里「上次做错、这次到期重做」的题最多占约 1/3（至少 1 道）：
    // 到期错题分数高，不设上限会全涌进一张卷；限量后分摊到不同日期。
    const redoCap = Math.max(1, Math.floor(want / 3));
    const used = new Map<string, number>();
    let redoUsed = 0;
    const picked: ReviewPick<T>[] = [];
    const isRedo = (r: { item: T }) => r.item.lastResult === "wrong";

    /**
     * @param ignoreCap 知识点上限是软约束：主选择阶段遵守，凑不满时突破以填满卷子
     */
    const takeRow = (row: typeof scored[number], ignoreCap: boolean): boolean => {
        const key = knowledgeNames(row.item)[0] || "未分类";
        const n = used.get(key) || 0;
        if (isRedo(row) && redoUsed >= redoCap) return false; // 重做硬上限（始终生效）
        if (n >= cap && !ignoreCap) return false;
        used.set(key, n + 1);
        if (isRedo(row)) redoUsed += 1;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { tier, ...pick } = row;
        picked.push(pick);
        return true;
    };

    const pickedIds = new Set<string>();
    /**
     * @param includePending 是否纳入「已安排未批改」的题。正常轮次不纳入（false），
     *        只有题库实在见底时才在最后一轮放开（true），避免刚出过卷的题连日出现。
     */
    const addFromTier = (tierPred: (t: number) => boolean, ignoreCap: boolean, includePending: boolean) => {
        for (const row of scored) {
            if (picked.length >= want) break;
            if (!tierPred(row.tier)) continue;
            if (row.pending && !includePending) continue; // 待做题跳过，留给最后兜底
            if (pickedIds.has(row.item.id)) continue; // 多轮（保底/主选/回补/兜底）之间去重
            if (takeRow(row, ignoreCap)) pickedIds.add(row.item.id);
        }
    };

    // ① 到期错题保底：先单独挑一轮 tier 1（做错且已过冷却），最多 redoCap 道。
    //    这样即使「没做过」的新题源源不断、数量超过卷子容量，到期错题也一定有
    //    约 1/3 的重做名额，不会被新题整层挤掉而永远失去重做机会。
    //    冷却中的错题（tier 4）已被上面的 filter 排除，不会借保底提前出现。
    addFromTier((t) => t === 1, false, false);
    // ② 主选择：tier 0/1/2（没做过 / 做错到期 / 做对到期），遵守知识点上限，凑满剩余名额。
    //    保底已拿过的错题由 pickedIds 去重，自然不会重复入选。
    addFromTier((t) => t <= 2, false, false);
    // ③ 二次回补：同一批题放宽知识点上限，凑满（题库小/知识点集中时不空着）
    if (picked.length < want) addFromTier((t) => t <= 2, true, false);
    // ④ 最后兜底：做对冷却期（tier 3）——只有前面全都不够，才选 14 天内的做对题。
    //    对应用户「14 天内实在没题可选才选它」。做错冷却（tier 4）永远不参与。
    if (picked.length < want) addFromTier((t) => t === TIER_CORRECT_COOLDOWN, true, false);
    // ⑤ 题库彻底见底（剩下的全是刚安排、还没批改的题）才放开待做题，不空卷。
    //    这样正常有其它候选时，刚出过卷的题不会连日霸占推荐；冷却规则始终没被改动。
    if (picked.length < want) addFromTier((t) => t <= 2, true, true);

    return picked.slice(0, want);
}

/** 学生手上大概要花多久：选择题 1.5 分钟，其余按 2.5 分钟粗估 */
export function estimateMinutes(count: number): number {
    return Math.max(3, Math.round(count * 2.2));
}
