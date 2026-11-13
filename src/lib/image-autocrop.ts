/**
 * 打印前的图片自动裁边（纯浏览器本地，图片不出本机）。
 *
 * 错题原图多数是整页手机截图或整页拍照：顶部压着状态栏，四周是大片白边。
 * 直接按原图排版，一道题就要吃掉一整页，A4 上还看不清字。
 * 这里做三件事：
 *   1. 剥掉顶部深色状态栏、顶部空白；
 *   2. 找到真正的「内容包围盒」，削掉四周白边；
 *   3. 按目标宽度重采样，顺手把体积压下来（打印队列小很多）。
 *
 * 判定阈值偏保守：宁可少裁一点，也不能把题干、图形、手写批注裁掉。
 */

/**
 * 分析宽度。720 而不是 560：分数「2/3」的分母、页码、小题分值这类小字，
 * 在 560 宽下只剩 1px 笔画，逐行统计时会被误判成空白而行整行裁掉。
 * 只在选中打印时才跑，多这点像素换「不切字」值得。
 */
const ANALYSIS_WIDTH = 720;
/** 纸面白：三通道都高于它且接近中性色，才算背景 */
const BG_LUMA = 228;
const BG_CHROMA = 26;
/** 一行里非背景像素占比低于它 → 认为这一行是空白 */
const ROW_INK_MIN = 0.01;
/** 列比行严一点：宽松会把本来该裁掉的窄白边留下 */
const COL_INK_MIN = 0.015;
/**
 * 「稀疏墨」阈值。
 *
 * v1.18.41 修复：图片最下方常有「2/3」这类得分标记，分母缩到分析宽度后
 * 单行只有一两像素笔画，按 ROW_INK_MIN(1%) 会被判成空白行，于是底边一路
 * 往上跳过分母，只留分子——看起来就是「2/—」，分不清 2 还是 3。
 *
 * 0.25% ≈ 720 宽下 1.8px：足够接住细笔画，又不会把 JPEG 噪点当成内容。
 * 裁边遇到它立即停手，宁可多留一条白边。
 */
const SPARSE_INK = 0.0025;
/** 深色状态栏：平均亮度低于它、且非背景占比高于 STATUS_INK_MIN */
const STATUS_LUMA_MAX = 96;
const STATUS_INK_MIN = 0.5;

export interface CropOutcome {
    /** 结果图（data URL）；未裁时就是原图 */
    url: string;
    /** 是否真的裁过 */
    changed: boolean;
    /** 面积减少比例 0~1，用于「已省 xx% 空白」提示 */
    saved: number;
}

const cache = new Map<string, Promise<CropOutcome>>();
const pending = new Set<Promise<unknown>>();

/** data URL 很长，取长度 + 首尾片段做键即可（同源同名图不会碰撞） */
function cacheKey(url: string, maxWidth: number): string {
    return `${maxWidth}|${url.length}|${url.slice(0, 48)}|${url.slice(-48)}`;
}

export function clearCropCache(): void {
    cache.clear();
}

/** 登记一个正在跑的裁剪任务，打印前好等它 */
export function trackCrop<T>(p: Promise<T>): Promise<T> {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
    return p;
}

/**
 * 等所有在跑的裁剪收尾。超时就直接放行——宁可少裁几张，
 * 也不能让用户点了「打印」之后干等。
 */
export async function waitForCrops(timeoutMs = 6000): Promise<void> {
    if (!pending.size) return;
    const all = Promise.allSettled([...pending]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image load failed"));
        img.src = url;
    });
}

function isBackground(r: number, g: number, b: number): boolean {
    if (r < BG_LUMA || g < BG_LUMA || b < BG_LUMA) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max - min <= BG_CHROMA;
}

/**
 * 从边界 edge 朝 inner 方向跳过空白行，返回最后一个**仍需保留**的行号。
 *
 * 和「低于阈值就当空白」的旧写法有三点不同：
 *   1. 「有墨」的门槛降到 SPARSE_INK，分数分母、页码这类小字也算内容；
 *   2. 连续两行有稀疏墨 → 认定是小字，立即停手（单行孤立墨点当噪点跳过）；
 *   3. 遇到实墨行必定停。
 * 纯函数，便于单测；坐标越界由调用方保证。
 */
