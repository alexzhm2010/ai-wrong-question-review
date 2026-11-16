/**
 * 拍照批改页的提示条文案/配色决策（纯函数，便于回归测试）。
 *
 * 背景：首轮整页识别可能因为整图太大返回 500，但复核阶段逐题裁小图后
 * 往往能成功补全结果。此时若仍把首轮的 `error` 标红展示，用户会误以为
 * 「明明有结果却报错」。规则：
 *  - 有 error 且有可用结果 → 降级为中性提示，说明已复核补全，不报红；
 *  - 有 error 且无可用结果 → 保留红色错误；
 *  - 无 error 只有 hint → 中性提示；
 *  - 都没有 → 不显示。
 */
export function scanErrorNotice(
    error: string,
    hint: string,
    usableCount: number,
): { text: string; red: boolean } | null {
    if (error && usableCount > 0) {
        return {
            text: `首轮整页识别未成功（${error}），已逐题复核补全 ${usableCount} 道，结果可正常使用`,
            red: false,
        };
    }
    if (error) return { text: error, red: true };
    if (hint) return { text: hint, red: false };
    return null;
}
