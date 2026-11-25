// 前端流式消费 /api/analyze 的 SSE 响应。
// 后端逐段推送 {type:'delta',content} / {type:'done',result} / {type:'error',message}。
import type { ParsedQuestion } from "@/lib/ai/types";
import { CLIENT_ANALYZE_TIMEOUT_MS } from "@/lib/analyze-timeout";

export interface StreamAnalyzeOptions {
    imageBase64: string;
    language: "zh" | "en";
    subjectId?: string;
    /** 本题的思考深度：deep=深度思考（默认），fast=关闭思考 */
    reasoningMode?: "deep" | "fast";
    /** 超时（毫秒），默认 140000（必须小于平台 150s，留出兜底重试衔接时间） */
    timeout?: number;
    /** 外部取消信号（如用户点击取消） */
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    /** Edge 端降级前发 reset，要求前端丢弃已累积的流式文本，避免两段内容拼接 */
    onReset?: () => void;
    onDone: (result: ParsedQuestion) => void;
    onError: (message: string) => void;
}

interface SSEPayload {
    type: "delta" | "reset" | "done" | "error";
    content?: string;
    result?: ParsedQuestion;
    message?: string;
}

/**
 * 调用 /api/analyze 并以流式方式消费返回结果。
 * 解析 text/event-stream 格式（每行 `data: <json>` 以 `\n\n` 分隔）。
 */
export async function streamAnalyze(opts: StreamAnalyzeOptions): Promise<void> {
    const {
        imageBase64,
        language,
        subjectId,
        reasoningMode,
        timeout = CLIENT_ANALYZE_TIMEOUT_MS,
        signal,
        onDelta,
        onReset,
        onDone,
        onError,
    } = opts;

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeout) {
        timeoutId = setTimeout(() => controller.abort(), timeout);
    }

    const onExternalAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let completed = false;

    try {
        const res = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                imageBase64,
                language,
                subjectId,
                reasoningMode,
            }),
            signal: controller.signal,
        });

        if (!res.ok || !res.body) {
            let message = `HTTP ${res.status}`;
            try {
                const errJson = await res.json();
                message = errJson?.message || message;
            } catch {
                /* ignore */
            }
            const err: any = new Error(message);
            err.data = { message };
            throw err;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const flushBuffer = () => {
            let sep: number;
            while ((sep = buffer.indexOf("\n\n")) >= 0) {
                const raw = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const dataLine = raw
                    .split("\n")
                    .find((l) => l.startsWith("data: "));
                if (!dataLine) continue;
                let payload: SSEPayload;
                try {
                    payload = JSON.parse(dataLine.slice(6)) as SSEPayload;
                } catch {
                    continue;
                }
                if (payload.type === "delta" && payload.content) {
                    onDelta(payload.content);
                } else if (payload.type === "reset") {
                    // Edge 端深度超时降级快速前发来：丢弃已累积文本，避免拼接
                    onReset?.();
                } else if (payload.type === "done" && payload.result) {
                    completed = true;
                    onDone(payload.result);
                } else if (payload.type === "error" && payload.message) {
                    const err: any = new Error(payload.message);
                    err.data = { message: payload.message };
                    throw err;
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            flushBuffer();
        }
        // 处理末尾残留
        buffer += decoder.decode();
        flushBuffer();

        if (!completed) {
            const err: any = new Error("Analysis stream ended before completion");
            err.data = { message: "AI_RESPONSE_ERROR" };
            throw err;
        }
    } catch (error) {
        if (controller.signal.aborted && !completed) {
            // 区分「外部主动取消」与「前端自身超时」：
            // 外部 signal.aborted（用户点取消）原样抛；否则是 timeout 触发，归一成
            // ANALYZE_TIMEOUT，让上层 fast→deep 兜底能识别并自动重试。
            const externallyAborted = signal?.aborted === true;
            if (externallyAborted) throw error;
            const err: any = new Error("Analysis timed out");
            err.data = { message: "ANALYZE_TIMEOUT" };
            throw err;
        }
        throw error;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onExternalAbort);
    }
}
