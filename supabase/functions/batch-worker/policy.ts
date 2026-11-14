/**
 * batch-worker 的调度决策（纯函数，不依赖 Deno / 网络 / 数据库）。
 *
 * 单独成文件是为了能被前端单元测试直接 import：线上「第 4 张开始永远解析中」
 * 就是几个判断写错导致的——两段重试累计超时、僵死回收被并发刷新、
 * 没有 pending 时还无限自调用。以后改这里先跑测试。
 */

/**
 * 单张解析硬超时：同一批真实失败图的响应实测落在 61–100s，旧版 75s 正好切在
 * 分布中间，把「再等几秒就能返回」的图也判成了超时。放宽到 105s 覆盖长尾，
 * 单轮硬截止同步抬到 125s（见 index.ts），仍给平台 150s 上限留 25s 收尾。
 */
export const PER_ITEM_TIMEOUT_MS = 105_000;
/** 开新一张至少需要的剩余预算（单张上限 + 写库时间） */
export const MIN_ITEM_BUDGET_MS = PER_ITEM_TIMEOUT_MS + 8_000;
/** 一张最多尝试次数：抢占阶段判定，不依赖 updatedAt */
export const MAX_ATTEMPTS = 3;
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
 * 105_000，若拿它跟 113_000 的门槛比会永远为 false，worker 一张都不会跑。
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
 * 才降级深度重试。
 *
 * 关键：AbortController 超时、网络错误、额度错误一律不重跑。旧版把 aborted
 * 也算作可重试，于是 fast 120s 超时后再跑 deep 120s，累计 240s 必然撞上
 * Edge Function 150s 上限，进程被杀、条目永远停在 processing。
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

/** processing 是否还算「活着」：updatedAt 在 freshMs 内被心跳刷过 */
export function isFreshHeartbeat(updatedAt: string | null, now: number, freshMs: number): boolean {
    const t = Date.parse(updatedAt || "");
    return Number.isFinite(t) && now - t < freshMs;
}
