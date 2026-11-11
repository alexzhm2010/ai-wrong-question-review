"use client";

/**
 * 活跃批次的单例状态源。
 *
 * 首页横幅和导航角标都要读「有没有批次在跑 / 待确认」，
 * 各自轮询会打两份请求，所以这里做一份共享订阅：第一个订阅者启动轮询，
 * 最后一个退订时停止。
 */
import { useSyncExternalStore } from "react";
import { apiClient } from "@/lib/api-client";

export interface ActiveBatch {
    id: string;
    status: "queued" | "processing" | "confirming" | "paused";
    totalCount: number;
    failedCount: number;
    reasoningMode: "fast" | "deep";
    counts: { total: number; done: number; failed: number; saved: number };
}

let job: ActiveBatch | null | undefined = undefined; // undefined = 尚未加载
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
    listeners.forEach((l) => l());
}

let retried = false;

async function fetchOnce() {
    try {
        const res = await apiClient.get<{ job: ActiveBatch | null }>("/api/batch/active");
        job = res.job;
        retried = false;
    } catch {
        // 首页可能在会话恢复前就发出首个请求（401），补一次即可，不要无限重试
        if (!retried) {
            retried = true;
            setTimeout(() => void fetchOnce(), 1200);
        }
    }
    emit();
}

function subscribe(cb: () => void) {
    listeners.add(cb);
    if (listeners.size === 1) {
        void fetchOnce();
        timer = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState === "visible") void fetchOnce();
        }, 10_000);
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", onVisible);
        }
    }
    return () => {
        listeners.delete(cb);
        if (listeners.size === 0 && timer) {
            clearInterval(timer);
            timer = null;
            if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
        }
    };
}

function onVisible() {
    if (document.visibilityState === "visible") void fetchOnce();
}

/** 供批量操作完成后主动刷新（保存/取消后角标要立刻变） */
export function refreshActiveBatch() {
    void fetchOnce();
}

export function useActiveBatch(): ActiveBatch | null | undefined {
    return useSyncExternalStore(
        subscribe,
        () => job,
        () => undefined,
    );
}
