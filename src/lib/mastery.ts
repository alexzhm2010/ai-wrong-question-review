/**
 * 掌握度分层与知识点聚合。
 *
 * 只用一个可解释的信号：**连续答对次数**。
 * 错一次立刻归零，所以「连续对 2 次」意味着至少经历了两次独立回忆成功，
 * 比「做对过几次」靠谱得多（后者会被反复刷同一道题灌水）。
 */

export type MasteryBand = "mastered" | "steady" | "weak" | "new";

/** 归档 = 手动确认已掌握、不再进日常复习；用 masteryLevel=3 表示，不额外加列 */
export const ARCHIVED_LEVEL = 3;

export interface MasteryLike {
    wrongCount?: number | null;
    correctCount?: number | null;
    correctStreak?: number | null;
    masteryLevel?: number | null;
}

export const BAND_ORDER: MasteryBand[] = ["mastered", "steady", "weak", "new"];

export const BAND_META: Record<MasteryBand, { label: string; hint: string; color: string; ring: string }> = {
    mastered: {
        label: "已掌握",
        hint: "连续答对 ≥2 次",
        color: "#16a34a",
        ring: "bg-green-50 text-green-700 border-green-200",
    },
    steady: {
        label: "巩固中",
        hint: "刚答对 1 次，还差一次确认",
        color: "#2563eb",
        ring: "bg-blue-50 text-blue-700 border-blue-200",
    },
    weak: {
        label: "待攻克",
        hint: "答错过，当前还没有连续答对",
        color: "#dc2626",
        ring: "bg-red-50 text-red-700 border-red-200",
    },
    new: {
        label: "未开始",
        hint: "入库后一次都没做过",
        color: "#94a3b8",
        ring: "bg-slate-50 text-slate-600 border-slate-200",
    },
};

export function isArchived(item: MasteryLike): boolean {
    return Number(item.masteryLevel || 0) >= ARCHIVED_LEVEL;
}

export function bandOf(item: MasteryLike): MasteryBand {
    const streak = Number(item.correctStreak || 0);
    const attempts = Number(item.wrongCount || 0) + Number(item.correctCount || 0);
    if (streak >= 2) return "mastered";
    if (streak === 1) return "steady";
    if (attempts === 0) return "new";
    return "weak";
}

export interface MasterySummary {
    total: number;
    archived: number;
    bands: Record<MasteryBand, number>;
    /** 已掌握 / (总数 - 未开始 - 归档)，分母为 0 时记 0 */
    masteryRate: number;
    /** 平均每题错过几次：>1 说明错题在反复犯 */
    avgWrong: number;
}

export function summarizeMastery(items: MasteryLike[]): MasterySummary {
    const bands: Record<MasteryBand, number> = { mastered: 0, steady: 0, weak: 0, new: 0 };
    let archived = 0;
    let wrongSum = 0;
    for (const item of items) {
        if (isArchived(item)) {
            archived++;
            continue;
        }
        bands[bandOf(item)]++;
        wrongSum += Number(item.wrongCount || 0);
    }
    const active = items.length - archived;
    const denominator = active - bands.new;
    const masteryRate = denominator > 0 ? bands.mastered / denominator : 0;
    return {
        total: items.length,
        archived,
        bands,
        masteryRate,
        avgWrong: active > 0 ? wrongSum / active : 0,
    };
}

/** 知识点名：优先关联标签，其次 knowledgePoints 里存的 JSON 数组 */
export function knowledgeNames(item: { tags?: Array<{ name?: string }>; knowledgePoints?: string | null }): string[] {
    const fromTags = (item.tags || []).map((t) => (t?.name || "").trim()).filter(Boolean);
    if (fromTags.length) return [...new Set(fromTags)];
    if (!item.knowledgePoints) return [];
    try {
        const raw = JSON.parse(item.knowledgePoints);
        if (Array.isArray(raw)) {
            return [
                ...new Set(
                    raw
                        .map((x) => (typeof x === "string" ? x : x?.name))
                        .map((x) => String(x || "").trim())
                        .filter(Boolean),
                ),
            ];
        }
    } catch {
        /* 不是 JSON 就当没有 */
    }
    return [];
}

export interface TagMastery {
    name: string;
    total: number;
    mastered: number;
    weak: number;
    rate: number;
}

/**
 * 按知识点统计掌握率。
 * 只保留出现 ≥ minCount 次的知识点——只做过一道题的点，掌握率不是 0% 就是 100%，
 * 放在排行榜上只会误导。
 */
export function tagMastery(
    items: Array<MasteryLike & { tags?: Array<{ name?: string }>; knowledgePoints?: string | null }>,
    minCount = 2,
): TagMastery[] {
    const acc = new Map<string, { total: number; mastered: number; weak: number }>();
    for (const item of items) {
        if (isArchived(item)) continue;
        const band = bandOf(item);
        for (const name of knowledgeNames(item)) {
            const cur = acc.get(name) || { total: 0, mastered: 0, weak: 0 };
            cur.total++;
            if (band === "mastered") cur.mastered++;
            if (band === "weak") cur.weak++;
            acc.set(name, cur);
        }
    }
    return [...acc.entries()]
        .filter(([, v]) => v.total >= minCount)
        .map(([name, v]) => ({
            name,
            total: v.total,
            mastered: v.mastered,
            weak: v.weak,
            rate: v.total > 0 ? v.mastered / v.total : 0,
        }))
        .sort((a, b) => a.rate - b.rate || b.weak - a.weak || b.total - a.total);
}
