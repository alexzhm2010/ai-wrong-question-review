/**
 * analyze（拍照上传）链路的超时 / 降级决策，纯函数，不依赖 Deno / 网络 / 数据库。
 *
 * 单独成文件是为了能被前端单元测试直接 import（与 batch-worker/policy.ts 同一模式）。
 *
 * 背景（2026-11-21 线上必现事故）：
 *   拍照上传在快速、深度两种模式下都稳定挂满 150s 后被 Supabase 平台强杀
 *   （546 WORKER_RESOURCE_LIMIT），前端只看到「AI 返回数据格式异常」（AI_RESPONSE_ERROR）。
 *   根因不是题目内容、也不是二次验算，而是 analyze 分支的主模型流式请求
 *   「没有任何超时护栏」：上游一旦建立 SSE 连接却不结束（不吐数据 / 一直心跳 /
 *   慢到超时），chat() 的 reader.read() 就永远等下去，直到平台 150s 杀进程。
 *
 * 对策（这套策略集中在本文件，便于回归）：
 *   1. 给主模型两道护栏——首字节超时（连一个 token 都不吐）+ 整体超时（流不结束）；
 *   2. 深度模式超时后，在同一次请求内「降级快速模式」重试，但必须留足收尾时间；
 *   3. 所有预算都严格小于平台 150s，抢在平台动手前给用户明确结果或明确失败；
 *   4. 首字节都没吐就超时时没有 delta 污染，降级安全；已吐过 delta 再整体超时则
 *      需要前端 reset（见 analyze-stream.ts 的 reset 事件），避免两段内容拼接。
 */

/** Supabase Free plan 单次请求墙钟硬上限（毫秒）；超过直接被杀，返回 546 */
export const PLATFORM_WALL_CLOCK_MS = 150_000;

/** 平台强杀前必须留出的收尾余量（解析、二次验算、发 done、关流） */
export const FINALIZE_RESERVE_MS = 15_000;

/** 单次 analyze 请求内，所有模型调用加起来不得超过的硬截止（抢在平台之前） */
export const ANALYZE_HARD_DEADLINE_MS = PLATFORM_WALL_CLOCK_MS - FINALIZE_RESERVE_MS; // 135s

/**
 * 首字节超时：连第一个有效 delta 都没吐就认定上游挂死。
 * 设为 45s——正常识题 5–30s 出首字；45s 还没动静基本可判挂起，
 * 及时失败还能在剩余预算内降级重试一次。
 */
export const FIRST_TOKEN_TIMEOUT_MS = 45_000;

/**
 * 主模型（深度）整体超时预算。深度思考慢，但不该无限等。
 * 留够降级空间：135s 硬截止 - 45s 降级预算 = 90s。
 */
export const PRIMARY_DEEP_BUDGET_MS = 90_000;

/** 降级快速模式的整体超时预算（复用剩余时间，但封顶 45s） */
export const FALLBACK_FAST_BUDGET_MS = 45_000;

/**
 * 判断某次模型失败是否属于「可降级重试」的瞬时故障。
 * 致命错误（额度/未配置/鉴权/图片问题）不重试——重试也不会变好，只是白白拖到超时。
 */
export function isRetryableModelError(message: string): boolean {
    const m = String(message || "");
    // 致命：直接失败
    if (/AI_HTTP_401|AI_HTTP_402|AI_HTTP_403|AI_HTTP_404|AccountOverdue|insufficient|quota|额度|欠费|AI_NOT_CONFIGURED|IMAGE_FETCH_/i.test(m)) {
        return false;
    }
    // 可重试：首字节超时 / 整体超时 / 网络抖动 / 网关 5xx / 429 / abort
    return (
        /FIRST_TOKEN_TIMEOUT|STREAM_TIMEOUT|ANALYZE_TIMEOUT|timed? ?out|ETIMEDOUT|signal has been aborted|fetch failed|AI_HTTP_(429|500|502|503|504)/i.test(m)
    );
}

/**
 * 深度主模型失败后，本轮是否还能降级快速模式重试。
 * 必须同时满足：模式是 deep、错误可重试、剩余预算足够跑完一次快速兜底。
 *
 * 关键教训（来自 batch-worker 事故）：绝不在剩余不足时还开第二段——
 * 两段累计撞上平台 150s 就会重演「必现 546 崩溃」。
 */
export function canDegradeToFast(
    mode: "deep" | "fast",
    errorMessage: string,
    remainingMs: number,
    minFastMs = FALLBACK_FAST_BUDGET_MS,
): boolean {
    return mode === "deep" && isRetryableModelError(errorMessage) && remainingMs > minFastMs;
}

/** 给定起始时间与硬截止，返回当前剩余预算（永不为负） */
export function remainingBudget(deadlineAt: number, now: number): number {
    return Math.max(0, Math.min(ANALYZE_HARD_DEADLINE_MS, deadlineAt - now));
}

/** 主模型该用多大整体预算：受剩余预算约束，不超过模式对应的预算上限 */
export function primaryBudgetMs(mode: "deep" | "fast", remainingMs: number): number {
    const cap = mode === "deep" ? PRIMARY_DEEP_BUDGET_MS : FALLBACK_FAST_BUDGET_MS;
    return Math.max(1_000, Math.min(cap, remainingMs));
}

/**
 * 前端 fast→deep 兜底判定（首页 / 添加页共用）。
 *
 * 旧版只认「Missing critical XML tags」，导致流中断类错误（AI_RESPONSE_ERROR /
 * 超时类）直接抛给用户，无法自愈。这里把这些「重试有机会变好」的错误都纳入。
 * 注意：调用方仍需自行判断「当前是 fast 模式」且「用户没主动取消」。
 */
export function shouldAutoRetryDeep(message: string): boolean {
    const m = String(message || "");
    return (
        /Missing critical XML tags|AI_RESPONSE_ERROR|ANALYZE_TIMEOUT|FIRST_TOKEN_TIMEOUT|STREAM_TIMEOUT|timed? ?out|ETIMEDOUT|AI_HTTP_(429|500|502|503|504)/i.test(m)
    );
}

/** 前端单次 streamAnalyze 的超时上限：必须小于平台 150s，抢在平台强杀前自己收尾 */
export const CLIENT_ANALYZE_TIMEOUT_MS = 140_000;
