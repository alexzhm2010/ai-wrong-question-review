"use client";

/**
 * 活跃批次的单例状态源。
 *
 * 首页横幅、tab 琥珀色、导航角标都要读「有几个批次在跑 / 待确认」，
 * 各自轮询会打多份请求，所以这里做一份共享订阅：第一个订阅者启动轮询，
 * 最后一个退订时停止。
 *
 * 注意：这里是「多个批次」而不是一个 —— 同账号可以连续建多批，队列串行执行。
 */
import { useSyncExternalStore } from "react";
import { apiClient } from "@/lib/api-client";

export interface ActiveBatch {
    id: string;
    status: "draft" | "queued" | "processing" | "confirming" | "paused";
    totalCount: number;
    failedCount: number;
    reasoningMode: "fast" | "deep";
    createdAt: string;
    counts: { total: number; done: number; failed: number; saved: number; edited?: number };
}

let jobs: ActiveBatch[] | undefined = undefined; // undefined = 尚未加载
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit() {
    listeners.forEach((l) => l());
}

let retried = false;

async function fetchOnce() {
    try {
        const res = await apiClient.get<{ jobs: ActiveBatch[] }>("/api/batch/active");
        jobs = res.jobs || [];
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

/** 全部活跃批次（queued / processing / confirming / paused），按创建时间升序 */
export function useActiveBatches(): ActiveBatch[] {
    return useSyncExternalStore(
        subscribe,
        () => jobs ?? EMPTY,
        () => EMPTY,
    );
}

const EMPTY: ActiveBatch[] = [];

/** 兼容旧调用点：只看「最需要你处理」的那一个（paused > confirming > processing > queued） */
export function useActiveBatch(): ActiveBatch | null | undefined {
    const list = useActiveBatches();
    if (!list.length) return null;
    const weight = (s: ActiveBatch["status"]) =>
        s === "draft" ? 0 : s === "paused" ? 1 : s === "confirming" ? 2 : s === "processing" ? 3 : 4;
    return [...list].sort((a, b) => weight(a.status) - weight(b.status))[0];
}
