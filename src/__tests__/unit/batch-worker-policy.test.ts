/**
 * 批量 worker 调度策略回归测试。
 *
 * 背景：线上「第 4 张开始永远解析中」，三个判断写错叠加：
 *   - 快速模式超时（aborted）也算「可降级深度重试」，两段各 120s 累计 240s
 *     超过 Edge Function 150s 上限，进程被杀，条目永远停在 processing；
 *   - 单轮没有硬截止，while 只检查软预算，进了单张就完全不受约束；
 *   - 僵死回收依赖 updatedAt 超过 3 分钟，多实例并发抢占不断刷新它，永不触发。
 * v1.19.8 修好了死锁，但把超时改成「一次不成直接 failed」；11-14 白天模型变慢，
 * 16 张失败图 attempts 全是 1。v1.19.10 把重试机会拿回来：超时拨回 pending，
 * 由下一轮再跑（跨轮，绝不撞平台上限），次数上限保证最终收敛。这里锁住这些判定。
 */
import { describe, it, expect } from "vitest";
import {
    PER_ITEM_TIMEOUT_MS,
    MIN_ITEM_BUDGET_MS,
    MAX_ATTEMPTS,
    MIN_DEEP_RETRY_MS,
    itemBudgetMs,
    canStartItem,
    shouldRetryDeep,
    shouldRetryItem,
    attemptsExhausted,
    isFreshHeartbeat,
} from "../../../supabase/functions/batch-worker/policy";

describe("itemBudgetMs：单张预算绝不超过硬截止余量", () => {
    it("剩余充足时封顶在单张上限 120s", () => {
        expect(itemBudgetMs(200_000, 0)).toBe(PER_ITEM_TIMEOUT_MS);
        expect(PER_ITEM_TIMEOUT_MS).toBe(120_000);
    });

    it("剩余不足时按剩余给，不再开满 120s", () => {
        expect(itemBudgetMs(30_000, 0)).toBe(30_000);
        expect(itemBudgetMs(0, 100_000)).toBe(0);
    });

    it("任何情况下都不会超过平台上限", () => {
        // 旧版 fast 120s + deep 120s = 240s > 150s；新版单张最多 120s
        expect(itemBudgetMs(1_000_000_000, 0)).toBeLessThan(150_000);
        expect(itemBudgetMs(1_000_000_000, 0)).toBe(120_000);
    });
});

describe("canStartItem：软预算 / 硬截止双重把关", () => {
    it("预算充足可以开新条目", () => {
        expect(canStartItem(140_000, 0, 55_000)).toBe(true);
    });

    it("v1.19.10：单张恢复到 120s 后硬截止必须同步抬到 140s", () => {
        expect(PER_ITEM_TIMEOUT_MS).toBe(120_000);
        expect(MIN_ITEM_BUDGET_MS).toBe(128_000);
        expect(canStartItem(140_000, 0, 55_000)).toBe(true);
        expect(canStartItem(125_000, 0, 55_000)).toBe(false);
    });

    it("软预算到点即使硬截止还有余量也交棒下一轮", () => {
        expect(canStartItem(140_000, 55_001, 55_000)).toBe(false);
    });

    it("硬截止余量不足以跑完一张并写库时不再开新条目", () => {
        expect(canStartItem(80_000, 0, 55_000)).toBe(false);
        expect(canStartItem(MIN_ITEM_BUDGET_MS - 1, 0, 55_000)).toBe(false);
        // 刚好等于门槛即视为够用（边界包含）
        expect(canStartItem(MIN_ITEM_BUDGET_MS, 0, 55_000)).toBe(true);
        expect(canStartItem(MIN_ITEM_BUDGET_MS + 1, 0, 55_000)).toBe(true);
    });
});

