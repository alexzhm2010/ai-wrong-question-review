/**
 * 源码级回归：确认关键防护「确实接进了链路」，纯函数测试覆盖不到的接线处。
 * 与 analyze-timeout.test.ts 配套：一个测决策，一个测接线。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const edgeIndex = readFileSync(
    resolve(__dirname, "../../../supabase/functions/ai-proxy/index.ts"), "utf-8",
);
const streamAnalyze = readFileSync(
    resolve(__dirname, "../../lib/stream-analyze.ts"), "utf-8",
);
const homePage = readFileSync(resolve(__dirname, "../../app/page.tsx"), "utf-8");
const logger = readFileSync(resolve(__dirname, "../../lib/frontend-logger.ts"), "utf-8");

describe("Edge analyze 链路接线", () => {
    it("主模型带首字节超时 + 整体超时双护栏", () => {
        expect(edgeIndex).toContain("firstTokenTimeoutMs: Math.min(FIRST_TOKEN_TIMEOUT_MS, budgetMs)");
        expect(edgeIndex).toContain("overallTimeoutMs: budgetMs");
    });

    it("请求级硬截止 + 降级快速,且降级前发 reset", () => {
        expect(edgeIndex).toContain("ANALYZE_HARD_DEADLINE_MS");
        expect(edgeIndex).toContain("canDegradeToFast(");
        expect(edgeIndex).toContain('send({ type: "reset" })');
    });

    it("error 分支统一 close 流（fail 里 close），杜绝悬挂", () => {
        expect(edgeIndex).toContain("const fail = (e: unknown) =>");
        expect(edgeIndex).toContain("close();");
        // 主模型失败的所有出口都经过 fail 或 close
        expect(edgeIndex).not.toContain("send({ type: \"error\", message: e instanceof Error ? e.message : String(e) });\n          return;");
    });

    it("chat() catch 把 guard 超时转成结构化错误码", () => {
        expect(edgeIndex).toContain('if (guardReason === "FIRST_TOKEN_TIMEOUT" || guardReason === "STREAM_TIMEOUT")');
        expect(edgeIndex).toContain("throw timeoutError(guardReason)");
    });
});

describe("前端 stream-analyze 接线", () => {
    it("默认超时引用平台感知常量，不再硬编码 180000", () => {
        expect(streamAnalyze).toContain("timeout = CLIENT_ANALYZE_TIMEOUT_MS");
        expect(streamAnalyze).not.toContain("timeout = 180000");
    });

    it("处理 reset 事件并回调 onReset", () => {
        expect(streamAnalyze).toContain('payload.type === "reset"');
        expect(streamAnalyze).toContain("onReset?.()");
    });

    it("超时归一为 ANALYZE_TIMEOUT 供兜底识别", () => {
        expect(streamAnalyze).toContain('message: "ANALYZE_TIMEOUT"');
    });

    it("首页兜底用 shouldAutoRetryDeep,并记录诊断日志", () => {
        expect(homePage).toContain("shouldAutoRetryDeep(message)");
        expect(homePage).toContain('frontendLogger.error(\'[HomeAnalyze]\', \'analyze stream failed\'');
        expect(homePage).toContain("clampAnalyzeTimeout(config?.timeouts?.analyze)");
    });
});

describe("前端日志脱敏上报接线", () => {
    it("warn/error 走 fire-and-forget 上报,info 不上传", () => {
        expect(logger).toContain("if (level === 'info') return;");
        expect(logger).toContain("fetch('/api/logs/frontend'");
        expect(logger).toContain("keepalive: true");
    });

    it("脱敏：敏感键剔除 + 非标量丢弃 + 有上报上限", () => {
        expect(logger).toContain("SENSITIVE_KEY");
        expect(logger).toContain("base64");
        expect(logger).toContain("MAX_REPORTS");
        expect(logger).toContain("typeof value === 'string'");
    });
});
