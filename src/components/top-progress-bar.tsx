"use client";

import { Loader2, X } from "lucide-react";
import type { ProgressStatus } from "@/components/ui/progress-feedback";

interface TopProgressBarProps {
    status: ProgressStatus;
    /** 0-100 */
    progress?: number;
    message?: string;
    onCancel?: () => void;
    cancelLabel?: string;
}

/**
 * 顶部悬浮进度条：不遮挡页面、不阻塞交互。
 * 一条细进度线贴屏幕顶部，右侧跟随一个小胶囊显示当前阶段与耗时。
 */
export function TopProgressBar({
    status,
    progress = 0,
    message,
    onCancel,
    cancelLabel = "取消",
}: TopProgressBarProps) {
    if (status === "idle") return null;

    const pct = Math.max(0, Math.min(100, progress));

    return (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[70]">
            {/* 进度线 */}
            <div className="h-1 w-full bg-primary/15">
                <div
                    className="h-full bg-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${pct}%` }}
                />
            </div>

            {/* 阶段胶囊 */}
            <div className="absolute right-2 top-2 max-w-[calc(100vw-1rem)]">
                <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border bg-card/95 px-2.5 py-1 text-xs shadow-md backdrop-blur">
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                    <span className="truncate max-w-[52vw]">{message}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
                    {onCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="ml-0.5 shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label={cancelLabel}
                            title={cancelLabel}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