describe("shouldRetryDeep：只在漏标签时同轮降级，超时绝不本轮重跑", () => {
    it("快速模式漏标签、未超时、预算充足 → 降级", () => {
        expect(shouldRetryDeep("fast", "Missing critical XML tags", false, 50_000)).toBe(true);
    });

    it("AbortController 超时 → 本轮不重跑（改由 shouldRetryItem 跨轮重试）", () => {
        expect(shouldRetryDeep("fast", "The signal has been aborted", true, 60_000)).toBe(false);
        expect(shouldRetryDeep("fast", "Missing critical XML tags", true, 60_000)).toBe(false);
    });

    it("网络错误、额度错误、模型报错 → 本轮不重跑", () => {
        expect(shouldRetryDeep("fast", "AI_HTTP_429: rate limited", false, 60_000)).toBe(false);
        expect(shouldRetryDeep("fast", "AI_HTTP_402: AccountOverdue", false, 60_000)).toBe(false);
        expect(shouldRetryDeep("fast", "fetch failed", false, 60_000)).toBe(false);
    });

    it("深度模式本身不再二次降级", () => {
        expect(shouldRetryDeep("deep", "Missing critical XML tags", false, 60_000)).toBe(false);
    });

    it("剩余预算不足以跑第二段 → 不重跑", () => {
        expect(shouldRetryDeep("fast", "Missing critical XML tags", false, MIN_DEEP_RETRY_MS)).toBe(false);
        expect(shouldRetryDeep("fast", "Missing critical XML tags", false, MIN_DEEP_RETRY_MS + 1)).toBe(true);
    });

    it("两段重试共享同一个 deadline，累计不会超过平台上限", () => {
        const budget = itemBudgetMs(140_000, 0);
        expect(budget).toBe(PER_ITEM_TIMEOUT_MS);
        // fast + deep 共用一个 AbortController 与 deadline，不是各跑一遍：
        // 单张最多 120s + 单轮收尾余量 10s，仍留在平台 150s 内
        expect(budget).toBeLessThan(150_000);
        expect(budget + 10_000).toBeLessThanOrEqual(150_000);
    });
});

describe("shouldRetryItem：跨轮重试，拿回上午的成功率又不死锁", () => {
    it("单次超时 → 拨回 pending 交给下一轮", () => {
        expect(shouldRetryItem("The signal has been aborted", true, 0)).toBe(true);
        expect(shouldRetryItem("The signal has been aborted", false, 1)).toBe(true);
    });

    it("网络抖动 / 网关错误 / 模型偶发漏标签 → 也给一次机会", () => {
        expect(shouldRetryItem("fetch failed", false, 0)).toBe(true);
        expect(shouldRetryItem("AI_HTTP_503: upstream", false, 2)).toBe(true);
        expect(shouldRetryItem("Missing critical XML tags", false, 1)).toBe(true);
    });

    it("额度 / 未配置 / 图片拉取失败 → 重试也没用，直接失败", () => {
        expect(shouldRetryItem("AI_HTTP_402: AccountOverdue", false, 0)).toBe(false);
        expect(shouldRetryItem("AI_NOT_CONFIGURED", false, 1)).toBe(false);
        expect(shouldRetryItem("IMAGE_FETCH_404", false, 0)).toBe(false);
    });

    it("次数用尽 → 不再重试，保证整批最终收敛", () => {
        expect(MAX_ATTEMPTS).toBe(4);
        expect(shouldRetryItem("The signal has been aborted", true, MAX_ATTEMPTS)).toBe(false);
        expect(shouldRetryItem("The signal has been aborted", true, MAX_ATTEMPTS - 1)).toBe(true);
    });

    it("重试必须跨轮：同一轮连跑两次 120s 会撞 150s 上限", () => {
        expect(PER_ITEM_TIMEOUT_MS * 2).toBeGreaterThan(150_000);
    });
});

describe("attemptsExhausted：抢占阶段判定，不依赖会被并发刷新的 updatedAt", () => {
    it("未到上限继续跑", () => {
        expect(attemptsExhausted(0)).toBe(false);
        expect(attemptsExhausted(MAX_ATTEMPTS - 1)).toBe(false);
    });

    it("到上限直接标失败", () => {
        expect(attemptsExhausted(MAX_ATTEMPTS)).toBe(true);
        expect(attemptsExhausted(MAX_ATTEMPTS + 5)).toBe(true);
    });

    it("脏数据不当成无限重试", () => {
        expect(attemptsExhausted(Number.NaN)).toBe(false);
        expect(attemptsExhausted(Number.POSITIVE_INFINITY)).toBe(true);
    });
});

describe("isFreshHeartbeat：区分「别人在跑」和「上一轮被杀」", () => {
    const now = 1_700_000_000_000;

    it("刚刷过心跳算活跃", () => {
        expect(isFreshHeartbeat(new Date(now - 10_000).toISOString(), now, 40_000)).toBe(true);
    });

    it("超过窗口或没有时间戳算僵死", () => {
        expect(isFreshHeartbeat(new Date(now - 50_000).toISOString(), now, 40_000)).toBe(false);
        expect(isFreshHeartbeat(null, now, 40_000)).toBe(false);
        expect(isFreshHeartbeat("not-a-date", now, 40_000)).toBe(false);
    });
});