export function trimBlankEdge(
    rowInk: ArrayLike<number>,
    edge: number,
    inner: number,
    maxRows: number,
    sparseInk: number = SPARSE_INK,
    solidInk: number = ROW_INK_MIN,
): number {
    const step = edge >= inner ? -1 : 1;
    let y = edge;
    let moved = 0;
    let runStart = -1; // 当前「连续有墨块」从哪一行开始（离 edge 最近的一行）
    while (y !== inner && moved < maxRows) {
        const ink = Number(rowInk[y] || 0);
        if (ink >= sparseInk) {
            if (runStart < 0) runStart = y;
            if (ink >= solidInk) return runStart;
            // 已经连着两行有墨：不是噪点，是小字，停（返回更靠内的那一行，连边上的笔画一起留住）
            if (Math.abs(y - runStart) >= 1) return y;
        } else {
            runStart = -1;
        }
        y += step;
        moved++;
    }
    return runStart >= 0 ? runStart : y;
}

/** [from, to] 区间内是否存在墨迹（含稀疏小字）；用于「裁掉的区域里到底有没有内容」这道保险 */
export function hasInkTrace(
    rowInk: ArrayLike<number>,
    from: number,
    to: number,
    sparseInk: number = SPARSE_INK,
): boolean {
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(rowInk.length - 1, Math.max(from, to));
    for (let y = start; y <= end; y++) {
        if (Number(rowInk[y] || 0) >= sparseInk) return true;
    }
    return false;
}

/**
 * 在缩小的灰度图上找内容框。返回源图坐标（未缩放）。
 * 任何异常（canvas 被跨域污染、图太小）都返回 null，调用方退回原图。
 */
function detectContentBox(img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
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
        return null; // 跨域图会污染画布，裁不了就算了
    }

    const rowInk = new Float32Array(h);
    const rowLuma = new Float32Array(h);
    const rowWhite = new Float32Array(h);
    for (let y = 0; y < h; y++) {
        let ink = 0;
        let white = 0;
        let lumaSum = 0;
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            lumaSum += 0.299 * r + 0.587 * g + 0.114 * b;
            if (!isBackground(r, g, b)) ink++;
            // 「纸白」比「背景」严格：App 的浅色界面底（#EAF3FF、#F5F7FA）不算
            if (r >= 248 && g >= 248 && b >= 248) white++;
        }
        rowInk[y] = ink / w;
        rowLuma[y] = lumaSum / w;
        rowWhite[y] = white / w;
    }

    // ── 上边界：跳过顶部空白行与深色状态栏
    const topLimit = Math.floor(h * 0.2);
    let top = 0;
    while (top < topLimit) {
        const ink = rowInk[top];
        const statusBar = rowLuma[top] < STATUS_LUMA_MAX && ink > STATUS_INK_MIN;
        // 小字（页眉页码之类）也算内容，遇到就停
        if (ink >= SPARSE_INK && !statusBar) break;
        top++;
    }

    // ── 下边界：只跳空白（底部深色块可能就是题目配图，不能误杀）
    const bottomLimit = Math.floor(h * 0.12);
    let bottom = trimBlankEdge(rowInk, h - 1, top, bottomLimit);

    /**
     * 截屏型错题（很多来自解题 App）是这样的：
     *   状态栏 + 标题栏 → 题号圆圈导航 → **白色题目卡片** → 底部输入框。
     * 前两段和底部输入框都是浅色底，不是「白」，所以用「最长的连续纸白段」
     * 就能把中间的题目卡片圈出来——这比猜 UI 高度可靠得多。
     * 纯题目截图整页都是白的，算出的段覆盖全图，等于不裁，天然安全。
     */
    {
        let curStart = -1;
        let bestStart = -1;
        let bestEnd = -1;
        for (let y = 0; y < h; y++) {
            const white = rowWhite[y] >= 0.5;
            if (white && curStart < 0) curStart = y;
            if ((!white || y === h - 1) && curStart >= 0) {
                const end = white ? y : y - 1;
                if (end - curStart > bestEnd - bestStart) {
                    bestStart = curStart;
                    bestEnd = end;
                }
                curStart = -1;
            }
        }
        if (bestStart >= 0 && bestEnd - bestStart >= h * 0.3) {
            const avgWhite = (from: number, to: number) => {
                if (to < from) return 1;
                let sum = 0;
                for (let y = from; y <= to; y++) sum += rowWhite[y];
                return sum / (to - from + 1);
            };
            /**
             * 两道闸门，缺一不可：
             *   1. 白段必须贴着顶部/底部（外壳只会在边上）；
             *   2. 白段外面的那条带子必须**确实不是白底**。
             * 只看 1 会把「上方是白底黑字题干、下方是大片白底图形」的纯题目截图
             * 从中间切开——那正是最不能犯的错。
             */
            const topIsShell = bestStart <= h * 0.24 && avgWhite(0, bestStart - 1) < 0.35;
            const bottomIsShell = bestEnd >= h * 0.86 && avgWhite(bestEnd + 1, h - 1) < 0.45;
            // 白段边界正好压在「底部得分标记」上时不要用它——那是内容，不是外壳
            const cutsContent = hasInkTrace(rowInk, bestEnd + 1, h - 1);
            if (topIsShell && bestStart > top) top = bestStart;
            if (bottomIsShell && bestEnd < bottom && !cutsContent) bottom = bestEnd;
        }
    }

    if (bottom - top < h * 0.08) return null;

    // ── 左右边界：在 [top,bottom] 内逐列统计
    const colInk = new Float32Array(w);
    for (let x = 0; x < w; x++) {
        let ink = 0;
        for (let y = top; y <= bottom; y++) {
            const i = (y * w + x) * 4;
            if (!isBackground(data[i], data[i + 1], data[i + 2])) ink++;
        }
        colInk[x] = ink / (bottom - top + 1);
    }
    const sideLimit = Math.floor(w * 0.08);
    let left = 0;
    while (left < sideLimit && colInk[left] < COL_INK_MIN) left++;
    let right = w - 1;
    while (w - 1 - right < sideLimit && right > left && colInk[right] < COL_INK_MIN) right--;

    // 行方向上再收紧一次：顶部/底部的少量空白也去掉（遇小字即停）
    let t2 = trimBlankEdge(rowInk, top, bottom, bottom - top);
    let b2 = trimBlankEdge(rowInk, bottom, t2, bottom - t2);

    if (right - left < w * 0.1 || b2 - t2 < h * 0.05) return null;

    // 留呼吸边，避免把字形边缘切掉。底边再多给一点：
    // 分数、下划线、根号尾巴这些元素贴着内容框底沿时，1.2% 不够用。
    const padX = Math.round(w * 0.012);
    const padY = Math.round(h * 0.012);
    const padBottom = Math.round(h * 0.022);
    left = Math.max(0, left - padX);
    right = Math.min(w - 1, right + padX);
    t2 = Math.max(0, t2 - padY);
    b2 = Math.min(h - 1, b2 + padBottom);

    const inv = 1 / scale;
    return {
        x: Math.round(left * inv),
        y: Math.round(t2 * inv),
        w: Math.round((right - left + 1) * inv),
        h: Math.round((b2 - t2 + 1) * inv),
    };
}

