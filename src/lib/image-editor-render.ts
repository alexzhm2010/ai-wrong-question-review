/**
 * 编辑器渲染层：把操作指令真正画到 canvas 上。
 *
 * 显示画布和导出画布走的是同一套渲染函数，只是尺寸不同。
 * 因为所有坐标都是归一化的，同一条指令在 900px 预览和 2400px 导出上
 * 位置、比例完全一致，不会出现「预览看着对齐，导出来偏了」。
 */
import {
    type EditOp,
    type EraseOp,
    type MoveOp,
    type Rect,
    eraseWidthRatio,
    pickPaperColor,
    rectToPixels,
} from "./image-editor";

export function createCanvas(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        // data URL 同源不用管；但库里的引用将来换成对象存储就是 https 地址，
        // 不声明匿名跨域会把画布「污染」，编辑完 toDataURL 直接抛 SecurityError。
        // 所以「编辑已入库的图片」这条路要能一直用下去，这一行是前提。
        if (/^https?:\/\//i.test(src)) img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("图片加载失败"));
        img.src = src;
    });
}

/** 把任意图源画成一张「基准画布」，超过 maxWidth 的等比缩小，控制内存 */
export function toBaseCanvas(img: HTMLImageElement, maxWidth = 2400): HTMLCanvasElement {
    const scale = Math.min(1, maxWidth / Math.max(1, img.naturalWidth));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d");
    if (!ctx) return c;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);
    return c;
}

function applyErase(ctx: CanvasRenderingContext2D, op: EraseOp, W: number, H: number) {
    if (!op.points.length) return;
    ctx.save();
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = Math.max(1, eraseWidthRatio(op.size) * W);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (op.points.length === 1) {
        // 单点 = 点一下，画个圆点，否则 stroke 什么都不出
        const p = op.points[0];
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
    } else {
        ctx.beginPath();
        op.points.forEach((p, i) => {
            const x = p.x * W;
            const y = p.y * H;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }
    ctx.restore();
}

/**
 * 搬移：先把源区域拷进临时画布，再把源区填成纸面色，最后贴到目标位置。
 *
 * 顺序不能反：如果先填源区再取图，取到的就是一块纯色；
 * 也不能直接 drawImage(canvas 自己)，同画布自拷贝在部分浏览器上结果未定义。
 */
function applyMove(ctx: CanvasRenderingContext2D, op: MoveOp, W: number, H: number) {
    const s = rectToPixels(op.src, W, H);
    const d = rectToPixels(op.dst, W, H);
    const tmp = createCanvas(s.w, s.h);
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.drawImage(ctx.canvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
    ctx.save();
    ctx.fillStyle = op.color;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmp, 0, 0, s.w, s.h, d.x, d.y, d.w, d.h);
    ctx.restore();
}

export function paintOps(
    ctx: CanvasRenderingContext2D,
    ops: EditOp[],
    W: number,
    H: number,
): void {
    for (const op of ops) {
        if (op.type === "erase") applyErase(ctx, op, W, H);
        else applyMove(ctx, op, W, H);
    }
}

/** 基准图 + 指令 → 目标画布（目标尺寸任意，指令按比例缩放） */
export function renderTo(
    base: HTMLCanvasElement,
    ops: EditOp[],
    target: HTMLCanvasElement,
): void {
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(base, 0, 0, target.width, target.height);
    paintOps(ctx, ops, target.width, target.height);
}

/**
 * 拖动中的搬移预览：把源区域「抬起来」画到目标位置。
 * 只在显示画布上跑，尺寸小、无需 getImageData，跟手。
 */
export function drawMovePreview(
    canvas: HTMLCanvasElement,
    src: Rect,
    dst: Rect,
    color: string,
): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const s = rectToPixels(src, W, H);
    const d = rectToPixels(dst, W, H);
    const tmp = createCanvas(s.w, s.h);
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.drawImage(canvas, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.globalAlpha = 0.94;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmp, 0, 0, s.w, s.h, d.x, d.y, d.w, d.h);
    ctx.restore();
}

/** 裁掉选区以外的部分，返回新画布（用于「裁剪」确认） */
export function cropCanvas(base: HTMLCanvasElement, rect: Rect): HTMLCanvasElement {
    const r = rectToPixels(rect, base.width, base.height);
    const out = createCanvas(r.w, r.h);
    const ctx = out.getContext("2d");
    if (ctx) ctx.drawImage(base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return out;
}

/**
 * 采样某点周围的纸面色。
 *
 * radius 用相对图片宽度的比例（默认 1.2%），这样在 2400px 原图上
 * 采样半径约 29px，能避开单个笔画的干扰，又不会采到半张卷子的阴影。
 */
export function samplePaperColor(
    canvas: HTMLCanvasElement,
    nx: number,
    ny: number,
    radius = 0.012,
): string {
    const W = canvas.width;
    const H = canvas.height;
    const r = Math.max(2, Math.round(radius * W));
    const cx = Math.round(nx * W);
    const cy = Math.round(ny * H);
    const x = Math.max(0, Math.min(W - 1, cx - r));
    const y = Math.max(0, Math.min(H - 1, cy - r));
    const w = Math.max(1, Math.min(W - x, r * 2));
    const h = Math.max(1, Math.min(H - y, r * 2));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "#ffffff";
    try {
        const data = ctx.getImageData(x, y, w, h).data;
        return pickPaperColor(data);
    } catch {
        // 跨域污染（将来图片搬到对象存储且没配 CORS）时不能崩，退回白色
        return "#ffffff";
    }
}

/**
 * 导出最终图。只编码一次，避免多轮编辑反复重压缩掉细节。
 * 宽度不超过 maxWidth，且不放大（原图更小就保持原尺寸）。
 */
export function exportEdited(
    base: HTMLCanvasElement,
    ops: EditOp[],
    maxWidth = 2400,
    quality = 0.88,
): string {
    const targetW = Math.min(maxWidth, base.width);
    const ratio = targetW / base.width;
    const targetH = Math.max(1, Math.round(base.height * ratio));
    const out = createCanvas(targetW, targetH);
    const ctx = out.getContext("2d");
    if (ctx) {
        // JPEG 没有透明通道，先铺白：源图若是带透明区的 PNG，否则会导出黑块
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(base, 0, 0, targetW, targetH);
        paintOps(ctx, ops, targetW, targetH);
    }
    return out.toDataURL("image/jpeg", quality);
}

/** 判断当前是否还有可撤销的操作 */
export function hasEdits(ops: EditOp[]): boolean {
    return ops.length > 0;
}
