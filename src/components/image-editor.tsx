"use client";

/**
 * 统一的题目图片编辑器：裁剪 / 抹除 / 框选搬移。
 *
 * 两个入口共用（新增题目、明细页换图），组件本身**不碰保存逻辑**：
 * 只吐出编辑后的 dataURL，怎么存由调用方决定。这样以后加第三个入口
 * 不用再复制一遍保存代码。
 *
 * 性能上的两条硬约束：
 *   1. 显示画布按容器尺寸渲染（约 900px 宽），导出时才按原分辨率重放，
 *      拖动过程不碰 2400px 的全尺寸位图；
 *   2. 历史只存指令，不存 ImageData。一屏 30MB 的位图存 20 步会直接把
 *      手机内存打爆。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactCrop, { type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
    Eraser, Loader2, Maximize2, Move, RotateCcw, Scissors, Undo2, X, Check,
} from "lucide-react";
import {
    type EditOp,
    type EraseSize,
    type Handle,
    type Pt,
    type Rect,
    clamp01,
    clampRect,
    eraseWidthRatio,
    hitHandle,
    hitRect,
    isRectUsable,
    moveRect,
    normalizeRect,
    popOp,
    pushOp,
    resizeFromHandle,
    summarize,
} from "@/lib/image-editor";
import {
    createCanvas,
    cropCanvas,
    drawMovePreview,
    exportEdited,
    loadImage,
    renderTo,
    samplePaperColor,
    toBaseCanvas,
} from "@/lib/image-editor-render";

type Mode = "crop" | "erase" | "move";

interface Props {
    open: boolean;
    /** 输入图（data URL） */
    imageSrc: string;
    title?: string;
    subtitle?: string;
    /** 外部保存中，禁用「完成」 */
    busy?: boolean;
    /** 队列模式：右上角显示「3/30」 */
    progressLabel?: string;
    /** 队列模式：本轮不保存直接看下一张 */
    onSkip?: () => void;
    /** 打开时停在哪个工具；批量队列直接进抹除，少点一次 */
    initialMode?: Mode;
    /** changed=false 表示用户什么都没改，调用方可以跳过上传 */
    onCancel: () => void;
    onDone: (dataUrl: string, changed: boolean) => void | Promise<void>;
}

const ERASE_LABELS = ["细", "中", "粗"];

