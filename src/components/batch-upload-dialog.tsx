"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { processImageFile, makeThumbnail } from "@/lib/image-utils";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/toast";
import { refreshActiveBatch } from "@/lib/batch-store";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_BATCH = 30;

interface BatchImage {
    key: string;
    image: string;
    thumb: string;
    kb: number;
}

interface BatchUploadDialogProps {
    open: boolean;
    onClose: () => void;
    initialFiles?: File[];
}

/**
 * 批量导入的上传面板。
 * 一批只选一次思考模式（逐张选在批量场景是纯负担），右侧同步给出时长与费用估算。
 */
export function BatchUploadDialog({ open, onClose, initialFiles }: BatchUploadDialogProps) {
    const { t } = useLanguage();
    const b = t.batch;
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);
    const [images, setImages] = useState<BatchImage[]>([]);
    const [mode, setMode] = useState<"fast" | "deep">("fast");
    const [compressing, setCompressing] = useState(0);
    const [starting, setStarting] = useState(false);

    const buildImages = async (files: File[]): Promise<BatchImage[]> => {
        setCompressing(files.length);
        const added: BatchImage[] = [];
        for (const file of files) {
            try {
                const image = await processImageFile(file);
                const thumb = await makeThumbnail(image);
                added.push({
                    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    image: image.replace(/^data:[^;]+;base64,/, ""),
                    thumb,
                    kb: Math.round((image.length * 3) / 4 / 1024),
                });
            } catch (e) {
                console.error("compress failed", e);
            } finally {
                setCompressing((n) => Math.max(0, n - 1));
            }
        }
        return added;
    };

    const addFiles = async (files: File[]) => {
        const room = MAX_BATCH - images.length;
        if (room <= 0) {
            toast.error(t.batch.uploadTip);
            return;
        }
        const added = await buildImages(files.slice(0, room));
        setImages((prev) => [...prev, ...added].slice(0, MAX_BATCH));
    };

    // 首页多选进来的文件，打开面板时直接开始处理（覆盖上一次的残留）
    useEffect(() => {
        if (!open) return;
        if (initialFiles?.length) {
            void buildImages(initialFiles.slice(0, MAX_BATCH)).then(setImages);
        } else {
            setImages([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const minutes = Math.max(1, Math.round((images.length * (mode === "deep" ? 80 : 20)) / 60));
    const cost = (images.length * (mode === "deep" ? 0.019 : 0.008)).toFixed(2);

    const start = async () => {
        if (!images.length || starting) return;
        setStarting(true);
        try {
            const res = await apiClient.post<{ id: string; queued: boolean }>("/api/batch/create", {
                reasoningMode: mode,
                images: images.map((i) => ({ image: i.image, thumb: i.thumb })),
            }, { timeout: 120000 });
            onClose();
            refreshActiveBatch();
            toast.success(`${b.progress} ${images.length}`);
            router.push(`/batch?id=${res.id}`);
        } catch (e: any) {
            toast.error(e?.message || t.common.error);
        } finally {
            setStarting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => !v && !starting && onClose()}>
            <DialogContent className="flex max-h-[90svh] w-[calc(100vw_-_1rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:w-full">
                <DialogHeader className="shrink-0 border-b p-4 pr-12">
                    <DialogTitle>{b.title}</DialogTitle>
                    <p className="text-xs text-muted-foreground">{b.subtitle}</p>
                </DialogHeader>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            e.target.value = "";
                            if (files.length) void addFiles(files);
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => inputRef.current?.click()}
                        className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/25 py-6 transition-colors hover:border-primary/50"
                    >
                        {compressing > 0 ? (
                            <>
                                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                                <span className="text-xs text-muted-foreground">
                                    {t.app.compressing} ({compressing})
                                </span>
                            </>
                        ) : (
                            <>
                                <ImagePlus className="h-6 w-6 text-muted-foreground" />
                                <span className="text-sm font-medium">{b.uploadHint}</span>
                                <span className="text-xs text-muted-foreground">{b.uploadTip}</span>
                            </>
                        )}
                    </button>

                    {images.length > 0 && (
                        <>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>{b.selected.replace("{count}", String(images.length))}</span>
                                <button className="underline" onClick={() => setImages([])}>
                                    {t.common.delete}
                                </button>
                            </div>
                            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                                {images.map((img) => (
                                    <div key={img.key} className="group relative aspect-square overflow-hidden rounded-md border">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={`data:image/jpeg;base64,${img.thumb}`}
                                            alt=""
                                            className="h-full w-full object-cover"
                                        />
                                        <button
                                            className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                                            onClick={() => setImages((prev) => prev.filter((i) => i.key !== img.key))}
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    <div className="rounded-lg border bg-card p-3">
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-sm font-medium">{b.mode}</span>
                            <div className="flex rounded-md border p-0.5">
                                {(["fast", "deep"] as const).map((m) => (
                                    <button
                                        key={m}
                                        onClick={() => setMode(m)}
                                        className={cn(
                                            "rounded px-3 py-1 text-xs font-medium transition-colors",
                                            mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                                        )}
                                    >
                                        {m === "fast" ? b.fast : b.deep}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {mode === "fast" ? b.fastHint : b.deepHint}
                        </p>
                        {images.length > 0 && (
                            <p className="mt-1 text-xs font-medium text-primary">
                                {b.eta.replace("{min}", String(minutes)).replace("{cost}", cost)}
                            </p>
                        )}
                    </div>
                </div>

                <div className="shrink-0 border-t bg-background p-3 sm:p-4">
                    <Button className="w-full" disabled={!images.length || starting || compressing > 0} onClick={start}>
                        {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {b.start}
                        {images.length > 0 ? ` · ${images.length}` : ""}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
