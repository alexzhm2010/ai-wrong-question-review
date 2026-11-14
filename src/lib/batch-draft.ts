"use client";

/**
 * 批量草稿的客户端流水线：建任务 → 逐张上传 → 启动解析。
 *
 * 「直接开始」和「先逐张检查」走的是同一条上传链路，区别只在于中间要不要
 * 停下来让人看。共用一套的好处是：两条路都有断点，崩了都能在批量 tab 里接着来，
 * 也不会再出现「一次 POST 30 张、请求体 40MB」那种在手机上必炸的写法。
 */
import { ApiError, apiClient } from "./api-client";
import { ingestImage } from "./storage";

/** 并发数：一张解码后约 30MB，3 张已经接近手机单标签页的舒适上限 */
const CONCURRENCY = 3;

/**
 * 已有草稿没处理完。服务端规定同账号只允许一个活跃草稿，
 * 撞上时把旧的 id 带出来，让界面能给出「去处理 / 丢弃旧的」两个出口，
 * 而不是只弹一句「还有一批没处理完」让人无处可去。
 */
export class DraftConflictError extends Error {
    constructor(public existingId: string, public existingCount: number) {
        super("还有一批没处理完");
        this.name = "DraftConflictError";
    }
}

export async function createDraft(totalCount: number, mode: "fast" | "deep"): Promise<string> {
    try {
        const res = await apiClient.post<{ id: string }>("/api/batch/draft", {
            totalCount,
            reasoningMode: mode,
        });
        return res.id;
    } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
            const data = (e.data || {}) as { existingId?: string; existingCount?: number };
            if (data.existingId) {
                throw new DraftConflictError(data.existingId, Number(data.existingCount) || 0);
            }
        }
        throw e;
    }
}

/**
 * 草稿还剩几天被自动清理（向上取整）。
 * 与服务端 DRAFT_TTL_DAYS 保持一致：服务端按 updatedAt 算，这里同样。
 * 返回 0 表示已到期（下次打开就会被清掉）。
 */
export const DRAFT_TTL_DAYS = 7;
export function draftDaysLeft(updatedAt?: string | null): number {
    const base = Date.parse(updatedAt || "");
    if (!Number.isFinite(base)) return DRAFT_TTL_DAYS;
    const left = base + DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000 - Date.now();
    return Math.max(0, Math.ceil(left / (24 * 60 * 60 * 1000)));
}

/** 丢弃一个草稿（连同已上传的原图，BatchItem 级联删除） */
export async function discardDraft(jobId: string): Promise<void> {
    await apiClient.post("/api/batch/dismiss", { jobId }, { timeout: 30000 });
}

export async function uploadDraftImages(
    jobId: string,
    files: File[],
    onProgress?: (done: number, total: number) => void,
): Promise<{ failed: number }> {
    const queue = files.map((file, idx) => ({ file, idx }));
    const total = queue.length;
    let done = 0;
    let failed = 0;
    onProgress?.(0, total);

    const worker = async () => {
        while (queue.length) {
            const job = queue.shift();
            if (!job) break;
            try {
                // 压缩 + 缩略图 + 落引用，一步到位；切远程存储时这里不用改。
                // 批量草稿图要直接送模型，额外降一档像素：整页拍题图动辄 6M 像素，
                // 会把单次 AI 请求拖到超时。300 万像素≈A4 @175dpi，打印仍清晰。
                const { ref, thumb } = await ingestImage(job.file, {
                    role: "draft",
                    ownerId: jobId,
                    maxPixels: 3_000_000,
                });
                await apiClient.post(
                    "/api/batch/image",
                    { jobId, idx: job.idx, image: ref, thumb, edited: false },
                    { timeout: 90000 },
                );
            } catch {
                failed++;
            }
            done++;
            onProgress?.(done, total);
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
    return { failed };
}

export async function startDraft(jobId: string): Promise<void> {
    await apiClient.post("/api/batch/start", { jobId }, { timeout: 60000 });
}
