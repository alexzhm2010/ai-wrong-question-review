"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { useThinkingMode } from "@/components/thinking-mode-toggle";
import { processImageFile, makeThumbnail } from "@/lib/image-utils";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/toast";
import { refreshActiveBatch } from "@/lib/batch-store";
import { Images, Loader2 } from "lucide-react";

interface Props {
    /** 选好的多张图；为空时不渲染 */
    files: File[];
    onCancel: () => void;
}

/**
 * 多选图片后的「轻确认」条。
 *
 * 不占整屏、不重开面板：只是一条贴在底部的确认条，避免手滑多选直接开始烧钱，
 * 同时保留「一秒就能反悔」的路径。确认后按上方「思考深度」设置执行。
 */
export function BatchQuickConfirm({ files, onCancel }: Props) {
    const { t } = useLanguage();
    const b = t.batch;
    const router = useRouter();
    const [mode] = useThinkingMode();
    const [busy, setBusy] = useState(false);
    const [step, setStep] = useState(0);

    if (!files.length) return null;

    const count = files.length;
    const minutes = Math.max(1, Math.round((count * (mode === "deep" ? 80 : 20)) / 60));
    const cost = (count * (mode === "deep" ? 0.019 : 0.008)).toFixed(2);

    const start = async () => {
        if (busy) return;
        setBusy(true);
        setStep(0);
        try {
            const images: { image: string; thumb: string }[] = [];
            for (let i = 0; i < files.length; i++) {
                const full = await processImageFile(files[i]);
                const thumb = await makeThumbnail(full);
                images.push({
                    image: full.replace(/^data:[^;]+;base64,/, ""),
                    thumb,
                });
                setStep(i + 1);
            }
            const res = await apiClient.post<{ id: string }>("/api/batch/create", {
                reasoningMode: mode,
                images,
            }, { timeout: 180000 });
            refreshActiveBatch();
            toast.success(`${b.progress} ${count}`);
            router.push(`/batch?id=${res.id}`);
        } catch (e: any) {
            toast.error(e?.message || t.common.error);
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur">
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                        {busy
                            ? b.preparing.replace("{done}", String(step)).replace("{total}", String(count))
                            : b.quickConfirm.replace("{count}", String(count))}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                        {mode === "fast" ? b.fast : b.deep} · {b.eta.replace("{min}", String(minutes)).replace("{cost}", cost)}
                    </p>
                </div>
                <Button variant="ghost" size="sm" className="shrink-0" disabled={busy} onClick={onCancel}>
                    {t.common.cancel}
                </Button>
                <Button size="sm" className="shrink-0" disabled={busy} onClick={start}>
                    {b.start}
                </Button>
            </div>
        </div>
    );
}