/** canvas 解码吃内存，一次只跑 3 张，其余排队 */
const MAX_CONCURRENT = 3;
let running = 0;
const waiting: Array<() => void> = [];

function acquire(): Promise<void> {
    if (running < MAX_CONCURRENT) {
        running++;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(() => { running++; resolve(); }));
}

function release(): void {
    running--;
    const next = waiting.shift();
    if (next) next();
}

async function doCrop(url: string, maxWidth: number): Promise<CropOutcome> {
    let img: HTMLImageElement;
    try {
        img = await loadImage(url);
    } catch {
        return { url, changed: false, saved: 0 };
    }
    // 本来就小的图，裁了也省不下多少，白跑一趟
    if (img.naturalWidth < 320 || img.naturalHeight < 200) {
        return { url, changed: false, saved: 0 };
    }

    const box = detectContentBox(img);
    const sw = img.naturalWidth;
    const sh = img.naturalHeight;
    if (!box) return { url, changed: false, saved: 0 };

    const areaRatio = (box.w * box.h) / (sw * sh);
    // 几乎没裁掉的，直接用原图，省一次重编码
    if (areaRatio > 0.985) return { url, changed: false, saved: 0 };

    const targetW = Math.min(maxWidth, box.w);
    const ratio = targetW / box.w;
    const targetH = Math.max(1, Math.round(box.h * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { url, changed: false, saved: 0 };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, targetW, targetH);

    const quality = targetW >= 1000 ? 0.86 : 0.82;
    return {
        url: canvas.toDataURL("image/jpeg", quality),
        changed: true,
        saved: Math.max(0, 1 - areaRatio),
    };
}

/**
 * 裁一张图。同一 URL + 同一目标宽度只会算一次（结果在内存里复用）。
 * 失败一律返回原图，绝不抛错打断打印。
 */
export function autoCrop(url: string, maxWidth = 1200): Promise<CropOutcome> {
    if (!url) return Promise.resolve({ url: "", changed: false, saved: 0 });
    const key = cacheKey(url, maxWidth);
    const hit = cache.get(key);
    if (hit) return hit;

    const task = (async () => {
        await acquire();
        try {
            return await doCrop(url, maxWidth);
        } catch {
            return { url, changed: false, saved: 0 };
        } finally {
            release();
        }
    })();

    cache.set(key, task);
    trackCrop(task);
    return task;
}
