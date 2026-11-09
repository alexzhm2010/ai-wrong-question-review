"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Maximize2, Minimize2, RotateCcw, RefreshCw, AlertTriangle } from "lucide-react";
import { parseCommands, runCommands, buildErrorFeedback } from "@/lib/geogebra-commands";

interface GeogebraDemoProps {
    commands: string;
    height?: number;
    showToolBar?: boolean;
    showAlgebraInput?: boolean;
    showMenuBar?: boolean;
    className?: string;
    onRegenerate?: (errors?: string) => Promise<void>;
    onSaveCommands?: (commands: string) => Promise<void>;
}

// ── Singleton script loader ─────────────────────────────────────────────
let ggbScriptPromise: Promise<void> | null = null;

function loadGeoGebraScript(): Promise<void> {
    if (ggbScriptPromise) return ggbScriptPromise;
    ggbScriptPromise = new Promise<void>((resolve, reject) => {
        if (typeof window !== "undefined" && (window as any).GGBApplet) {
            resolve();
            return;
        }
        const s = document.createElement("script");
        s.src = "https://www.geogebra.org/apps/deployggb.js";
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
            ggbScriptPromise = null;
            reject(new Error("Failed to load GeoGebra"));
        };
        document.head.appendChild(s);
    });
    return ggbScriptPromise;
}

