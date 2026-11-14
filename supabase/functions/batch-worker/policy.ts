/**
 * batch-worker 的调度决策（纯函数，不依赖 Deno / 网络 / 数据库）。
 *
 * 单独成文件是为了能被前端单元测试直接 import：线上「第 4 张开始永远解析中」
 * 就是几个判断写错导致的——两段重试累计超时、僵死回收被并发刷新、
 * 没有 pending 时还无限自调用。以后改这里先跑测试。
 */

/**
 * 单张解析硬超时：恢复到 v1.19.8 之前（11-14 凌晨那批 15/15 全成功）的 120s。
 * v1.19.8 为修「永远解析中」把它砍到 75s、v1.19.9 放宽到 105s，但都低于早期值，
 * 且超时后直接判 failed。11-14 白天模型响应普遍 60–105s+，于是 16 张图 attempts=1
 * 就全被打成失败。120s 是实测跑通过的值；单轮硬截止同步抬到 140s（见 index.ts），
 * 平台 150s 上限仍留 10s 收尾。
 */
export const PER_ITEM_TIMEOUT_MS = 120_000;
/** 开新一张至少需要的剩余预算（单张上限 + 写库时间） */
export const MIN_ITEM_BUDGET_MS = PER_ITEM_TIMEOUT_MS + 8_000;
/**
 * 一张最多尝试次数。11-14 白天模型对同一张图响应时间波动极大（同一张图 9s /
 * 105s+ 都出现过），单次超时很可能只是运气不好；给 4 次机会能显著提高命中快响应
 * 的概率。关键是「跨轮重试」：超时条目拨回 pending，由下一轮（新的 150s 调用）再跑，
 * 而不是同一轮连跑两次 —— 旧版 fast 120s + deep 120s = 240s 撞平台上限、进程被杀、
 * 条目永远停在 processing，正是「永远解析中」的根因。次数上限保证最终一定收敛。
 */
export const MAX_ATTEMPTS = 4;
/** 降级深度重试至少需要的剩余时间，不够就别开第二段 */
export const MIN_DEEP_RETRY_MS = 20_000;

/** 本轮剩余能分给一张图的毫秒数；永远不超过单张上限 */
export function itemBudgetMs(hardDeadlineAt: number, now: number): number {
    return Math.max(0, Math.min(PER_ITEM_TIMEOUT_MS, hardDeadlineAt - now));
}

/**
 * 软预算到点、或硬截止余量不足时，本轮不再开新条目（交给下一轮）。
 *
 * 注意比较的是「硬截止原始余量」而不是 itemBudgetMs：后者被单张上限封顶在
 * 120_000，若拿它跟 128_000 的门槛比会永远为 false，worker 一张都不会跑。
 */
export function canStartItem(
    hardDeadlineAt: number,
    now: number,
    softDeadlineAt: number,
): boolean {
    return now < softDeadlineAt && hardDeadlineAt - now >= MIN_ITEM_BUDGET_MS;
}

/**
 * 只有「快速模式 + 模型确实返回了内容但漏 XML 标签 + 没被 abort + 预算还够」
 * 才在同一轮内降级深度重试（与 fast 共享同一个 AbortController / deadline）。
 *
 * 关键：AbortController 超时、网络错误、额度错误一律不在本轮重跑。旧版把 aborted
 * 也算作可重试，于是 fast 120s 超时后再跑 deep 120s，累计 240s 必然撞上
 * Edge Function 150s 上限，进程被杀、条目永远停在 processing。
 * v1.19.10 起这些瞬时故障改由 shouldRetryItem 拨回 pending，交给下一轮重试。
 */
export function shouldRetryDeep(
    mode: "fast" | "deep",
    errorMsg: string,
    aborted: boolean,
    remainingMs: number,
    minDeepMs = MIN_DEEP_RETRY_MS,
): boolean {
    return (
        mode === "fast" &&
        !aborted &&
        /Missing critical XML tags/i.test(errorMsg) &&
        remainingMs > minDeepMs
    );
}

/** 抢占前判定：尝试次数用尽直接标失败，不再依赖会被并发刷新的 updatedAt */
export function attemptsExhausted(attempts: number, max = MAX_ATTEMPTS): boolean {
    // NaN / 非数字当作 0（给它一次机会），Infinity 当作已用尽
    const n = typeof attempts === "number" && !Number.isNaN(attempts) ? attempts : 0;
    return n >= max;
}

/**
 * 本次失败要不要拨回 pending、交给下一轮重试。
 *
 * 判据：① 次数没用尽；② 不是「重试也不会变好」的致命错误（额度、未配置、图片
 * 拉取失败）；③ 属于瞬时故障 —— 单次超时、网络抖动、网关 5xx/429、模型偶发漏标签。
 *
 * 这里只决定「再给一次机会」，不负责执行重试；重试必须由 worker 在下一轮完成，
 * 否则同轮累计两次 120s 会撞上平台 150s 上限，把「永远解析中」带回来。
 */
export function shouldRetryItem(
    errorMsg: string,
    aborted: boolean,
    attempts: number,
    max = MAX_ATTEMPTS,
): boolean {
    if (attemptsExhausted(attempts, max)) return false;
    if (/AI_HTTP_402|AI_HTTP_403|AccountOverdue|quota|额度|AI_NOT_CONFIGURED|IMAGE_FETCH_/i.test(errorMsg)) {
        return false;
    }
    return (
        aborted ||
        /signal has been aborted|fetch failed|AI_HTTP_(429|500|502|503|504)|Missing critical XML tags|timed? ?out|ETIMEDOUT/i.test(errorMsg)
    );
}

/** processing 是否还算「活着」：updatedAt 在 freshMs 内被心跳刷过 */
export function isFreshHeartbeat(updatedAt: string | null, now: number, freshMs: number): boolean {
    const t = Date.parse(updatedAt || "");
    return Number.isFinite(t) && now - t < freshMs;
}
