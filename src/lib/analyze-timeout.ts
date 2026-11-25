/**
 * 前端 analyze 链路的超时 / 兜底重试策略（纯函数，无副作用）。
 *
 * 与 Edge 端 supabase/functions/ai-proxy/analyze-timeout.ts 成对：
 * 那边负责服务端护栏 + 降级，这边负责客户端护栏 + fast→deep 自愈重试。
 *
 * 11-21 必现事故教训：平台 150s 会强杀请求，前端超时若设得比它长（旧版 180s）
 * 就完全失去意义——永远等不到自己兜底的那一天，只会看到 AI_RESPONSE_ERROR。
 */

/** Supabase 平台单次请求硬上限 */
export const PLATFORM_WALL_CLOCK_MS = 150_000;

/**
 * 前端单次 streamAnalyze 超时：必须明显小于平台 150s，
 * 才能在平台强杀前先自己收尾、把错误交给兜底重试逻辑。
 * 140s 留 10s 给「前端 abort → 抛错 → fast→deep 重试」的衔接。
 */
export const CLIENT_ANALYZE_TIMEOUT_MS = 140_000;

/** 超时/中断类错误码（Edge 实测会发这些，前端自身 abort 也会归一到 ANALYZE_TIMEOUT） */
export const RETRYABLE_ERROR_PATTERN =
  /Missing critical XML tags|AI_RESPONSE_ERROR|ANALYZE_TIMEOUT|FIRST_TOKEN_TIMEOUT|STREAM_TIMEOUT|timed? ?out|ETIMEDOUT|AI_HTTP_(429|500|502|503|504)/i;

/** 致命错误：重试也不会变好，不该浪费一次深度重试 */
const FATAL_ERROR_PATTERN =
  /AI_HTTP_401|AI_HTTP_402|AI_HTTP_403|AI_HTTP_404|AccountOverdue|insufficient|quota|额度|欠费|AI_NOT_CONFIGURED|IMAGE_FETCH_/i;

/**
 * 该错误是否值得用深度模式自动重试一次。
 * 调用方仍需自行判断「当前是 fast 模式」且「用户没主动取消」。
 */
export function shouldAutoRetryDeep(message: string): boolean {
    const m = String(message || "");
    if (FATAL_ERROR_PATTERN.test(m)) return false;
    return RETRYABLE_ERROR_PATTERN.test(m);
}

/** 钳制超时配置：既不超过平台上限，也不会被瞎填的超大值拖垮 */
export function clampAnalyzeTimeout(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : CLIENT_ANALYZE_TIMEOUT_MS;
    if (n <= 0) return CLIENT_ANALYZE_TIMEOUT_MS;
    return Math.min(n, CLIENT_ANALYZE_TIMEOUT_MS);
}
