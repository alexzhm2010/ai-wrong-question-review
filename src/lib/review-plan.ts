/**
 * 今日复习卷：从错题里挑「今天最该做」的一小批。
 *
 * 排序完全由「掌握得怎么样 + 多久没碰」决定，人话规则：
 *   1. 已经掌握的（连续答对 ≥2 次）——直接不进候选，除非后来又答错让 streak 归零；
 *   2. 掌握度越差越优先：待攻克 > 巩固中 > 未开始；
 *   3. 越久没做越优先：距上次作答按 60 天线性计分，不再 30 天就封顶；
 *      从没做过的题另算「入库时长」分，且权重刻意低，避免新题挤掉真错题；
 *   4. 换一批时叠加 ±20 分抖动，保证分差大的题也能被换掉。
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
    } else if (attempts === 0) {
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
        // 归档的（手动确认掌握）和已掌握的（连续答对 ≥2）都不进今日卷
        .filter((i) => !isArchived(i) && !isMastered(i))
        .map((item) => {
            const base = scoreItem(item, now);
            // ±20 分抖动：即使基础分差较大，换一批也能真正换掉一批题
            const score = base.score + (jitter(item.id, seed) - 0.5) * 40;
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