// ── Component ───────────────────────────────────────────────────────────
export function GeogebraDemo({
    commands,
    height = 700,
    showToolBar = false,
    showAlgebraInput = false,
    showMenuBar = false,
    className = "",
    onRegenerate,
}: GeogebraDemoProps) {
    // This ref points to a div that React NEVER puts children into.
    // All GeoGebra DOM is injected via innerHTML in the effect, so
    // React's reconciler never touches the inside of this node.
    const ggbHostRef = useRef<HTMLDivElement>(null);
    const apiRef = useRef<any>(null);
    const idRef = useRef(`ggb-${Math.random().toString(36).slice(2, 9)}`);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(true);
    const [regenerating, setRegenerating] = useState(false);
    const [failedCommands, setFailedCommands] = useState<string[]>([]);

    const cmds = useMemo(() => parseCommands(commands), [commands]);

    // ── Init effect: load script → inject applet → run commands ─────────
    useEffect(() => {
        if (typeof window === "undefined" || cmds.length === 0) return;

        let dead = false;
        const id = idRef.current;

        loadGeoGebraScript().then(() => {
            if (dead) return;
            const GGBApplet = (window as any).GGBApplet;
            if (!GGBApplet) { setError("GeoGebra 未正确加载"); setLoading(false); return; }

            const el = ggbHostRef.current;
            if (!el) return;

            // Write the inject target directly — React never reconciles this.
            el.innerHTML = `<div id="${id}" style="width:100%;height:${height}px"></div>`;

            try {
                const applet = new GGBApplet({
                    appName: "classic",
                    width: "100%",
                    height,
                    showToolBar,
                    showAlgebraInput,
                    showMenuBar,
                    showResetIcon: true,
                    enableRightClick: true,
                    enableShiftDragZoom: true,
                    language: "zh",
                    appletOnLoad: (api: any) => {
                        if (dead) return;
                        apiRef.current = api;
                        const ggbDiv = ggbHostRef.current?.firstElementChild as HTMLElement | null;
                        if (ggbDiv) {
                            ggbDiv.style.width = '100%';
                            const w = ggbHostRef.current?.offsetWidth || ggbDiv.offsetWidth || 800;
                            api.setSize(w, height);
                        }
                        // 先关闭 GeoGebra 原生错误弹窗，再逐条检查执行结果
                        const result = runCommands(api, cmds);
                        setFailedCommands(result.failed);
                        setLoading(false);
                    },
                }, true);
                // deployggb.js auto-resolves the codebase — do NOT call setHTML5Codebase
                applet.inject(id);
            } catch (e) {
                console.error("[GGB] Init failed:", e);
                if (!dead) { setError("GeoGebra 初始化失败"); setLoading(false); }
            }
        }).catch((e) => {
            console.error("[GGB] Script load failed:", e);
            if (!dead) { setError("无法加载 GeoGebra 组件"); setLoading(false); }
        });

        return () => {
            dead = true;
            // Cleanup GeoGebra instance to prevent memory leaks
            try {
                const api = apiRef.current;
                if (api && typeof api.remove === 'function') {
                    api.remove();
                }
            } catch (e) {
                console.warn('[GGB] Cleanup failed:', e);
            }
            apiRef.current = null;
            // Clear injected DOM
            if (ggbHostRef.current) {
                ggbHostRef.current.innerHTML = '';
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cmds, showToolBar, showAlgebraInput, showMenuBar]);

    // ── Resize when expanded toggles ────────────────────────────────────
    useEffect(() => {
        const ggbDiv = ggbHostRef.current?.firstElementChild as HTMLElement | null;
        if (!ggbDiv) return;
        const h = expanded ? 700 : height;
        ggbDiv.style.width = '100%';
        ggbDiv.style.height = `${h}px`;
        const api = apiRef.current;
        if (api?.setSize) {
            const w = ggbHostRef.current?.offsetWidth || ggbDiv.offsetWidth || 800;
            api.setSize(w, h);
        }
    }, [expanded, height]);

    // ── Reset ───────────────────────────────────────────────────────────
    const handleReset = useCallback(() => {
        const api = apiRef.current;
        if (!api) return;
        try {
            api.resetConstruction();
            setTimeout(() => {
                if (apiRef.current) {
                    const result = runCommands(apiRef.current, cmds);
                    setFailedCommands(result.failed);
                }
            }, 300);
        } catch (e) { console.warn("[GGB] Reset failed", e); }
    }, [cmds]);

    // ── Regenerate (把执行失败的命令回传给 AI 做定向修正) ─────────────────
    const handleRegenerate = useCallback(async () => {
        if (!onRegenerate || regenerating) return;
        setRegenerating(true);
        try {
            const feedback = buildErrorFeedback(failedCommands);
            await onRegenerate(feedback || undefined);
        } finally {
            setRegenerating(false);
        }
    }, [onRegenerate, regenerating, failedCommands]);

    if (cmds.length === 0) return null;

    return (
        <div className={`relative rounded-lg border bg-card ${className}`}>
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                        GeoGebra 动态演示
                    </span>
                    {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                <div className="flex items-center gap-1">
                    {onRegenerate && (
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1"
                            onClick={handleRegenerate} title="重新生成" disabled={regenerating || loading}>
                            {regenerating
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <RefreshCw className="h-3.5 w-3.5" />}
                            <span>重新生成</span>
                        </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                        onClick={handleReset} title="重置" disabled={loading}>
                        <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                        onClick={() => setExpanded((v) => !v)}
                        title={expanded ? "缩小" : "放大"}>
                        {expanded
                            ? <Minimize2 className="h-3.5 w-3.5" />
                            : <Maximize2 className="h-3.5 w-3.5" />}
                    </Button>
                </div>
            </div>

            {/*
             * GeoGebra container — NO React children inside.
             * The effect writes innerHTML directly, so React never
             * tries to reconcile DOM nodes inside this div.
             */}
            <div ref={ggbHostRef} style={{ width: '100%' }} />

            {/* 失败命令提示 —— 取代 GeoGebra 自带的原生错误弹窗 */}
            {!loading && failedCommands.length > 0 && (
                <div className="border-t px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 flex-1">
                            {failedCommands.length} 条绘图命令未能执行，图形可能不完整
                        </span>
                        {onRegenerate && (
                            <Button variant="outline" size="sm" className="h-6 shrink-0 px-2 text-xs"
                                onClick={handleRegenerate} disabled={regenerating}>
                                {regenerating
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : "让 AI 修正"}
                            </Button>
                        )}
                    </div>
                    <details className="mt-1 text-muted-foreground">
                        <summary className="cursor-pointer">查看失败命令</summary>
                        <ul className="mt-1 space-y-0.5 break-all font-mono text-[11px]">
                            {failedCommands.slice(0, 12).map((c, i) => <li key={i}>{c}</li>)}
                        </ul>
                    </details>
                </div>
            )}

            {/* Loading overlay — sibling, not child of ggbHost */}
            {loading && (
                <div
                    className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 rounded-b-lg"
                    style={{ top: 37 }}
                >
                    <div className="flex flex-col items-center gap-2">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        <span className="text-sm text-muted-foreground">加载 GeoGebra...</span>
                    </div>
                </div>
            )}

            {/* Error */}
            {error && (
                <div
                    className="flex items-center justify-center text-sm text-destructive"
                    style={{ minHeight: height }}
                >
                    {error}
                </div>
            )}
        </div>
    );
}
