"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useThinkingMode } from "@/components/thinking-mode-toggle";
import { toast } from "@/lib/toast";
import { refreshActiveBatch } from "@/lib/batch-store";
import { DraftConflictError, createDraft, discardDraft, startDraft, uploadDraftImages } from "@/lib/batch-draft";
import { openBatch } from "@/lib/batch-nav";
import { Images, Loader2 } from "lucide-react";

interface Props {
    /** 选好的多张图；为空时不渲染 */
    files: File[];
    onCancel: () => void;
    /** 选择「先逐张检查」：父组件拿 jobId 打开检查队列 */
    onEditFirst?: (jobId: string) => void;
}

/**
 * 多选图片后的「轻确认」条。
 *
 * 不占整屏、不重开面板：只是一条贴在底部的确认条，避免手滑多选直接开始烧钱，
 * 同时保留「一秒就能反悔」的路径。确认后按上方「思考深度」设置执行。
 */
export function BatchQuickConfirm({ files, onCancel, onEditFirst }: Props) {
    const { t } = useLanguage();
    const b = t.batch;
    const [mode] = useThinkingMode();
    const [busy, setBusy] = useState(false);
    const [creating, setCreating] = useState(false);
    const [step, setStep] = useState(0);
    const [phase, setPhase] = useState<"upload" | "start">("upload");
    /** 撞上「已有草稿没处理完」时，记住刚才想做的事，丢弃旧的之后原样重试 */
    const [conflict, setConflict] = useState<{ id: string; count: number } | null>(null);
    const retryRef = useRef<() => void>(() => {});

    /** 409 已经不是错误，而是一个需要用户选择的分叉 */
    const isConflict = (e: unknown): e is DraftConflictError => e instanceof DraftConflictError;

    if (!files.length) return null;

    const count = files.length;
    const minutes = Math.max(1, Math.round((count * (mode === "deep" ? 80 : 20)) / 60));
    const cost = (count * (mode === "deep" ? 0.019 : 0.008)).toFixed(2);

    /**
     * 开始解析也走「先建草稿、再逐张上传」：
     * 一次性 POST 30 张会在手机上凑出 40MB 请求体，而且中途断网整批白跑。
     * 现在每张落库后再启动，页面关了也能在批量 tab 里接着跑。
     */
    const start = async () => {
        if (busy || creating) return;
        setBusy(true);
        setStep(0);
        setPhase("upload");
        try {
            const id = await createDraft(count, mode);
            const { failed } = await uploadDraftImages(id, files, (done) => setStep(done));
            if (failed) toast.error(`有 ${failed} 张上传失败，将只解析成功的 ${count - failed} 张`);
            setPhase("start");
            await startDraft(id);
            refreshActiveBatch();
            toast.success(`${b.progress} ${count}`);
            openBatch(id);
        } catch (e: any) {
            if (isConflict(e)) {
                setConflict({ id: e.existingId, count: e.existingCount });
                retryRef.current = start;
            } else {
                toast.error(e?.message || t.common.error);
            }
            setBusy(false);
        }
    };

    const editFirst = async () => {
        if (busy || creating || !onEditFirst) return;
        setCreating(true);
        try {
            const id = await createDraft(count, mode);
            onEditFirst(id);
        } catch (e: any) {
            if (isConflict(e)) {
                setConflict({ id: e.existingId, count: e.existingCount });
                retryRef.current = editFirst;
            } else {
                toast.error(e?.message || "创建任务失败，请重试");
            }
        } finally {
            setCreating(false);
        }
    };

    const dropOldAndRetry = async () => {
        if (!conflict) return;
        try {
            await discardDraft(conflict.id);
            setConflict(null);
            refreshActiveBatch();
            retryRef.current();
        } catch (e: any) {
            toast.error(e?.message || "丢弃失败，请重试");
        }
    };

    return (
        <div className="fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t bg-background/95 shadow-[0_-6px_20px_rgba(0,0,0,0.08)] backdrop-blur">
            <div className="mx-auto w-full max-w-3xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {conflict ? (
                    <>
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
                                <Images className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                    上一批 {conflict.count} 张还没检查完
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                    同一时间只留一批，先处理完它，或者丢弃它再开新的
                                </p>
                            </div>
                        </div>
                        <div className="mt-2.5 flex gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex-1"
                                onClick={dropOldAndRetry}
                            >
                                丢弃旧的，用这批
                            </Button>
                            <Button size="sm" className="flex-1" onClick={() => openBatch(conflict.id)}>
                                去处理
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                {busy || creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                    {busy
                                        ? (phase === "start"
                                            ? "正在启动解析…"
                                            : b.preparing.replace("{done}", String(step)).replace("{total}", String(count)))
                                        : creating
                                            ? "正在准备检查队列…"
                                            : b.quickConfirm.replace("{count}", String(count))}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                    {mode === "fast" ? b.fast : b.deep} · {b.eta.replace("{min}", String(minutes)).replace("{cost}", cost)}
                                </p>
                            </div>
                            <Button variant="ghost" size="sm" className="shrink-0" disabled={busy || creating} onClick={onCancel}>
                                {t.common.cancel}
                            </Button>
                        </div>
                        {/*
                         * 「先检查」必须是主按钮。
                         * 旧版把它做成 11px 的一行小字贴在最底下，看着像说明而非入口，
                         * 用户选完图只会看到「开始解析」，等于没有编辑机会 —— 这正是批量导入
                         * 最核心的诉求。现在两个动作平级、各占一半，默认推荐先检查。
                         */}
                        <div className="mt-2.5 flex gap-2">
                            {onEditFirst && (
                                <Button
                                    size="sm"
                                    className="h-10 flex-1 font-medium"
                                    disabled={busy || creating}
                                    onClick={editFirst}
                                >
                                    {b.reviewFirst}
                                </Button>
                            )}
                            <Button
                                size="sm"
                                variant={onEditFirst ? "outline" : "default"}
                                className="h-10 flex-1 font-medium"
                                disabled={busy || creating}
                                onClick={start}
                            >
                                {b.startDirect}
                            </Button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
