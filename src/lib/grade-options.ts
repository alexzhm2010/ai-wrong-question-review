/**
 * 年级/学期标准值。
 *
 * 与 src/lib/ai/tag-service.ts 的 gradeToSemesterMap 保持一致：
 * 只有这 12 个值才能正确挂到知识点标签树的年级父节点上。
 * 历史上年级字段是自由文本，出现过「已毕业上」这类无法识别的值，
 * 现在统一由下拉选择，其它一律归为「未设置」（空串）。
 */
export const GRADE_SEMESTER_OPTIONS = [
    "七年级上", "七年级下",
    "八年级上", "八年级下",
    "九年级上", "九年级下",
    "高一上", "高一下",
    "高二上", "高二下",
    "高三上", "高三下",
] as const;

export type GradeSemester = (typeof GRADE_SEMESTER_OPTIONS)[number];

/** Radix Select 不允许空字符串作为 value，用哨兵值表示「未设置」 */
export const GRADE_SEMESTER_UNSET = "__unset__";

const VALID_GRADE_SEMESTERS = new Set<string>(GRADE_SEMESTER_OPTIONS);

/**
 * 把任意历史值归一化为标准值；无法识别时返回空串（＝未设置）。
 * 用于读取数据库里可能存在的旧脏数据。
 */
export function normalizeGradeSemester(value?: string | null): string {
    if (!value) return "";
    const trimmed = value.trim();
    return VALID_GRADE_SEMESTERS.has(trimmed) ? trimmed : "";
}

export function isGradeSemester(value: string): value is GradeSemester {
    return VALID_GRADE_SEMESTERS.has(value);
}
