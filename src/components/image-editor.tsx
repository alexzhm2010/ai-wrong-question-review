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
import { useCallback, useEffect, useRef, useState } from "react";
import {
    Eraser, Loader2, Maximize2, Move, RotateCcw, Scissors, Undo2, X, Check, ChevronLeft,
} from "lucide-react";
import {
    type EditOp,
    type EraseSize,
    type Handle,
    type Pt,
    type Rect,
    CROP_HANDLES,
    type CropHandle,
    FULL_CROP,
    clamp01,
    clampRect,
    eraseWidthRatio,
    hitCropHandle,
    hitHandle,
    hitRect,
    isFullCrop,
    isRectUsable,
    moveRect,
    normalizeRect,
    popOp,
    pushOp,
    resizeCropRect,
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
    /** 队列模式：回到上一张（不保存当前改动） */
    onPrev?: () => void;
    /** 队列模式：覆盖「完成」文案，例如「保存并下一张」 */
    doneLabel?: string;
    /** 队列模式：覆盖「不处理」文案 */
    skipLabel?: string;
    /** 打开时停在哪个工具；批量队列直接进抹除，少点一次 */
    initialMode?: Mode;
    /** 导出图最长边（默认 2400）；批量草稿传 1600，避免编辑保存绕过压缩 */
    exportMaxWidth?: number;
    /** 导出 JPEG 质量（默认 0.88）；批量草稿传 0.82 */
    exportQuality?: number;
    /** changed=false 表示用户什么都没改，调用方可以跳过上传 */
    onCancel: () => void;
    onDone: (dataUrl: string, changed: boolean) => void | Promise<void>;
}

const ERASE_LABELS = ["细", "中", "粗"];

