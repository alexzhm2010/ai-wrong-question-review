import { inferSubjectFromName } from "@/lib/knowledge-tags";

/**
 * GeoGebra 动态演示的学科门禁。
 *
 * 背景：这个入口原先只要题干和答案非空就常驻显示，语文 / 英语 / 化学等
 * 题目也占一块版面；且校对页接口没有学科过滤，误点会白白消耗一次 AI 调用
 * （错题详情页接口早有「仅数学 / 物理」门禁，两个入口行为不一致）。
 * 这里把判定收敛成一处，前后端共用。
 *
 * 判定优先级：错题本名称 > AI 返回的学科名。
 * 原因：文字录入 / AI 解题路径会把 `subject` 硬编码成「数学」，只有错题本
 * 名称反映用户真正的归档学科。
 */

/** 学科名归一；无法识别返回 null（表示「未知」）。 */
function resolveSubject(notebookName?: string | null, aiSubject?: string | null) {
    return (
        inferSubjectFromName(notebookName ?? null) ||
        inferSubjectFromName(aiSubject ?? null) ||
        null
    );
}

/**
 * 前端是否展示 GeoGebra 入口（默认折叠的一行小入口）。
 * 明确是数学 / 物理 → 展示；明确是其它学科 → 隐藏；
 * 学科未知（未归档、自定义错题本名）→ 仍展示，避免把有用的几何题误隐藏。
 */
export function shouldShowGeogebra(
    notebookName?: string | null,
    aiSubject?: string | null
): boolean {
    const key = resolveSubject(notebookName, aiSubject);
    if (!key) return true;
    return key === "math" || key === "physics";
}

/**
 * 后端是否应短路、不发起 AI 调用。
 * 只有「明确是非理科」才拒绝；学科未知时放行，让 AI 自行判断是否适合演示，
 * 与前端的展示门禁保持一致（未知时前端也会展示折叠入口）。
 */
export function isNonGeogebraSubject(subjectName?: string | null): boolean {
    const key = resolveSubject(subjectName);
    if (!key) return false;
    return key !== "math" && key !== "physics";
}
