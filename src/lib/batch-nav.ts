"use client";

import { BASE_PATH } from "./supabase/config";

/**
 * 批次详情的打开方式：sessionStorage 传 id + 整页跳转，**不用 URL query**。
 *
 * 踩过的坑：静态导出下 `?id=` 会让 Next 去取 RSC 数据，GitHub Pages 上
 * `batch/index.txt?_rsc=` 是 404，点进批次后一直转圈；改成整页跳转 + query
 * 仍然在线上复现。这里彻底绕开 URL 参数，列表页把 id 放进 sessionStorage，
 * 详情页读它。刷新详情页仍然有效，关掉标签页自动清空。
 */
const OPEN_KEY = "wq:open-batch";

export function openBatch(id: string): void {
    if (typeof window === "undefined" || !id) return;
    try {
        sessionStorage.setItem(OPEN_KEY, id);
    } catch {
        /* 隐私模式写不进去就退回 URL 参数 */
        window.location.assign(`${BASE_PATH}/batch?id=${encodeURIComponent(id)}`);
        return;
    }
    window.location.assign(`${BASE_PATH}/batch`);
}

export function readOpenBatch(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const id = sessionStorage.getItem(OPEN_KEY);
        if (id) return id;
    } catch {
        /* 忽略 */
    }
    return new URLSearchParams(window.location.search).get("id");
}

export function clearOpenBatch(): void {
    try {
        sessionStorage.removeItem(OPEN_KEY);
    } catch {
        /* 忽略 */
    }
}

/** 回批次列表：清掉待打开的 id，否则列表页会立刻又跳回详情 */
export function backToBatch(): void {
    clearOpenBatch();
    if (typeof window !== "undefined") window.location.assign(`${BASE_PATH}/batch`);
}
