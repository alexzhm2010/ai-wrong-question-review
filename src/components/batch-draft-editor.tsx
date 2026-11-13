"use client";

/**
 * 批量草稿：先传图、再逐张检查、最后统一开始解析。
 *
 * 为什么单独做一个队列而不是复用单张编辑器：
 * 批量场景的核心不是「编辑」，是「30 张里快速扫一遍，只处理有问题的那几张」。
 * 所以每张进来就能直接看大图、点「不处理」下一张，改动才上传。
 *
 * 断点恢复：所有图片在进入队列前已经写进 BatchItem，编辑结果也是逐张覆盖。
 * 浏览器崩了重新进来，从第一个还没检查的那张继续，前面改过的都在。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/toast";
import { refreshActiveBatch } from "@/lib/batch-store";
import { startDraft, uploadDraftImages } from "@/lib/batch-draft";
import { imageSrc, ingestImage } from "@/lib/storage";
import { ImageEditor } from "@/components/image-editor";

interface DraftItem {
    id: string;
    idx: number;
    status: string;
    thumbBase64?: string | null;
}

interface Props {
    jobId: string;
    /** 新建草稿时传原始文件；恢复草稿时不传，从服务端拉条目 */
    files?: File[];
    onClose: () => void;
    onStarted: (jobId: string) => void;
}

export function BatchDraftEditor({ jobId, files, onClose, onStarted }: Props) {
    const [phase, setPhase] = useState<"upload" | "edit" | "starting">("upload");
    const [progress, setProgress] = useState({ done: 0, total: files?.length || 0 });
    const [items, setItems] = useState<DraftItem[]>([]);
    const [index, setIndex] = useState(0);
    const [src, setSrc] = useState("");
    const [loadingSrc, setLoadingSrc] = useState(true);
    const busyRef = useRef(false);

    const enterEdit = useCallback(async () => {
        try {
            const res = await apiClient.get<{ job: unknown; items: DraftItem[] }>(
                "/api/batch/draft-detail",
                { params: { id: jobId } },
            );
            const list = [...(res.items || [])].sort((a, b) => a.idx - b.idx);
            setItems(list);
            // 恢复时从第一张没检查过的开始；全检查过了就从头，方便复查
            const first = list.findIndex((i) => i.status === "pending");
            setIndex(first >= 0 ? first : 0);
            setPhase("edit");
        } catch {
            toast.error("读取这批图片失败，请稍后重试");
            onClose();
        }
    }, [jobId, onClose]);

    /* ------------------------------ 上传阶段 ------------------------------ */
    useEffect(() => {
        if (!files?.length) {
            void enterEdit();
            return;
        }
        let cancelled = false;
        setProgress({ done: 0, total: files.length });

        void uploadDraftImages(jobId, files, (done, total) => {
            if (!cancelled) setProgress({ done, total });
        }).then(({ failed }) => {
            if (cancelled) return;
            if (failed) toast.error(`有 ${failed} 张上传失败，可以先处理已上传的`);
            void enterEdit();
        });

        return () => {
            cancelled = true;
        };
    }, [files, jobId, enterEdit]);

    /* ---------------------------- 当前张的原图 ---------------------------- */
    useEffect(() => {
        if (phase !== "edit") return;
        const item = items[index];
        if (!item) return;
        let cancelled = false;
        setLoadingSrc(true);
        setSrc("");
        apiClient
            .get<{ imageBase64: string }>("/api/batch/item-image", { params: { itemId: item.id } })
            .then((r) => {
                if (cancelled) return;
                setSrc(imageSrc(r.imageBase64));
            })
            .catch(() => {
                if (cancelled) return;
                setSrc("");
                toast.error("这一张的原图读取失败");
            })
            .finally(() => {
                if (!cancelled) setLoadingSrc(false);
            });
        return () => {
            cancelled = true;
        };
    }, [phase, index, items]);

    const next = () => {
        if (index + 1 < items.length) setIndex(index + 1);
        else void finish();
    };

    const finish = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setPhase("starting");
        try {
            await startDraft(jobId);
            refreshActiveBatch();
            toast.success("已开始解析，可以在「批量进展跟踪」里看进度");
            onStarted(jobId);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "启动失败，请重试");
            setPhase("edit");
            busyRef.current = false;
        }
    };

    const saveAndNext = async (dataUrl: string, changed: boolean) => {
        const item = items[index];
        if (!item) return;
        // 用户只是点「完成」看一眼没改：别重传一遍图，30 张能省一大半流量
        if (!changed) {
            next();
            return;
        }
        try {
            // 编辑结果同样走存储层：inline 下就是 data URL，换远程存储时这里会自动变成对象引用
            const { ref, thumb } = await ingestImage(dataUrl, {
                role: "draft",
                ownerId: jobId,
                thumb: true,
            });
            await apiClient.post(
                "/api/batch/image",
                { jobId, idx: item.idx, image: ref, thumb, edited: true },
                { timeout: 90000 },
            );
            // 本地也标记一下，避免抽回列表时又提示「未检查」
            setItems((prev) =>
                prev.map((it, i) => (i === index ? { ...it, status: "edited" } : it)),
            );
            next();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "保存失败，请重试");
        }
    };

    /* -------------------------------- 渲染 -------------------------------- */
    if (phase === "upload" || phase === "starting") {
        const starting = phase === "starting";
        const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
        return (
            <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-4 bg-slate-950 px-8 text-white">
                <Loader2 className="h-7 w-7 animate-spin text-blue-400" />
                <p className="text-sm font-medium">
                    {starting ? "正在启动解析…" : `正在上传图片 ${progress.done}/${progress.total}`}
                </p>
                {!starting && (
                    <>
                        <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/15">
                            <div
                                className="h-full rounded-full bg-blue-500 transition-all"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <p className="max-w-xs text-center text-[11px] text-white/40">
                            图片正在写入任务，中途关页面也不会丢；上传完会进入逐张检查
                        </p>
                    </>
                )}
            </div>
        );
    }

    const item = items[index];
    if (!item || (!src && loadingSrc)) {
        return (
            <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 bg-slate-950 text-white/70">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="text-sm">正在打开第 {index + 1} 张…</p>
                <button type="button" onClick={onClose} className="text-xs text-white/40 underline">
                    先退出，稍后继续
                </button>
            </div>
        );
    }

    return (
        <ImageEditor
            open
            imageSrc={src}
            title="批量检查"
            subtitle="有问题改完点「完成」，没问题点「不处理」"
            initialMode="erase"
            progressLabel={`${index + 1}/${items.length}`}
            onSkip={next}
            onCancel={onClose}
            onDone={saveAndNext}
        />
    );
}
