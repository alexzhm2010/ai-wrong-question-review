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
 *
 * ⚠️ 抗重渲染约定（v1.19.7，别改回去）：
 * 父页面订阅了 useActiveBatches()，每 10 秒一轮询就会 re-render 一次，
 * 而它传进来的 onClose / onStarted 是内联箭头函数、每次都是新引用。
 * 早期 enterEdit 依赖 onClose，上传 effect 依赖 enterEdit，于是每轮轮询都会
 * 重新 GET draft-detail → setItems(新数组) → 加载 effect 重新 setSrc("") →
 * ImageEditor 被卸载重挂载 → 用户刚做的裁剪/抹除全部蒸发，看起来就像
 * 「一点裁剪就跳回最开始」。现在：
 *   1. 回调放 ref，初始化 effect 只认 jobId，一辈子只跑一次；
 *   2. 当前张的图按 item.id 缓存，不在加载前清空 src；
 *   3. 加载 effect 只依赖 currentId，setItems 改状态不会触发重拉；
 *   4. ImageEditor 带 key={item.id}，只有真的换题才重挂载。
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
    /** 当前已就绪的图，连同它属于哪一条；同一张题的 src 必须保持稳定 */
    const [srcState, setSrcState] = useState<{ id: string; src: string } | null>(null);
    const [confirmStart, setConfirmStart] = useState(false);
    const busyRef = useRef(false);

    /* 外部回调每次 render 都是新函数，只借 ref 读最新值，绝不进 effect 依赖 */
    const onCloseRef = useRef(onClose);
    const onStartedRef = useRef(onStarted);
    useEffect(() => {
        onCloseRef.current = onClose;
        onStartedRef.current = onStarted;
    }, [onClose, onStarted]);
    /** files 只在挂载时有用，父组件后续 re-render 不应触发重传 */
    const filesRef = useRef(files);

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
            onCloseRef.current();
        }
    }, [jobId]);

    /* ------------------------------ 上传阶段 ------------------------------ */
    useEffect(() => {
        const initial = filesRef.current;
        if (!initial?.length) {
            let cancelled = false;
            // 丢进微任务：不在 effect 里同步触发 setState（React 19 lint 规则）
            queueMicrotask(() => { if (!cancelled) void enterEdit(); });
            return () => { cancelled = true; };
        }
        let cancelled = false;

        void uploadDraftImages(jobId, initial, (done, total) => {
            if (!cancelled) setProgress({ done, total });
        }).then(({ failed }) => {
            if (cancelled) return;
            if (failed) toast.error(`有 ${failed} 张上传失败，可以先处理已上传的`);
            void enterEdit();
        });

        return () => {
            cancelled = true;
        };
    }, [jobId, enterEdit]);

    /* ---------------------------- 当前张的原图 ---------------------------- */
    const currentId = items[index]?.id ?? "";
    useEffect(() => {
        if (phase !== "edit" || !currentId) return;
        let cancelled = false;
        // 不再 setSrc("")：清空会让 ImageEditor 先看到空 imageSrc、再看到新值，
        // 它的初始化 effect 会重跑，正在编辑的内容就没了。切题由 key 负责重挂载。
        // loading 状态直接从 srcState 是否对应当前 id 推导，不在 effect 里同步 setState。
        apiClient
            .get<{ imageBase64: string }>("/api/batch/item-image", { params: { itemId: currentId } })
            .then((r) => {
                if (cancelled) return;
                setSrcState({ id: currentId, src: imageSrc(r.imageBase64) });
            })
            .catch(() => {
                if (cancelled) return;
                toast.error("这一张的原图读取失败");
            });
        return () => {
            cancelled = true;
        };
        // 只认 item.id：setItems 标记「已编辑」不会重拉图片，父组件轮询也不会
    }, [phase, currentId]);

    const prev = () => {
        if (index > 0) setIndex(index - 1);
    };

    /** 走到最后一张时不静默开始解析，先给用户一次明确的确认 */
    const next = () => {
        if (index + 1 < items.length) setIndex(index + 1);
        else setConfirmStart(true);
    };

    const finish = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setConfirmStart(false);
        setPhase("starting");
        try {
            await startDraft(jobId);
            refreshActiveBatch();
            toast.success("已开始解析，可以在「批量进展跟踪」里看进度");
            onStartedRef.current(jobId);
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
            setItems((prevList) =>
                prevList.map((it, i) => (i === index ? { ...it, status: "edited" } : it)),
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
    const ready = item && srcState?.id === item.id && srcState.src;
    if (!ready) {
        return (
            <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 bg-slate-950 text-white/70">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="text-sm">正在打开第 {index + 1} 张…</p>
                <button type="button" onClick={() => onCloseRef.current()} className="text-xs text-white/40 underline">
                    先退出，稍后继续
                </button>
            </div>
        );
    }

    const isLast = index + 1 >= items.length;

    return (
        <>
            <ImageEditor
                key={item.id}
                open
                imageSrc={srcState.src}
                title="批量检查"
                subtitle="有问题改完点「保存并下一张」，没问题点「不处理」"
                initialMode="erase"
                progressLabel={`${index + 1}/${items.length}`}
                onPrev={index > 0 ? prev : undefined}
                skipLabel="不处理"
                doneLabel={isLast ? "完成并解析" : "保存并下一张"}
                onSkip={next}
                onCancel={() => onCloseRef.current()}
                onDone={saveAndNext}
            />

            {confirmStart && (
                <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-8">
                    <div className="w-full max-w-xs rounded-2xl bg-slate-900 p-5 text-white shadow-xl">
                        <p className="text-sm font-semibold">这批 {items.length} 张都看完了</p>
                        <p className="mt-2 text-xs leading-relaxed text-white/60">
                            点「开始解析」后才会调用 AI 逐张识别，中途可以退出，进度会保存在「批量进展跟踪」里。
                        </p>
                        <div className="mt-4 flex gap-2">
                            <button
                                type="button"
                                onClick={() => setConfirmStart(false)}
                                className="flex-1 rounded-full border border-white/20 py-2 text-xs text-white/80"
                            >
                                再检查一下
                            </button>
                            <button
                                type="button"
                                onClick={() => void finish()}
                                className="flex-[1.4] rounded-full bg-blue-600 py-2 text-xs font-semibold text-white"
                            >
                                开始解析
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
