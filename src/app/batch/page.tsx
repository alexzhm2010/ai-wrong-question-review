"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { BatchJobList } from "@/components/batch-job-list";
import { refreshActiveBatch } from "@/lib/batch-store";
import { CorrectionEditor } from "@/components/correction-editor";
import type { ParsedQuestion } from "@/lib/ai";
import {
    AlertTriangle, ArrowLeft, CheckCircle2, Clock, ImagePlus, Loader2,
    PauseCircle, RefreshCw, Trash2, XCircle,
} from "lucide-react";

type JobStatus = "queued" | "processing" | "confirming" | "paused" | "done" | "canceled";
type ItemStatus = "pending" | "processing" | "done" | "failed" | "saved";

interface BatchJob {
    id: string;
    status: JobStatus;
    reasoningMode: "fast" | "deep";
    totalCount: number;
    doneCount: number;
    failedCount: number;
    savedCount: number;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    errorMessage?: string | null;
    createdAt: string;
}

interface BatchItem {
    id: string;
    idx: number;
    status: ItemStatus;
    thumbBase64?: string | null;
    questionText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
    subjectId?: string | null;
    subjectName?: string | null;
    gradeSemester?: string | null;
    knowledgePoints?: string[];
    errorItemId?: string | null;
    failureReason?: string | null;
    autoDeepRetry?: boolean;
    answerConflict?: boolean;
    originalAnswerText?: string | null;
    hasImage?: boolean;
}

/** 心跳超过该值即判定「可能已中断」：深度单张 80s，必须留出函数 150s 上限的余量 */
const STALL_MS = 200_000;

