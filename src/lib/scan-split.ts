/**
 * 拍照批改的「整页 → 多段」切分（纯浏览器本地，图片不出本机）。
 *
 * 为什么不整页丢给模型：
 *   1. 整页 2000×2900 的图进视觉模型，token 多、注意力分散，一次要 15–20 秒；
 *   2. 一页 6 道题让模型一口气输出 6 条 JSON，很容易漏题或张冠李戴。
 * 按题目之间的空白带切成 2–4 段并发请求，每段只判断 1–2 道题，既快又准。
 *
 * 切分只依赖「每一行的墨水占比」，不做 OCR。段与段之间刻意留 4% 重叠，
 * 保证编号行不会被切缝劈成两半；重复的编号在结果合并时按置信度去重。
 */

export interface StripRange {
    /** 起始行（分析图坐标，含） */
    y0: number;
    /** 结束行（分析图坐标，含） */
    y1: number;
}

export interface PlanOptions {
    /** 最多切几段 */
    maxStrips?: number;
    /** 每段至少占总内容高度的比例，防止切出一堆碎片 */
    minStripRatio?: number;
    /** 一行里非背景像素占比低于它 → 这一行算空白 */
    quietInk?: number;
    /** 连续多少行空白才算一条可用的切缝 */
    quietRunMin?: number;
    /** 完全找不到空白带时，最安静的行也必须低于这个墨水占比才敢切 */
    denseInk?: number;
}

/**
 * 计算切分方案。纯函数，方便单测。
 * rowInk[y] 是第 y 行「非背景像素占比」，top/bottom 是内容上下边界（含）。
 */
export function planStrips(
    rowInk: ArrayLike<number>,
    top: number,
    bottom: number,
    opts: PlanOptions = {},
): StripRange[] {
    const maxStrips = Math.max(1, opts.maxStrips ?? 4);
    const minStripRatio = opts.minStripRatio ?? 0.16;
    const quietInk = opts.quietInk ?? 0.012;
    const quietRunMin = Math.max(1, opts.quietRunMin ?? 2);
    const denseInk = opts.denseInk ?? 0.05;

    if (!(bottom > top)) return [];
    const totalH = bottom - top + 1;
    // 太矮的整块（半页以内）多半只有一两道题，切了反而更慢
    if (totalH < 120) return [{ y0: top, y1: bottom }];

    const minH = Math.max(16, Math.round(totalH * minStripRatio));

    /** 在 [a,b] 里找最靠近正中的切缝；找不到返回 -1 */
    const findCut = (a: number, b: number): number => {
        const lo = a + minH;
        const hi = b - minH;
        if (hi <= lo) return -1;
        const mid = (a + b) / 2;

        let runStart = -1;
        let best = -1;
        let bestDist = Infinity;
        for (let y = lo; y <= hi; y++) {
            const quiet = rowInk[y] < quietInk;
            if (quiet && runStart < 0) runStart = y;
            if ((!quiet || y === hi) && runStart >= 0) {
                const runEnd = quiet ? y : y - 1;
                if (runEnd - runStart + 1 >= quietRunMin) {
                    const c = Math.round((runStart + runEnd) / 2);
                    const dist = Math.abs(c - mid);
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = c;
                    }
                }
                runStart = -1;
            }
        }
        if (best >= 0) return best;

        // 一条空白带都没有：只在足够稀疏的位置切，否则宁可整段送模型
        let quietest = -1;
        let quietestInk = Infinity;
        for (let y = lo; y <= hi; y++) {
            if (rowInk[y] < quietestInk) {
                quietestInk = rowInk[y];
                quietest = y;
            }
        }
        return quietestInk <= denseInk ? quietest : -1;
    };

    const out: StripRange[] = [];
    const depth = Math.max(0, Math.ceil(Math.log2(Math.max(1, maxStrips))));

    const split = (a: number, b: number, d: number) => {
        const h = b - a + 1;
        if (d <= 0 || h < minH * 2 || out.length >= maxStrips * 2) {
            out.push({ y0: a, y1: b });
            return;
        }
        const cut = findCut(a, b);
        if (cut < 0) {
            out.push({ y0: a, y1: b });
            return;
        }
        split(a, cut, d - 1);
        split(cut + 1, b, d - 1);
    };

    split(top, bottom, depth);
    return out.length ? out : [{ y0: top, y1: bottom }];
}

