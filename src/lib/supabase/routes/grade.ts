/**
 * 年级沿用规则（v1.13.0 定下，v1.19.6 下沉到入库层）。
 *
 * 规则原文：「年级/学期改为 12 项标准下拉（含未设置），沿用数据库中
 * 最近一次手选的年级；不再按入学年份推算」。
 *
 * 历史问题：这条规则当初只做在前端编辑器（CorrectionEditor /
 * DirectTextEditor 用 fetchLastGradeSemester() 预填）。批量导入的
 * 「一键全部入库」根本不打开编辑器，/api/batch/save 只写
 * gradeSemester: item.gradeSemester || null，于是整批年级落空。
 * 规则没被删，是批量链路从一开始就没接上。
 *
 * 现在把兜底放在**服务端写库前**，任何入口都无法绕过；前端预填保留，
 * 两者共用同一份数据与同一套判定，不会出现预填 A、入库 B。
 */
import { restJson } from "../core";
import { normalizeGradeSemester } from "../../grade-options";

/**
 * 从「按 createdAt 倒序」的行里取最近一个有效年级。
 * 脏值（如历史资料里的「已毕业上」「初三」）不算，继续往前找。
 */
export function recentGradeFromRows(rows: unknown): string | null {
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
        const raw = (r as { gradeSemester?: unknown } | null)?.gradeSemester;
        const g = normalizeGradeSemester(typeof raw === "string" ? raw : "");
        if (g) return g;
    }
    return null;
}

/** 查当前用户最近一次保存的有效年级。带 userId 过滤，避免多用户串值。 */
export async function fetchLastUsedGrade(userId: string): Promise<string | null> {
    const rows = await restJson<{ gradeSemester?: string | null }[]>(
        `/ErrorItem?select=gradeSemester&userId=eq.${encodeURIComponent(userId)}` +
        `&gradeSemester=not.is.null&order=createdAt.desc&limit=200`,
    ).catch(() => []);
    return recentGradeFromRows(rows);
}

/**
 * 本条是否需要沿用最近年级。
 * - 明确传空串 ""（用户在下拉里选了「未设置」）→ 尊重，不沿用
 * - 自带有效标准值 → 尊重，不沿用
 * - null / undefined / 脏值 → 需要沿用
 */
export function gradeNeedsInherit(provided: unknown): boolean {
    if (provided === "") return false;
    return !normalizeGradeSemester(typeof provided === "string" ? provided : "");
}

/**
 * 算出一条新题最终写入的年级。
 * @param provided 该条目自己带来的年级（可能来自用户手选，也可能是 AI/批量留空）
 * @param lastUsed 数据库中最近一次保存的有效年级
 */
export function resolveGradeForNewItem(provided: unknown, lastUsed: string | null): string | null {
    if (provided === "") return "";                    // 用户明确选「未设置」
    const own = normalizeGradeSemester(typeof provided === "string" ? provided : "");
    if (own) return own;                               // 本条自带有效年级，优先
    return normalizeGradeSemester(lastUsed) || null;    // 否则沿用最近一次
}

/**
 * 写库前补全年级：自带有效值（或明确未设置）时零查询，否则查一次最近年级。
 * 返回补全后的 body，不改原对象。
 */
export async function withInheritedGrade<T extends { gradeSemester?: unknown }>(
    body: T,
    userId: string,
): Promise<T> {
    if (!gradeNeedsInherit(body?.gradeSemester)) {
        return { ...body, gradeSemester: resolveGradeForNewItem(body.gradeSemester, null) };
    }
    const last = await fetchLastUsedGrade(userId);
    return { ...body, gradeSemester: resolveGradeForNewItem(body.gradeSemester, last) };
}