export function ImageEditor({
    open, imageSrc, title, subtitle, busy, progressLabel, onSkip, initialMode = "crop", onCancel, onDone,
}: Props) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [base, setBase] = useState<HTMLCanvasElement | null>(null);
    const [original, setOriginal] = useState<HTMLCanvasElement | null>(null);
    const [ops, setOps] = useState<EditOp[]>([]);
    const [mode, setMode] = useState<Mode>(initialMode);
    const [eraseSize, setEraseSize] = useState<EraseSize>(1);
    const [crop, setCrop] = useState<Crop>({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
    /** 搬移选区（归一化）；松开后保留，方便连续微调 */
    const [sel, setSel] = useState<Rect | null>(null);
    const [saving, setSaving] = useState(false);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef(0);
    /** 一次拖拽的临时状态；用 ref 避免 pointermove 里读到旧 state */
    const dragRef = useRef<
        | { kind: "draw"; start: Pt }
        | { kind: "move"; start: Pt; rect: Rect }
        | { kind: "handle"; handle: Handle; rect: Rect }
        | { kind: "erase"; points: Pt[]; color: string }
        | null
    >(null);
    const livePreviewRef = useRef<{ src: Rect; dst: Rect; color: string } | null>(null);
    const paperRef = useRef("#ffffff");

    /* ----------------------------- 初始化 / 释放 ----------------------------- */
    useEffect(() => {
        if (!open || !imageSrc) return;
        let cancelled = false;
        setLoading(true);
        setError("");
        setOps([]);
        setSel(null);
        setMode(initialMode);
        setCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });

        loadImage(imageSrc)
            .then((img) => {
                if (cancelled) return;
                const c = toBaseCanvas(img, 2400);
                setBase(c);
                // 保留一份最初的画布，「重置」直接回到它
                setOriginal(c);
                paperRef.current = samplePaperColor(c, 0.5, 0.5, 0.03);
                setLoading(false);
            })
            .catch(() => {
                if (cancelled) return;
                setError("图片加载失败，请重试");
                setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [open, imageSrc, initialMode]);

    /* ------------------------------ 画布尺寸 ------------------------------ */
    const paint = useCallback(() => {
        const canvas = canvasRef.current;
        const box = boxRef.current;
        if (!canvas || !box || !base) return;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const cw = box.clientWidth;
        const ch = box.clientHeight;
        if (!cw || !ch) return;
        const scale = Math.min(cw / base.width, ch / base.height);
        const dw = Math.max(1, Math.floor(base.width * scale));
        const dh = Math.max(1, Math.floor(base.height * scale));
        const pw = Math.floor(dw * dpr);
        const ph = Math.floor(dh * dpr);

        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
        }
        canvas.style.width = `${dw}px`;
        canvas.style.height = `${dh}px`;

        renderTo(base, ops, canvas);
        const live = livePreviewRef.current;
        if (live) drawMovePreview(canvas, live.src, live.dst, live.color);
    }, [base, ops]);

    const requestPaint = useCallback(() => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            paint();
        });
    }, [paint]);

    useEffect(() => {
        requestPaint();
        const box = boxRef.current;
        if (!box || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => requestPaint());
        ro.observe(box);
        return () => ro.disconnect();
    }, [requestPaint]);

    useEffect(() => () => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }, []);

    /** 归一化坐标：相对 canvas 的 CSS 盒子 */
    const toNorm = useCallback((e: React.PointerEvent): Pt => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const r = canvas.getBoundingClientRect();
        return {
            x: clamp01((e.clientX - r.left) / Math.max(1, r.width)),
            y: clamp01((e.clientY - r.top) / Math.max(1, r.height)),
        };
    }, []);

    /* -------------------------------- 手势 -------------------------------- */
    const onPointerDown = (e: React.PointerEvent) => {
        if (!base || mode === "crop" || saving || busy) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.setPointerCapture(e.pointerId);
        const p = toNorm(e);

        if (mode === "erase") {
            const color = samplePaperColor(base, p.x, p.y, 0.012);
            paperRef.current = color;
            dragRef.current = { kind: "erase", points: [p], color };
            drawEraseDot(canvas, p, eraseSize, color);
            return;
        }

        // move 模式
        if (sel) {
            const handle = hitHandle(sel, p);
            if (handle) {
                dragRef.current = { kind: "handle", handle, rect: sel };
                return;
            }
            if (hitRect(sel, p)) {
                dragRef.current = { kind: "move", start: p, rect: sel };
                return;
            }
        }
        dragRef.current = { kind: "draw", start: p };
        setSel(null);
        livePreviewRef.current = null;
        requestPaint();
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const p = toNorm(e);
        const canvas = canvasRef.current;
        if (!canvas) return;

        if (drag.kind === "erase") {
            const prev = drag.points[drag.points.length - 1];
            drag.points.push(p);
            drawEraseSegment(canvas, prev, p, eraseSize, drag.color);
            return;
        }

        if (drag.kind === "draw") {
            const r = normalizeRect(drag.start, p);
            setSel(isRectUsable(r) ? r : null);
            return;
        }

        if (drag.kind === "move") {
            const dx = p.x - drag.start.x;
            const dy = p.y - drag.start.y;
            const dst = moveRect(drag.rect, dx, dy);
            livePreviewRef.current = { src: drag.rect, dst, color: paperRef.current };
            setSel(dst);
            requestPaint();
            return;
        }

        if (drag.kind === "handle") {
            const dst = resizeFromHandle(drag.rect, drag.handle, p);
            livePreviewRef.current = { src: drag.rect, dst, color: paperRef.current };
            setSel(dst);
            requestPaint();
        }
    };

    const onPointerUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;

        if (drag.kind === "erase") {
            if (drag.points.length) {
                setOps((prev) => pushOp(prev, {
                    type: "erase",
                    size: eraseSize,
                    color: drag.color,
                    points: drag.points,
                }));
            }
            livePreviewRef.current = null;
            return;
        }

        if (drag.kind === "move" && sel) {
            const moved = Math.abs(sel.x - drag.rect.x) + Math.abs(sel.y - drag.rect.y);
            livePreviewRef.current = null;
            if (moved > 0.004) {
                setOps((prev) => pushOp(prev, {
                    type: "move",
                    src: drag.rect,
                    dst: sel,
                    color: paperRef.current,
                }));
            }
            return;
        }

        if (drag.kind === "handle" && sel) {
            const changed = Math.abs(sel.w - drag.rect.w) + Math.abs(sel.h - drag.rect.h);
            livePreviewRef.current = null;
            if (changed > 0.004) {
                setOps((prev) => pushOp(prev, {
                    type: "move",
                    src: drag.rect,
                    dst: sel,
                    color: paperRef.current,
                }));
            }
        }
    };

    /* ------------------------------- 工具动作 ------------------------------- */
    /** 当前裁剪框（归一化）；全选时返回 null，表示没裁 */
    const cropRect = (): Rect | null => {
        const r: Rect = {
            x: crop.x / 100,
            y: crop.y / 100,
            w: crop.width / 100,
            h: crop.height / 100,
        };
        return r.w >= 0.999 && r.h >= 0.999 ? null : clampRect(r);
    };

    /**
     * 裁剪时先把已有涂抹/搬移烘焙进基准图，再裁。
     * 否则裁剪会重置坐标系、把前面的操作全清掉——用户先抹后裁就白干了。
     */
    const bakeThenCrop = (rect: Rect): HTMLCanvasElement | null => {
        if (!base) return null;
        if (!ops.length) return cropCanvas(base, rect);
        const merged = createCanvas(base.width, base.height);
        renderTo(base, ops, merged);
        return cropCanvas(merged, rect);
    };

    const applyCrop = () => {
        if (!base) return;
        const rect = cropRect();
        if (!rect) return; // 没裁，别浪费一次重编码
        const next = bakeThenCrop(rect);
        if (!next) return;
        setBase(next);
        setOps([]); // 已经烘焙进新基准，旧指令坐标失效
        setSel(null);
        setCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
        setMode("erase");
    };

    const resetAll = () => {
        if (original) setBase(original);
        setOps([]);
        setSel(null);
        setCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
        livePreviewRef.current = null;
    };

    const finish = async () => {
        if (!base || saving) return;
        setSaving(true);
        try {
            // 停在裁剪模式时直接点「完成」：把框一起应用，否则用户会以为裁过了
            let target = base;
            let pending = ops;
            if (mode === "crop") {
                const rect = cropRect();
                if (rect) {
                    const next = bakeThenCrop(rect);
                    if (next) {
                        target = next;
                        pending = [];
                    }
                }
            }
            const changed = pending.length > 0 || target !== base;
            const url = exportEdited(target, pending, 2400, 0.88);
            await onDone(url, changed);
        } finally {
            setSaving(false);
        }
    };

    /* -------------------------------- 渲染 -------------------------------- */
    const baseUrl = useMemo(() => {
        if (!base) return "";
        try {
            return base.toDataURL("image/jpeg", 0.9);
        } catch {
            return "";
        }
    }, [base]);

    const summary = summarize(ops);
    const dirty = ops.length > 0 || (base && original && base !== original);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[70] flex flex-col bg-slate-950 text-white">
            {/* 顶栏 */}
            <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                <button
                    type="button"
                    onClick={onCancel}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"
                    aria-label="取消"
                >
                    <X className="h-5 w-5" />
                </button>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                        {progressLabel && (
                            <span className="mr-1.5 rounded bg-white/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
                                {progressLabel}
                            </span>
                        )}
                        {title || "编辑图片"}
                    </p>
                    <p className="truncate text-[11px] text-white/50">
                        {summary.erase || summary.move
                            ? `已抹 ${summary.erase} 笔 · 已搬 ${summary.move} 块`
                            : (subtitle || "裁边、抹掉批改痕迹、把图形搬到空白处")}
                    </p>
                </div>
                {onSkip && (
                    <button
                        type="button"
                        onClick={onSkip}
                        className="mr-1 shrink-0 rounded-full border border-white/20 px-3 py-1.5 text-xs text-white/80"
                    >
                        不处理
                    </button>
                )}
                <button
                    type="button"
                    onClick={finish}
                    disabled={!base || saving || busy || loading}
                    className="flex h-9 items-center gap-1 rounded-full bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                    {(saving || busy) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    完成
                </button>
            </div>

            {/* 画布区 */}
            <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden px-2 pb-2">
                {loading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/60">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        正在加载图片…
                    </div>
                )}
                {error && (
                    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-red-300">
                        {error}
                    </div>
                )}

                {!loading && !error && base && mode === "crop" && (
                    <div className="flex h-full w-full items-center justify-center">
                        <ReactCrop
                            crop={crop}
                            onChange={(_, percent) => setCrop(percent)}
                            className="max-h-full max-w-full"
                            style={{ maxHeight: "100%", maxWidth: "100%" }}
                        >
                            <img
                                src={baseUrl}
                                alt="待裁剪"
                                style={{ maxWidth: "100%", maxHeight: "100%", display: "block" }}
                            />
                        </ReactCrop>
                    </div>
                )}

                <div
                    className={`flex h-full w-full items-center justify-center ${mode === "crop" ? "hidden" : ""}`}
                >
                    <div className="relative" style={{ lineHeight: 0 }}>
                        <canvas
                            ref={canvasRef}
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                            onPointerCancel={onPointerUp}
                            className="touch-none rounded-sm bg-white"
                        />
                        {/* 搬移选区：框线用手柄画在 DOM 层，比画进 canvas 清晰 */}
                        {mode === "move" && sel && (
                            <MoveOverlay sel={sel} />
                        )}
                    </div>
                </div>
            </div>

            {/* 工具条 */}
            <div className="shrink-0 border-t border-white/10 bg-slate-900/95 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                {/* 当前工具的参数 */}
                <div className="flex h-10 items-center justify-center gap-3 px-3 text-[11px] text-white/60">
                    {mode === "crop" && <span>拖动四角裁掉多余部分，确认后进入下一步</span>}
                    {mode === "erase" && (
                        <div className="flex items-center gap-2">
                            <span>笔宽</span>
                            {ERASE_LABELS.map((label, i) => (
                                <button
                                    key={label}
                                    type="button"
                                    onClick={() => setEraseSize(i as EraseSize)}
                                    className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 transition ${
                                        eraseSize === i ? "bg-white text-slate-900" : "bg-white/10 text-white/70"
                                    }`}
                                >
                                    <span
                                        className="rounded-full bg-current"
                                        style={{
                                            width: 4 + i * 4,
                                            height: 4 + i * 4,
                                        }}
                                    />
                                    {label}
                                </button>
                            ))}
                            <span className="ml-1 text-white/30">颜色取自纸面</span>
                        </div>
                    )}
                    {mode === "move" && (
                        <span>先框出一块，再拖它或拉四角缩放；松手即落地</span>
                    )}
                </div>

                <div className="flex items-stretch gap-1 px-2">
                    <ToolButton
                        active={mode === "crop"}
                        icon={<Scissors className="h-5 w-5" />}
                        label="裁剪"
                        onClick={() => setMode("crop")}
                    />
                    <ToolButton
                        active={mode === "erase"}
                        icon={<Eraser className="h-5 w-5" />}
                        label="抹除"
                        onClick={() => {
                            setMode("erase");
                            setSel(null);
                        }}
                    />
                    <ToolButton
                        active={mode === "move"}
                        icon={<Move className="h-5 w-5" />}
                        label="搬移"
                        onClick={() => {
                            setMode("move");
                            paperRef.current = base ? samplePaperColor(base, 0.5, 0.5, 0.03) : "#ffffff";
                        }}
                    />

                    {mode === "crop" ? (
                        <button
                            type="button"
                            onClick={applyCrop}
                            disabled={!base}
                            className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg bg-blue-600 py-1.5 text-[10px] font-semibold text-white disabled:opacity-40"
                        >
                            <Maximize2 className="h-5 w-5" />
                            按框裁剪
                        </button>
                    ) : (
                        <>
                            <ToolButton
                                icon={<Undo2 className="h-5 w-5" />}
                                label="撤销"
                                disabled={!ops.length}
                                onClick={() => {
                                    setOps((prev) => popOp(prev));
                                    setSel(null);
                                    livePreviewRef.current = null;
                                }}
                            />
                            <ToolButton
                                icon={<RotateCcw className="h-5 w-5" />}
                                label="重置"
                                disabled={!dirty}
                                onClick={resetAll}
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function ToolButton({
    icon, label, active, disabled, onClick,
}: {
    icon: React.ReactNode;
    label: string;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[10px] transition ${
                active ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/5"
            } disabled:opacity-30`}
        >
            {icon}
            {label}
        </button>
    );
}

/** 搬移选区框 + 四角手柄（纯展示，事件交给下层 canvas） */
function MoveOverlay({ sel }: { sel: Rect }) {
    return (
        <div
            className="pointer-events-none absolute border-2 border-blue-500"
            style={{
                left: `${sel.x * 100}%`,
                top: `${sel.y * 100}%`,
                width: `${sel.w * 100}%`,
                height: `${sel.h * 100}%`,
            }}
        >
            <span className="absolute left-1 top-1 whitespace-nowrap rounded bg-blue-600/90 px-1.5 py-0.5 text-[10px] font-medium text-white shadow">
                拖动此块
            </span>
            {(["nw", "ne", "sw", "se"] as Handle[]).map((h) => (
                <span
                    key={h}
                    className="absolute h-3 w-3 rounded-sm border border-white bg-blue-500"
                    style={{
                        left: h === "nw" || h === "sw" ? -7 : undefined,
                        right: h === "ne" || h === "se" ? -7 : undefined,
                        top: h === "nw" || h === "ne" ? -7 : undefined,
                        bottom: h === "sw" || h === "se" ? -7 : undefined,
                    }}
                />
            ))}
        </div>
    );
}

/* --------------------------- 增量绘制（跟手用） --------------------------- */

function drawEraseDot(canvas: HTMLCanvasElement, p: Pt, size: EraseSize, color: string) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = eraseWidthRatio(size) * canvas.width;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawEraseSegment(canvas: HTMLCanvasElement, a: Pt, b: Pt, size: EraseSize, color: string) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, eraseWidthRatio(size) * canvas.width);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
    ctx.stroke();
    ctx.restore();
}
