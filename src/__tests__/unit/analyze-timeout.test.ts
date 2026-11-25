/**
 * 11-21 拍照上传「快速/深度都 150s 必现崩溃」的超时/降级策略回归测试。
 *
 * 覆盖两端：
 *   - Edge 端 supabase/functions/ai-proxy/analyze-timeout.ts（护栏 + 降级）
 *   - 前端 src/lib/analyze-timeout.ts（客户端超时 + fast→deep 兜底）
 *
 * 改这些策略前先跑本文件，确保不会重演「平台强杀而代码毫无兜底」。
 */
import { describe, it, expect } from "vitest";
import {
    PLATFORM_WALL_CLOCK_MS, ANALYZE_HARD_DEADLINE_MS, FINALIZE_RESERVE_MS,
    FIRST_TOKEN_TIMEOUT_MS, PRIMARY_DEEP_BUDGET_MS, FALLBACK_FAST_BUDGET_MS,
    isRetryableModelError, canDegradeToFast, remainingBudget, primaryBudgetMs,
} from "../../../supabase/functions/ai-proxy/analyze-timeout";
import {
    CLIENT_ANALYZE_TIMEOUT_MS as CLIENT_TIMEOUT,
    shouldAutoRetryDeep, clampAnalyzeTimeout,
} from "@/lib/analyze-timeout";

describe("预算永远抢在平台 150s 之前", () => {
    it("平台上限就是 150s，硬截止留出收尾余量", () => {
        expect(PLATFORM_WALL_CLOCK_MS).toBe(150_000);
        expect(FINALIZE_RESERVE_MS).toBeGreaterThan(0);
        expect(ANALYZE_HARD_DEADLINE_MS).toBeLessThan(PLATFORM_WALL_CLOCK_MS);
        expect(ANALYZE_HARD_DEADLINE_MS).toBe(135_000);
    });

    it("首字节超时明显短于整体预算", () => {
        expect(FIRST_TOKEN_TIMEOUT_MS).toBeLessThan(PRIMARY_DEEP_BUDGET_MS);
        expect(FIRST_TOKEN_TIMEOUT_MS).toBe(45_000);
    });

    it("深度预算 + 降级预算不会超过硬截止（核心防 546 崩溃）", () => {
        // 旧模型：deep 90s + fast 45s 两段可能累计；策略保证降级前检查剩余
        expect(PRIMARY_DEEP_BUDGET_MS + FALLBACK_FAST_BUDGET_MS).toBeLessThanOrEqual(ANALYZE_HARD_DEADLINE_MS);
    });
});

describe("remainingBudget / primaryBudgetMs", () => {
    it("剩余预算永不为负、不超硬截止", () => {
        const deadline = 1_000_000 + ANALYZE_HARD_DEADLINE_MS;
        expect(remainingBudget(deadline, 1_000_000)).toBe(ANALYZE_HARD_DEADLINE_MS);
        expect(remainingBudget(deadline, deadline + 5_000)).toBe(0);
        expect(remainingBudget(deadline, deadline - 1_000)).toBe(1_000);
    });

    it("主模型预算受模式上限与剩余预算双重约束", () => {
        expect(primaryBudgetMs("deep", 999_999)).toBe(PRIMARY_DEEP_BUDGET_MS);
        expect(primaryBudgetMs("fast", 999_999)).toBe(FALLBACK_FAST_BUDGET_MS);
        expect(primaryBudgetMs("deep", 10_000)).toBe(10_000);
        expect(primaryBudgetMs("fast", 0)).toBe(1_000); // 至少给 1s，不会是 0
    });
});

describe("isRetryableModelError：致命错误不重试，瞬时故障才重试", () => {
    it("额度/欠费/未配置/鉴权失败一律不重试", () => {
        expect(isRetryableModelError("AI_HTTP_402: insufficient balance")).toBe(false);
        expect(isRetryableModelError("AI_NOT_CONFIGURED")).toBe(false);
        expect(isRetryableModelError("AI_HTTP_401 Unauthorized")).toBe(false);
        expect(isRetryableModelError("额度已用尽")).toBe(false);
    });

    it("超时/网络/网关 5xx/429 可重试", () => {
        expect(isRetryableModelError("FIRST_TOKEN_TIMEOUT")).toBe(true);
        expect(isRetryableModelError("STREAM_TIMEOUT")).toBe(true);
        expect(isRetryableModelError("fetch failed")).toBe(true);
        expect(isRetryableModelError("AI_HTTP_503")).toBe(true);
        expect(isRetryableModelError("AI_HTTP_429 rate limited")).toBe(true);
    });
});

describe("canDegradeToFast：降级必须模式对 + 错误可重试 + 预算够", () => {
    it("深度模式 + 超时 + 预算充足 → 降级", () => {
        expect(canDegradeToFast("deep", "STREAM_TIMEOUT", 60_000)).toBe(true);
    });

    it("快速模式不降级（避免第二段叠加超时）", () => {
        expect(canDegradeToFast("fast", "STREAM_TIMEOUT", 140_000)).toBe(false);
    });

    it("致命错误不降级", () => {
        expect(canDegradeToFast("deep", "AI_HTTP_402 quota", 140_000)).toBe(false);
    });

    it("剩余预算不足时不降级（防累计撞平台上限）", () => {
        expect(canDegradeToFast("deep", "STREAM_TIMEOUT", 10_000)).toBe(false);
        expect(canDegradeToFast("deep", "STREAM_TIMEOUT", 45_000)).toBe(false); // 不大于阈值
        expect(canDegradeToFast("deep", "STREAM_TIMEOUT", 46_000)).toBe(true);
    });
});

describe("前端超时与 fast→deep 兜底", () => {
    it("客户端超时必须小于平台，且正好 140s", () => {
        expect(CLIENT_TIMEOUT).toBe(140_000);
        expect(CLIENT_TIMEOUT).toBeLessThan(PLATFORM_WALL_CLOCK_MS);
    });

    it("钳制配置：旧配置 180s 被压到 140s，非法值回落默认", () => {
        expect(clampAnalyzeTimeout(180_000)).toBe(CLIENT_TIMEOUT);
        expect(clampAnalyzeTimeout(300_000)).toBe(CLIENT_TIMEOUT);
        expect(clampAnalyzeTimeout(60_000)).toBe(60_000); // 用户主动调小允许
        expect(clampAnalyzeTimeout(0)).toBe(CLIENT_TIMEOUT);
        expect(clampAnalyzeTimeout(undefined)).toBe(CLIENT_TIMEOUT);
        expect(clampAnalyzeTimeout(NaN)).toBe(CLIENT_TIMEOUT);
    });

    it("兜底认得流中断/超时类错误（这是本次事故漏掉的关键）", () => {
        expect(shouldAutoRetryDeep("AI_RESPONSE_ERROR")).toBe(true);
        expect(shouldAutoRetryDeep("ANALYZE_TIMEOUT")).toBe(true);
        expect(shouldAutoRetryDeep("FIRST_TOKEN_TIMEOUT")).toBe(true);
        expect(shouldAutoRetryDeep("Missing critical XML tags")).toBe(true);
        expect(shouldAutoRetryDeep("AI_HTTP_503")).toBe(true);
    });

    it("致命错误不兜底重试", () => {
        expect(shouldAutoRetryDeep("AI_HTTP_402 quota")).toBe(false);
        expect(shouldAutoRetryDeep("AI_NOT_CONFIGURED")).toBe(false);
        expect(shouldAutoRetryDeep("AI_HTTP_401")).toBe(false);
    });
});