/* ────────────────────────── 图片处理（依赖 canvas） ────────────────────────── */

const ANALYSIS_WIDTH = 520;

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image load failed"));
        img.src = url;
    });
}

/** 逐行的「非背景像素占比」。浅灰纸面算背景，手写笔迹/印刷字算墨水。 */
function rowInkOf(img: HTMLImageElement): { rowInk: Float32Array; w: number; h: number } | null {
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    if (!sw || !sh) return null;
    const scale = Math.min(1, ANALYSIS_WIDTH / sw);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    let data: Uint8ClampedArray;
    try {
        data = ctx.getImageData(0, 0, w, h).data;
    } catch {
        return null;
    }

    const rowInk = new Float32Array(h);
    for (let y = 0; y < h; y++) {
        let ink = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            // 照片有噪点和阴影，阈值放得比截屏宽一点
            if (r < 200 || g < 200 || b < 200) ink++;
        }
        rowInk[y] = ink / w;
    }
    return { rowInk, w, h };
}

export interface ScanStrip {
    dataUrl: string;
    /** 段序号，从 0 开始 */
    index: number;
    /** 源图中的像素范围，仅用于调试 */
    y0: number;
    y1: number;
}

/** 段与段的重叠比例：编号行正好压在切缝上时，靠重叠保住它 */
const OVERLAP_RATIO = 0.06;

/**
 * 把一张试卷照片切成若干段。任何异常都返回「整张图作为唯一一段」，
 * 调用方不需要为失败写额外分支。
 */
export async function splitForScan(dataUrl: string, maxWidth = 1600): Promise<ScanStrip[]> {
    const whole: ScanStrip[] = [{ dataUrl, index: 0, y0: 0, y1: 0 }];
    let img: HTMLImageElement;
    try {
        img = await loadImage(dataUrl);
    } catch {
        return whole;
    }
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    if (sw < 320 || sh < 400) return whole;

    const stats = rowInkOf(img);
    if (!stats) return whole;
    const { rowInk, h } = stats;

    // 上下各留 12% 的余量找内容边界，避免把大片黑边当内容
    let top = 0;
    const topLimit = Math.floor(h * 0.12);
    while (top < topLimit && rowInk[top] < 0.02) top++;
    let bottom = h - 1;
    const bottomLimit = Math.floor(h * 0.12);
    while (h - 1 - bottom < bottomLimit && bottom > top && rowInk[bottom] < 0.02) bottom--;

    const ranges = planStrips(rowInk, top, bottom);
    if (ranges.length <= 1) return whole;

    const totalH = bottom - top + 1;
    const overlap = Math.round(totalH * OVERLAP_RATIO);
    const ratio = sh / h;
    const targetW = Math.min(maxWidth, sw);

    const strips: ScanStrip[] = [];
    for (let i = 0; i < ranges.length; i++) {
        const a = Math.max(top, ranges[i].y0 - overlap);
        const b = Math.min(bottom, ranges[i].y1 + overlap);
        const sy = Math.floor(a * ratio);
        const sh2 = Math.max(1, Math.ceil((b - a + 1) * ratio));
        const sh2c = Math.min(sh2, sh - sy);
        if (sh2c < 40) continue;

        const outW = Math.min(targetW, sw);
        const outH = Math.max(1, Math.round((sh2c * outW) / sw));
        const canvas = document.createElement("canvas");
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return whole;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(img, 0, sy, sw, sh2c, 0, 0, outW, outH);

        strips.push({
            dataUrl: canvas.toDataURL("image/jpeg", outW >= 1200 ? 0.86 : 0.82),
            index: i,
            y0: sy,
            y1: sy + sh2c,
        });
    }

    return strips.length ? strips : whole;
}