function formatDuration(sec: number): string {
    // 先取整再拆分，否则 239.6s 会拆成「3m60s」
    const total = Math.max(0, Math.round(sec));
    if (total < 60) return `${total}s`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m${s}s` : `${m}m`;
}

function statusMeta(status: JobStatus, b: any) {
    switch (status) {
        case "queued": return { label: b.queued, cls: "bg-muted text-muted-foreground" };
        case "processing": return { label: b.processing, cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400" };
        case "confirming": return { label: b.confirming, cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" };
        case "paused": return { label: b.paused, cls: "bg-orange-500/10 text-orange-600 dark:text-orange-400" };
        case "done": return { label: b.done, cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
        default: return { label: b.canceled, cls: "bg-muted text-muted-foreground" };
    }
}

/* --------------------------------- 列表页 --------------------------------- */

function BatchList() {
    const { t } = useLanguage();
    const b = t.batch;

    return (
        <div className="mx-auto w-full max-w-3xl space-y-4 p-3 sm:p-6">
            <div className="flex items-center gap-2">
                <Link href="/"><Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button></Link>
                <h1 className="text-lg font-semibold sm:text-xl">{b.tab}</h1>
            </div>
            <BatchJobList />
        </div>
    );
}

/* --------------------------------- 详情页 --------------------------------- */

function BatchDetail({ jobId }: { jobId: string }) {
    const { t } = useLanguage();
    const b = t.batch;
    const router = useRouter();
    const [job, setJob] = useState<BatchJob | null>(null);
    const [items, setItems] = useState<BatchItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState<BatchItem | null>(null);
    // 校对时展示的原图：先用 240px 缩略图占位，随后替换为按需拉取的清晰原图
    const [editingImage, setEditingImage] = useState<string | null>(null);

    const openEditor = (item: BatchItem) => {
        setEditing(item);
        setEditingImage(item.thumbBase64 ? `data:image/jpeg;base64,${item.thumbBase64}` : null);
        // 详情接口不返回原图（避免一次拉几十 MB），点开这一条时单独取；
        // 不依赖 hasImage 判断，取不到就继续用缩略图占位。
        void apiClient
            .get<{ imageBase64: string }>("/api/batch/item-image", { params: { itemId: item.id } })
            .then((res) => {
                if (res?.imageBase64) setEditingImage(`data:image/jpeg;base64,${res.imageBase64}`);
            })
            .catch(() => {
                /* 拉取失败就保留缩略图，至少不影响改题 */
            });
    };
    const [clock, setClock] = useState(Date.now());
    const touched = useRef<Set<string>>(new Set());
    const initialized = useRef(false);

    const load = useCallback(async () => {
        try {
            const data = await apiClient.get<{ job: BatchJob; items: BatchItem[] }>("/api/batch/detail", { params: { id: jobId } });
            setJob(data.job);
            setItems(data.items);
            // 首次加载：已完成且非「批内重复」的默认勾选；之后新完成的自动补勾（用户手动取消过的不再动）
            setChecked((prev) => {
                const next = new Set(prev);
                const seen = new Set<string>();
                for (const item of data.items) {
                    const key = (item.questionText || "").replace(/\s+/g, "").slice(0, 80);
                    const dup = !!key && seen.has(key);
                    if (key) seen.add(key);
                    if (item.status !== "done" || !item.questionText || dup) continue;
                    if (!initialized.current && !touched.current.has(item.id)) next.add(item.id);
                    else if (initialized.current && !touched.current.has(item.id) && !prev.has(item.id)) next.add(item.id);
                }
                initialized.current = true;
                return next;
            });
        } catch (e: any) {
            toast.error(e?.message || t.common.error);
        } finally {
            setLoading(false);
        }
    }, [jobId, t.common.error]);

    useEffect(() => { void load(); }, [load]);

    // 解析中轮询；确认态不轮询，避免无谓请求
    useEffect(() => {
        if (!job) return;
        if (job.status !== "queued" && job.status !== "processing") return;
        const timer = setInterval(() => { void load(); }, 4000);
        return () => clearInterval(timer);
    }, [job?.status, load]);

    useEffect(() => {
        const timer = setInterval(() => setClock(Date.now()), 10_000);
        return () => clearInterval(timer);
    }, []);

    const selectable = useMemo(
        () => items.filter((i) => i.status === "done" && i.questionText),
        [items],
    );
    const savedCount = useMemo(() => items.filter((i) => i.status === "saved").length, [items]);
    const stalled = !!job && job.status === "processing" && !!job.heartbeatAt
        && clock - new Date(job.heartbeatAt).getTime() > STALL_MS;
    const currentIdx = items.find((i) => i.status === "processing")?.idx;

    const elapsed = job?.startedAt ? (Date.now() - new Date(job.startedAt).getTime()) / 1000 : 0;
    const finished = items.filter((i) => i.status === "done" || i.status === "saved").length;
    const pct = items.length ? Math.round((finished / items.length) * 100) : 0;
    const remainMin = finished > 0 && items.length > finished
        ? Math.max(1, Math.round(((elapsed / finished) * (items.length - finished)) / 60))
        : 0;

    const toggle = (id: string) => {
        touched.current.add(id);
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const toggleAll = () => {
        selectable.forEach((i) => touched.current.add(i.id));
        if (checked.size >= selectable.length) setChecked(new Set());
        else setChecked(new Set(selectable.map((i) => i.id)));
    };

    const saveSelected = async (ids?: string[]) => {
        const target = ids && ids.length ? ids : [...checked];
        if (!target.length || saving) return;
        setSaving(true);
        try {
            const res = await apiClient.post<{ saved: number; skipped: number }>("/api/batch/save", {
                jobId,
                itemIds: target,
            }, { timeout: 180000 });
            toast.success(b.savedToast.replace("{count}", String(res.saved)));
            if (res.skipped) toast.info(b.skippedToast.replace("{count}", String(res.skipped)));
            touched.current.clear();
            setChecked(new Set());
            await load();
            refreshActiveBatch();
        } catch (e: any) {
            toast.error(e?.message || t.common.error);
        } finally {
            setSaving(false);
        }
    };

    const act = async (path: string, body: Record<string, any>, confirmText?: string) => {
        if (confirmText && !window.confirm(confirmText)) return;
        try {
            await apiClient.post(`/api/batch/${path}`, body, { timeout: 60000 });
            await load();
            refreshActiveBatch();
        } catch (e: any) {
            toast.error(e?.message || t.common.error);
        }
    };

    const editSave = async (data: ParsedQuestion & { subjectId?: string; gradeSemester?: string }) => {
        if (!editing) return;
        const willSave = editing.status !== "saved";
        try {
            await apiClient.post("/api/batch/update", {
                itemId: editing.id,
                patch: {
                    questionText: data.questionText,
                    answerText: data.answerText,
                    analysis: data.analysis,
                    subjectId: data.subjectId,
                    gradeSemester: data.gradeSemester,
                    knowledgePoints: data.knowledgePoints,
                },
            });
            setEditing(null);
            setEditingImage(null);
            // 校对完点保存 = 确认入库，不用再回到底部勾选一次
            let savedNow = 0;
            if (willSave) {
                const res = await apiClient.post<{ saved: number; skipped: number }>("/api/batch/save", {
                    jobId,
                    itemIds: [editing.id],
                }, { timeout: 120000 }).catch(() => null);
                savedNow = res?.saved || 0;
                if (res && !savedNow) toast.info(b.skippedToast.replace("{count}", "1"));
            }
            await load();
            refreshActiveBatch();
            toast.success(savedNow ? b.savedOneToast : t.common.success);
        } catch (e: any) {
            toast.error(e?.message || t.common.error);
        }
    };

    if (loading) {
        return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
    }
    if (!job) {
        return (
            <div className="mx-auto max-w-3xl p-6 text-center">
                <p className="text-sm text-muted-foreground">{b.empty}</p>
                <Button className="mt-3" variant="outline" onClick={() => router.push("/batch")}>{b.tab}</Button>
            </div>
        );
    }

    const meta = statusMeta(job.status, b);
    const doneCount = items.filter((i) => i.status === "done" || i.status === "saved").length;

    return (
        <div className="mx-auto w-full max-w-4xl pb-24">
            <div className="sticky top-0 z-10 space-y-2 border-b bg-background/95 p-3 backdrop-blur sm:p-4">
                <div className="flex items-center gap-2">
                    <Link href="/batch"><Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button></Link>
                    <h1 className="min-w-0 flex-1 truncate text-base font-semibold sm:text-lg">
                        {b.tab} · {new Date(job.createdAt).toLocaleDateString()}
                    </h1>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", meta.cls)}>
                        {meta.label}
                    </span>
                </div>

                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{b.progress.replace("{done}", String(doneCount)).replace("{total}", String(items.length))}</span>
                    {job.status === "processing" && currentIdx !== undefined && (
                        <span>{b.current.replace("{n}", String(currentIdx + 1))}</span>
                    )}
                    {elapsed > 0 && <span>{b.elapsed.replace("{time}", formatDuration(elapsed))}</span>}
                    {job.status === "processing" && remainMin > 0 && (
                        <span>{b.remaining.replace("{time}", `${remainMin} min`)}</span>
                    )}
                    <span>{job.reasoningMode === "deep" ? b.deep : b.fast}</span>
                </div>

                {stalled && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{b.stalled}</span>
                        <Button size="sm" variant="outline" className="h-7" onClick={() => act("retry", { jobId })}>
                            {b.resume}
                        </Button>
                    </div>
                )}
                {job.status === "paused" && (
                    <div className="flex items-center gap-2 rounded-md border border-orange-500/40 bg-orange-500/10 px-2.5 py-2 text-xs text-orange-700 dark:text-orange-400">
                        <PauseCircle className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{job.errorMessage || b.paused}</span>
                        <Button size="sm" variant="outline" className="h-7" onClick={() => act("retry", { jobId })}>
                            {b.resume}
                        </Button>
                    </div>
                )}
                {job.status === "queued" && clock - new Date(job.createdAt).getTime() > 45_000 && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span className="flex-1">{b.queuedStalled}</span>
                        <Button size="sm" variant="outline" className="h-7" onClick={() => act("retry", { jobId })}>
                            {b.resume}
                        </Button>
                    </div>
                )}
                {job.status === "confirming" && (
                    <p className="text-[11px] text-muted-foreground">
                        {selectable.length
                            ? b.confirmSubtitle
                            : b.confirmDone.replace("{saved}", String(savedCount))}
                    </p>
                )}
                {job.status === "processing" && (
                    <p className="text-[11px] text-muted-foreground">{b.partialHint}</p>
                )}
            </div>

            <div className="space-y-2 p-3 sm:p-4">
                {items.map((item) => {
                    const key = (item.questionText || "").replace(/\s+/g, "").slice(0, 80);
                    const dup = !!key && items.filter((i) => (i.questionText || "").replace(/\s+/g, "").slice(0, 80) === key).length > 1;
                    const disabled = item.status !== "done" || !item.questionText;
                    return (
                        <div
                            key={item.id}
                            className={cn(
                                "flex gap-2.5 rounded-lg border bg-card p-2.5 transition-colors sm:gap-3 sm:p-3",
                                item.status === "saved" && "opacity-60",
                                item.status === "failed" && "border-destructive/30",
                            )}
                        >
                            <div className="pt-1">
                                <Checkbox
                                    checked={checked.has(item.id)}
                                    disabled={disabled}
                                    onCheckedChange={() => toggle(item.id)}
                                />
                            </div>

                            <button
                                className="flex min-w-0 flex-1 gap-2.5 text-left sm:gap-3"
                                onClick={() => (item.status === "done" || item.status === "saved") && openEditor(item)}
                            >
                                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border bg-muted sm:h-16 sm:w-16">
                                    {item.thumbBase64 ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={`data:image/jpeg;base64,${item.thumbBase64}`} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="flex h-full items-center justify-center text-muted-foreground">
                                            <ImagePlus className="h-5 w-5" />
                                        </div>
                                    )}
                                </div>

                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="text-[11px] text-muted-foreground">#{item.idx + 1}</span>
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                                            {item.subjectName || b.subjectLabel + "—"}
                                        </span>
                                        {item.gradeSemester && (
                                            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{item.gradeSemester}</span>
                                        )}
                                        {item.status === "saved" && (
                                            <span className="flex items-center gap-0.5 text-[11px] text-emerald-600">
                                                <CheckCircle2 className="h-3 w-3" />{b.saved}
                                            </span>
                                        )}
                                        {item.status === "failed" && (
                                            <span className="flex items-center gap-0.5 text-[11px] text-destructive">
                                                <XCircle className="h-3 w-3" />{b.failed}
                                            </span>
                                        )}
                                        {item.status === "pending" && (
                                            <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                                                <Clock className="h-3 w-3" />{b.pending}
                                            </span>
                                        )}
                                        {item.status === "processing" && (
                                            <span className="flex items-center gap-0.5 text-[11px] text-blue-600">
                                                <Loader2 className="h-3 w-3 animate-spin" />{b.processing}
                                            </span>
                                        )}
                                    </div>

                                    <p className="mt-1 line-clamp-2 text-sm">
                                        {item.questionText || item.failureReason || b.noQuestion}
                                    </p>
                                    {item.answerText && (
                                        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                            {b.answerLabel}：{item.answerText}
                                        </p>
                                    )}
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {!!item.knowledgePoints?.length && (
                                            <span className="text-[11px] text-muted-foreground">
                                                {item.knowledgePoints.slice(0, 2).join(" / ")}
                                            </span>
                                        )}
                                        {item.autoDeepRetry && (
                                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">{b.autoDeep}</span>
                                        )}
                                        {item.answerConflict && (
                                            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">{b.conflict}</span>
                                        )}
                                        {dup && item.status === "done" && (
                                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{b.duplicate}</span>
                                        )}
                                    </div>
                                </div>
                            </button>

                            {item.status === "failed" && (
                                <Button
                                    size="sm" variant="ghost" className="h-7 shrink-0 self-center px-2"
                                    onClick={() => act("retry", { jobId, itemId: item.id })}
                                >
                                    <RefreshCw className="mr-1 h-3.5 w-3.5" />{b.retry}
                                </Button>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* 底部固定操作栏：已归档/已取消时不再需要提交动作 */}
            {job.status !== "done" && job.status !== "canceled" && (
            <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
                <div className="mx-auto w-full max-w-4xl px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
                    <p className="mb-1.5 truncate text-[11px] text-muted-foreground">
                        {checked.size
                            ? b.selected.replace("{count}", String(checked.size))
                            : b.saveProgress.replace("{saved}", String(savedCount)).replace("{left}", String(selectable.length))}
                    </p>
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={toggleAll} disabled={!selectable.length} className="shrink-0 px-2">
                            {b.selectAll}
                        </Button>
                        {job.status === "confirming" && (
                            <Button
                                variant="ghost" size="icon" title={b.dismiss}
                                className="h-8 w-8 shrink-0 text-muted-foreground"
                                onClick={() => act("dismiss", { jobId }, b.dismissConfirm).then(() => router.push("/batch"))}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        )}
                        <div className="flex-1" />
                        {!!selectable.length && (
                            <Button
                                variant="outline" size="sm" className="shrink-0" disabled={saving}
                                onClick={() => saveSelected(selectable.map((i) => i.id))}
                            >
                                {b.saveAll.replace("{count}", String(selectable.length))}
                            </Button>
                        )}
                        <Button size="sm" className="shrink-0" disabled={!checked.size || saving} onClick={() => saveSelected()}>
                            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                            {b.saveSelected.replace("{count}", String(checked.size))}
                        </Button>
                    </div>
                </div>
            </div>
            )}

            <Dialog open={!!editing} onOpenChange={(v) => { if (!v) { setEditing(null); setEditingImage(null); } }}>
                <DialogContent className="max-h-[92svh] w-[calc(100vw_-_1rem)] max-w-4xl overflow-y-auto p-3 sm:p-6">
                    <DialogHeader className="pr-8">
                        <DialogTitle>{b.preview} #{editing ? editing.idx + 1 : ""}</DialogTitle>
                    </DialogHeader>
                    {editing && (
                        <CorrectionEditor
                            initialData={{
                                questionText: editing.questionText || "",
                                answerText: editing.answerText || "",
                                analysis: editing.analysis || "",
                                subject: (editing.subjectName || "其他") as ParsedQuestion["subject"],
                                knowledgePoints: editing.knowledgePoints || [],
                                wrongAnswerText: "",
                                mistakeAnalysis: "",
                                mistakeStatus: "unknown",
                                requiresImage: false,
                            }}
                            initialSubjectId={editing.subjectId || undefined}
                            imagePreview={editingImage}
                            onSave={editSave}
                            onCancel={() => { setEditing(null); setEditingImage(null); }}
                            saveLabel={editing.status === "saved" ? b.saveEdit : b.saveAndImport}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

/* --------------------------------- 入口页 --------------------------------- */

function BatchContent() {
    const searchParams = useSearchParams();
    const id = searchParams.get("id");
    return id ? <BatchDetail jobId={id} /> : <BatchList />;
}

export default function BatchPage() {
    return (
        <Suspense fallback={<div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
            <BatchContent />
        </Suspense>
    );
}