export function ImageEditor({
    open, imageSrc, title, subtitle, busy, progressLabel, onSkip, onPrev,
    doneLabel, skipLabel, initialMode = "crop", onCancel, onDone,
    exportMaxWidth = 2400, exportQuality = 0.88,
}: Props) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [base, setBase] = useState<HTMLCanvasElement | null>(null);
    const [original, setOriginal] = useState<HTMLCanvasElement | null>(null);
    const [ops, setOps] = useState<EditOp[]>([]);
    const [mode, setMode] = useState<Mode>(initialMode);
    const [eraseSize, setEraseSize] = useState<EraseSize>(1);
    /**
     * 裁剪框用归一化 Rect，和抹除 / 搬移 / 导出完全同一套坐标。
     * 旧版用 react-image-crop 的百分比，靠「CSS 容器尺寸 == 图片渲染尺寸」
     * 这个隐式前提才对得上；手机上字体缩放、地址栏收起、触屏手势一打断，
     * 框看着在这、保存却裁到别处。现在屏幕上这个框就是保存用的那个框。
     */
    const [cropSel, setCropSel] = useState<Rect>(FULL_CROP);
    /** 搬移选区（归一化）；松开后保留，方便连续微调 */
    const [sel, setSel] = useState<Rect | null>(null);
    const [saving, setSaving] = useState(false);
    /** 已应用的裁剪次数：顶栏要给出可见反馈，否则用户以为「一点裁剪就重置了」 */
    const [cropCount, setCropCount] = useState(0);
    /** 队列模式：有未保存改动却点了「不处理」，先拦一下 */
    const [confirmSkip, setConfirmSkip] = useState(false);
    /** 裁剪前的完整快照，供「撤销裁剪」还原（ops 已被烘焙，只存 base 不够） */
    const cropStackRef = useRef<{ base: HTMLCanvasElement; ops: EditOp[]; cropSel: Rect }[]>([]);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef(0);
    /** 一次拖拽的临时状态；用 ref 避免 pointermove 里读到旧 state */
    const dragRef = useRef<
        | { kind: "draw"; start: Pt }
        | { kind: "move"; start: Pt; rect: Rect }
        | { kind: "handle"; handle: Handle; rect: Rect }
        | { kind: "erase"; points: Pt[]; color: string }
        | { kind: "crop-new"; start: Pt }
        | { kind: "crop-move"; start: Pt; rect: Rect }
        | { kind: "crop-resize"; handle: CropHandle; rect: Rect }
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
        setCropSel(FULL_CROP);
        setCropCount(0);
        setConfirmSkip(false);
        cropStackRef.current = [];

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
        if (!base || saving || busy) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.setPointerCapture(e.pointerId);
        const p = toNorm(e);

        if (mode === "crop") {
            // 四边/四角随时可抓（初始全图时把位就在画布边缘），框内平移、框外重画。
            // 手势落在 canvas 上（它带 touch-none），不会被浏览器当滚动打断。
            const handle = hitCropHandle(cropSel, p);
            if (handle) {
                dragRef.current = { kind: "crop-resize", handle, rect: cropSel };
            } else if (!isFullCrop(cropSel) && hitRect(cropSel, p)) {
                dragRef.current = { kind: "crop-move", start: p, rect: cropSel };
            } else {
                // 全图时点中间 = 重新框选；不立刻改框，只点一下不该留下一个小方框
                dragRef.current = { kind: "crop-new", start: p };
            }
            return;
        }

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

        if (drag.kind === "crop-new") {
            const r = normalizeRect(drag.start, p);
            setCropSel(isRectUsable(r) ? clampRect(r) : FULL_CROP);
            return;
        }
        if (drag.kind === "crop-move") {
            setCropSel(moveRect(drag.rect, p.x - drag.start.x, p.y - drag.start.y));
            return;
        }
        if (drag.kind === "crop-resize") {
            setCropSel(resizeCropRect(drag.rect, drag.handle, p));
            return;
        }

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

        if (drag.kind === "crop-new" || drag.kind === "crop-move" || drag.kind === "crop-resize") return;

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
    /** 当前裁剪框；全选时返回 null，表示没裁。屏幕上那个框直接就是这个值 */
    const cropRect = (): Rect | null => {
        return isFullCrop(cropSel) ? null : clampRect(cropSel);
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
        // 先留快照：撤销裁剪要连 ops 一起还原，光存旧 base 会把之前的抹除丢掉
        cropStackRef.current.push({ base, ops, cropSel: FULL_CROP });
        setBase(next);
        setOps([]); // 已经烘焙进新基准，旧指令坐标失效
        setSel(null);
        setCropSel(FULL_CROP);
        setCropCount((n) => n + 1);
        // 刻意不 setMode("erase")：以前一刀切跳回抹除，用户看到工具变了、
        // 框没了，就以为「点裁剪把图片重置了」。现在留在裁剪模式，
        // 画布立刻显示裁完的结果，顶栏同步出现「已裁剪 1 次」。
    };

    /** 撤销最近一次「按框裁剪」，连同裁剪前的抹除/搬移一起还原 */
    const undoCrop = () => {
        const snapshot = cropStackRef.current.pop();
        if (!snapshot) return;
        setBase(snapshot.base);
        setOps(snapshot.ops);
        setSel(null);
        setCropSel(snapshot.cropSel);
        setCropCount((n) => Math.max(0, n - 1));
        livePreviewRef.current = null;
    };

    const resetAll = () => {
        if (original) setBase(original);
        setOps([]);
        setSel(null);
        setCropSel(FULL_CROP);
        setCropCount(0);
        cropStackRef.current = [];
        livePreviewRef.current = null;
    };

    /**
     * 切换工具。离开裁剪模式时若有框，先把它固化成新的基准图再切。
     *
     * 旧版直接 setMode，而 finish() 只在 mode==="crop" 时才应用裁剪框，
     * 于是「拉好框 → 切去抹除 → 完成」会导出整张未裁的图 —— 用户看到的就是
     * 「明明框好了，保存后却是另一块区域」。
     */
    const switchTool = (next: Mode) => {
        if (mode === "crop" && next !== "crop" && cropRect()) applyCrop();
        setMode(next);
        if (next === "erase") setSel(null);
        if (next === "move") paperRef.current = base ? samplePaperColor(base, 0.5, 0.5, 0.03) : "#ffffff";
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
            // 「按框裁剪」会把 base 换成裁剪后的新画布（original 仍是最初那张）。
            // 只看本次 pending 会误判成「没改动」，被详情页的 changed=false 跳过保存，
            // 结果裁完白干。基准图本身变过就算改过。
            const changed = pending.length > 0 || target !== base || (!!original && base !== original);
            const url = exportEdited(target, pending, exportMaxWidth, exportQuality);
            await onDone(url, changed);
        } finally {
            setSaving(false);
        }
    };

    /* -------------------------------- 渲染 -------------------------------- */
    const summary = summarize(ops);
    const dirty = ops.length > 0 || cropCount > 0 || (!!base && !!original && base !== original);
    const statusBits: string[] = [];
    if (cropCount) statusBits.push(`已裁剪 ${cropCount} 次`);
    if (summary.erase) statusBits.push(`已抹 ${summary.erase} 笔`);
    if (summary.move) statusBits.push(`已搬 ${summary.move} 块`);
    const statusText = statusBits.join(" · ");
    const hintText = progressLabel
        ? (statusText
            ? `${statusText} · 改完点右上「${doneLabel || "完成"}」`
            : (subtitle || "有问题就改，没问题点「不处理」"))
        : (statusText || subtitle || "裁边、抹掉批改痕迹、把图形搬到空白处");

    const handleSkip = () => {
        // 已经改过却点「不处理」会把改动丢掉，先问一句
        if (dirty) {
            setConfirmSkip(true);
            return;
        }
        onSkip?.();
    };

    if (!open) return null;

    return (
        <>
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
                {onPrev && (
                    <button
                        type="button"
                        onClick={onPrev}
                        className="flex h-9 w-8 shrink-0 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white"
                        aria-label="上一张"
                        title="上一张"
                    >
                        <ChevronLeft className="h-5 w-5" />
                    </button>
                )}
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                        {progressLabel && (
                            <span className="mr-1.5 rounded bg-white/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
                                {progressLabel}
                            </span>
                        )}
                        {title || "编辑图片"}
                    </p>
                    <p className="truncate text-[11px] text-white/50">{hintText}</p>
                </div>
                {onSkip && (
                    <button
                        type="button"
                        onClick={handleSkip}
                        className="mr-1 shrink-0 rounded-full border border-white/20 px-3 py-1.5 text-xs text-white/80"
                    >
                        {skipLabel || "不处理"}
                    </button>
                )}
                <button
                    type="button"
                    onClick={finish}
                    disabled={!base || saving || busy || loading}
                    className="flex h-9 items-center gap-1 rounded-full bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                    {(saving || busy) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    {doneLabel || "完成"}
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

                {/* 三个工具共用同一张 canvas：显示尺寸、坐标换算、导出落点完全一致 */}
                <div className="flex h-full w-full items-center justify-center">
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
                        {mode === "move" && sel && <MoveOverlay sel={sel} />}
                        {/* 裁剪框：纯展示，手势全在下层 canvas，避免 DOM 层抢走 touch 事件 */}
                        {mode === "crop" && !loading && !error && base && <CropOverlay rect={cropSel} />}
                    </div>
                </div>
            </div>

            {/* 工具条 */}
            <div className="shrink-0 border-t border-white/10 bg-slate-900/95 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
                {/* 队列模式：把「怎么切到下一题」写死在屏幕上，不用靠猜 */}
                {progressLabel && (
                    <div className="flex items-center justify-center gap-1.5 border-b border-white/5 px-3 py-1.5 text-center text-[11px] leading-snug text-white/55">
                        <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 font-semibold tabular-nums text-white/80">
                            第 {progressLabel} 张
                        </span>
                        <span className="min-w-0">
                            改完点右上「{doneLabel || "完成"}」；这张没问题点「{skipLabel || "不处理"}」
                        </span>
                    </div>
                )}
                {/* 当前工具的参数 */}
                <div className="flex h-10 items-center justify-center gap-3 px-3 text-[11px] text-white/60">
                    {mode === "crop" && (
                        <>
                            <span className="min-w-0 truncate">拖四边或四角调整取景，框内可整体拖动；框外按下重新框选</span>
                            {cropCount > 0 && (
                                <button
                                    type="button"
                                    onClick={undoCrop}
                                    className="shrink-0 rounded-full border border-white/25 px-2 py-1 text-white/80"
                                >
                                    撤销裁剪
                                </button>
                            )}
                        </>
                    )}
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
                        onClick={() => switchTool("crop")}
                    />
                    <ToolButton
                        active={mode === "erase"}
                        icon={<Eraser className="h-5 w-5" />}
                        label="抹除"
                        onClick={() => switchTool("erase")}
                    />
                    <ToolButton
                        active={mode === "move"}
                        icon={<Move className="h-5 w-5" />}
                        label="搬移"
                        onClick={() => switchTool("move")}
                    />

                    {mode === "crop" ? (
                        <>
                            <button
                                type="button"
                                onClick={() => setCropSel(FULL_CROP)}
                                disabled={isFullCrop(cropSel)}
                                className="flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[10px] text-white/70 disabled:opacity-30"
                            >
                                <RotateCcw className="h-5 w-5" />
                                全图
                            </button>
                            <button
                                type="button"
                                onClick={applyCrop}
                                disabled={!base || isFullCrop(cropSel)}
                                className="flex flex-[2] flex-col items-center justify-center gap-0.5 rounded-lg bg-blue-600 py-1.5 text-[10px] font-semibold text-white disabled:opacity-40"
                            >
                                <Maximize2 className="h-5 w-5" />
                                按框裁剪
                            </button>
                        </>
                    ) : (
                        <>
                            <ToolButton
                                icon={<Undo2 className="h-5 w-5" />}
                                label={!ops.length && cropCount ? "撤销裁剪" : "撤销"}
                                disabled={!ops.length && !cropCount}
                                onClick={() => {
                                    // 裁剪之后才可能有新的涂抹，所以先撤指令、再撤裁剪
                                    if (!ops.length && cropStackRef.current.length) {
                                        undoCrop();
                                        return;
                                    }
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

        {/* 队列模式：有未保存改动却点了「不处理」，别让它悄悄丢掉 */}
        {confirmSkip && (
            <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-8">
                <div className="w-full max-w-xs rounded-2xl bg-slate-900 p-5 text-white shadow-xl">
                    <p className="text-sm font-semibold">这张有未保存的修改</p>
                    <p className="mt-2 text-xs leading-relaxed text-white/60">
                        点「{skipLabel || "不处理"}」会直接看下一张，刚才裁的、抹的都不会保存。
                        想保留请返回后点右上「{doneLabel || "完成"}」。
                    </p>
                    <div className="mt-4 flex gap-2">
                        <button
                            type="button"
                            onClick={() => setConfirmSkip(false)}
                            className="flex-1 rounded-full border border-white/20 py-2 text-xs text-white/80"
                        >
                            继续编辑
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setConfirmSkip(false);
                                onSkip?.();
                            }}
                            className="flex-1 rounded-full bg-white/15 py-2 text-xs font-semibold text-white"
                        >
                            丢弃并下一张
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
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

/** 裁剪框 + 8 个把位（纯展示，事件交给下层 canvas） */
function CropOverlay({ rect }: { rect: Rect }) {
    const pos: Record<CropHandle, React.CSSProperties> = {
        nw: { left: 0, top: 0, transform: "translate(-50%,-50%)" },
        n: { left: "50%", top: 0, transform: "translate(-50%,-50%)" },
        ne: { left: "100%", top: 0, transform: "translate(-50%,-50%)" },
        e: { left: "100%", top: "50%", transform: "translate(-50%,-50%)" },
        se: { left: "100%", top: "100%", transform: "translate(-50%,-50%)" },
        s: { left: "50%", top: "100%", transform: "translate(-50%,-50%)" },
        sw: { left: 0, top: "100%", transform: "translate(-50%,-50%)" },
        w: { left: 0, top: "50%", transform: "translate(-50%,-50%)" },
    };
    return (
        <div
            className="pointer-events-none absolute border-2 border-blue-400"
            style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.w * 100}%`,
                height: `${rect.h * 100}%`,
                // 框外压暗，一眼看清取景范围；溢出部分由外层 overflow-hidden 裁掉
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
            }}
        >
            {CROP_HANDLES.map((h) => (
                <span
                    key={h}
                    className="absolute h-3.5 w-3.5 rounded-sm border-2 border-white bg-blue-500"
                    style={pos[h]}
                />
            ))}
        </div>
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
