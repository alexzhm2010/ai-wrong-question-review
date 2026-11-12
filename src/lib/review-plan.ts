/**
 * 今日复习卷：从错题里挑「今天最该做」的一小批。
 *
 * 排序不用黑盒模型，四条人话规则：
 *   1. 错得越多越靠前；
 *   2. 越久没碰越靠前（最多计 30 天，再久也不额外加分）；
 *   3. 一次都没对过的，优先；
 *   4. 已经连续对 2 次的，往后压——它大概率是真会了。
 * 选完再做一次知识点去重，避免整张卷子五道题都是同一个考点。
 */

import { isArchived, knowledgeNames } from "./mastery";

const DAY = 86_400_000;

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

export function scoreItem(
    item: ReviewCandidate,
    now: number = Date.now(),
): { score: number; reason: string; daysSince: number | null } {
    const wc = Number(item.wrongCount || 0);
    const cc = Number(item.correctCount || 0);
    const streak = Number(item.correctStreak || 0);
    const attempts = wc + cc;

    const lastAt = item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : NaN;
    const daysSince = Number.isFinite(lastAt) ? Math.max(0, (now - lastAt) / DAY) : null;
    const created = item.createdAt ? Date.parse(item.createdAt) : NaN;
    const ageDays = Number.isFinite(created) ? Math.max(0, (now - created) / DAY) : 0;

    let score = 0;
    score += wc * 9;
    if (cc === 0 && attempts > 0) score += 16; // 做过但从没对过，最扎心
    score += Math.min(daysSince ?? 30, 30) * 1.6;
    if (item.lastResult === "wrong") score += 18;
    if (item.lastResult === "correct") score -= 6;
    score -= streak >= 2 ? 60 : streak === 1 ? 14 : 0;
    if (attempts === 0) score += 12 + Math.min(ageDays, 30) * 1.2;

    let reason: string;
    if (attempts === 0) {
        reason = ageDays >= 1 ? `入库 ${Math.round(ageDays)} 天，一直没做` : "新入库，先过一遍";
    } else if (item.lastResult === "wrong" && (daysSince ?? 0) >= 3) {
        reason = `上次做错，已隔 ${Math.round(daysSince ?? 0)} 天`;
    } else if (wc >= 3) {
        reason = `错过 ${wc} 次，还没过关`;
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
    options: { now?: number; seed?: number } = {},
): ReviewPick<T>[] {
    const now = options.now ?? Date.now();
    const seed = options.seed ?? 0;
    const want = Math.max(1, Math.min(60, Math.floor(size) || 12));

    const scored = items
        .filter((i) => !isArchived(i))
        .map((item) => {
            const base = scoreItem(item, now);
            // 抖动幅度控制在 ±6 分：只影响同分档的先后，不会把冷门题顶上来
            const score = base.score + (jitter(item.id, seed) - 0.5) * 12;
            return { item, score, reason: base.reason, daysSince: base.daysSince };
        })
        .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));

    // 同一知识点最多占 max(2, ceil(size/4)) 道，保证卷子覆盖面
    const cap = Math.max(2, Math.ceil(want / 4));
    const used = new Map<string, number>();
    const picked: ReviewPick<T>[] = [];
    const overflow: ReviewPick<T>[] = [];

    for (const row of scored) {
        const key = knowledgeNames(row.item)[0] || "未分类";
        const n = used.get(key) || 0;
        if (n >= cap) {
            overflow.push(row);
            continue;
        }
        used.set(key, n + 1);
        picked.push(row);
        if (picked.length >= want) break;
    }
    // 题库小、知识点集中时，宁可放弃多样性也要凑满一页
    for (const row of overflow) {
        if (picked.length >= want) break;
        picked.push(row);
    }
    return picked.slice(0, want);
}

/** 学生手上大概要花多久：选择题 1.5 分钟，其余按 2.5 分钟粗估 */
export function estimateMinutes(count: number): number {
    return Math.max(3, Math.round(count * 2.2));
}
