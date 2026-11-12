"use client";

import { useEffect, useRef } from "react";
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
 *
 * 耗时计时放在这个组件内部，用 ref 直接写 DOM：旧版由首页每 100ms
 * setState 一次，导致 37KB 的首页组件树每秒重渲染 10 次。现在父组件
 * 完全不参与计时，只在阶段文字变化时重渲染一次。
 */
export function TopProgressBar({
    status,
    progress = 0,
    message,
    onCancel,
    cancelLabel = "取消",
}: TopProgressBarProps) {
    const elapsedRef = useRef<HTMLSpanElement>(null);
    const startedAtRef = useRef<number | null>(null);

    useEffect(() => {
        if (status === "idle") {
            startedAtRef.current = null;
            return;
        }
        if (startedAtRef.current === null) startedAtRef.current = Date.now();
        const tick = () => {
            const el = elapsedRef.current;
            if (el && startedAtRef.current !== null) {
                el.textContent = `${((Date.now() - startedAtRef.current) / 1000).toFixed(1)}s`;
            }
        };
        tick();
        const id = window.setInterval(tick, 200);
        return () => window.clearInterval(id);
    }, [status]);

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
                    <span ref={elapsedRef} className="shrink-0 tabular-nums text-muted-foreground">0.0s</span>
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
