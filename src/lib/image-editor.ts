/**
 * 图片编辑器内核（纯逻辑，不碰 DOM）。
 *
 * 设计要点：
 *   1. 所有坐标一律归一化到 0~1，与图片分辨率解耦。
 *      这样显示层可以画在 900px 宽的画布上，导出时按 2400px 重放，位置完全一致。
 *   2. 编辑历史只存「操作指令」，不存像素。
 *      一张 2400×3200 的位图占 30MB，存 20 步就是 600MB，手机必崩；
 *      指令一条不过几十字节，撤销时从基准图重放即可。
 *   3. 抹除不是删除像素，而是用纸面色盖住；搬移是「源区填色 + 目标区贴图」。
 *      两者都属于破坏性像素编辑，落地即不可逆（只能撤销）。
 */

export type Pt = { x: number; y: number };
/** 归一化矩形：x/y/w/h 均在 0~1 */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * 三档笔宽，相对**图片宽度**的百分比。
 * 用比例而不是像素，手机（2400px 宽）和电脑预览才有一致手感：
 * 0.012 / 0.025 / 0.05 在 2400px 下分别是 29 / 60 / 120px。
 */
export const ERASE_WIDTHS = [0.012, 0.025, 0.05] as const;
export type EraseSize = 0 | 1 | 2;

export type EraseOp = {
    type: "erase";
    size: EraseSize;
    /** 纸面色；纯白在拍纸上会像补丁，默认取周边采样 */
    color: string;
    points: Pt[];
};

export type MoveOp = {
    type: "move";
    src: Rect;
    dst: Rect;
    color: string;
};

export type EditOp = EraseOp | MoveOp;

export function eraseWidthRatio(size: EraseSize): number {
    return ERASE_WIDTHS[size] ?? ERASE_WIDTHS[1];
}

export function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 两个点（拖动起止）→ 归一化矩形；支持反向拖 */
export function normalizeRect(a: Pt, b: Pt): Rect {
    const x = clamp01(Math.min(a.x, b.x));
    const y = clamp01(Math.min(a.y, b.y));
    const x2 = clamp01(Math.max(a.x, b.x));
    const y2 = clamp01(Math.max(a.y, b.y));
    return { x, y, w: x2 - x, h: y2 - y };
}

/** 最小可操作尺寸：低于它视为误触，不生成选区 */
export const MIN_RECT = 0.02;

/** 把矩形收进画布内，并保证不小于最小尺寸 */
export function clampRect(r: Rect): Rect {
    const w = Math.min(1, Math.max(MIN_RECT, r.w));
    const h = Math.min(1, Math.max(MIN_RECT, r.h));
    return {
        w,
        h,
        x: clamp01(Math.min(r.x, 1 - w)),
        y: clamp01(Math.min(r.y, 1 - h)),
    };
}

/** 归一化矩形 → 像素矩形（取整，至少 1px，防止 drawImage 传 0 报错） */
export function rectToPixels(r: Rect, width: number, height: number) {
    const x = Math.round(clamp01(r.x) * width);
    const y = Math.round(clamp01(r.y) * height);
    const w = Math.max(1, Math.round(clamp01(r.w) * width));
    const h = Math.max(1, Math.round(clamp01(r.h) * height));
    return {
        x: Math.min(x, Math.max(0, width - 1)),
        y: Math.min(y, Math.max(0, height - 1)),
        w: Math.min(w, width - x),
        h: Math.min(h, height - y),
    };
}

/** 矩形是否小到不该被当成一次有效框选 */
export function isRectUsable(r: Rect): boolean {
    return r.w >= MIN_RECT && r.h >= MIN_RECT;
}

export type Handle = "nw" | "ne" | "sw" | "se";

export const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];

/**
 * 拖四角手柄做**等比**缩放：以对角点为锚，宽高按原比例走。
 *
 * 为什么不给自由缩放：题目图形被拉扁之后用户往往看不出来，
 * 等打印出来才发现圆变成椭圆。等比是更安全的默认。
 *
 * 比例取归一化空间的 w/h。看着像少了像素比换算，其实正好抵消：
 * 像素比 = (w·W)/(h·H) = (w/h)·(W/H)，而 h = w/(w/h) 时该式恒等，
 * 所以只要保持归一化的 w/h，屏幕上的形状就不会变形。
 */
export function resizeFromHandle(rect: Rect, handle: Handle, pointer: Pt): Rect {
    const ratio = rect.h > 0 ? rect.w / rect.h : 1;
    const left = handle === "nw" || handle === "sw";
    const top = handle === "nw" || handle === "ne";
    const anchorX = left ? rect.x + rect.w : rect.x;
    const anchorY = top ? rect.y + rect.h : rect.y;

    const wFromX = Math.abs(clamp01(pointer.x) - anchorX);
    // 纵向位移换算成“等效宽度”，谁拉得多听谁的，手感才跟手
    const wFromY = Math.abs(clamp01(pointer.y) - anchorY) * ratio;
    const raw = Math.max(wFromX, wFromY);

    /**
     * 先按「锚点还剩多少空间」把宽度压住，再反推高度。
     * 不能先算完 w/h 再 clampRect：那会把宽高分别截断，框被拉成别的比例，
     * 用户看到的就是「拉着拉着图形扁了」。
     */
    const roomW = left ? anchorX : 1 - anchorX;
    const roomH = top ? anchorY : 1 - anchorY;
    // 下限保证 h 不小于最小可操作尺寸
    const minW = MIN_RECT * Math.max(1, ratio);
    const w = Math.max(minW, Math.min(raw, roomW, roomH * ratio));
    const h = w / Math.max(0.05, ratio);

    return {
        x: clamp01(left ? anchorX - w : anchorX),
        y: clamp01(top ? anchorY - h : anchorY),
        w: Math.min(w, 1),
        h: Math.min(h, 1),
    };
}

/** 判断点是否落在矩形内（用于「按在框里 = 移动」） */
export function hitRect(r: Rect, p: Pt): boolean {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** 命中哪个手柄（按外扩 3% 的容差，手指点不准也能抓住） */
export function hitHandle(r: Rect, p: Pt, tolerance = 0.035): Handle | null {
    const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
    if (near(p.x, r.x) && near(p.y, r.y)) return "nw";
    if (near(p.x, r.x + r.w) && near(p.y, r.y)) return "ne";
    if (near(p.x, r.x) && near(p.y, r.y + r.h)) return "sw";
    if (near(p.x, r.x + r.w) && near(p.y, r.y + r.h)) return "se";
    return null;
}

/** 平移矩形，限制在画布内 */
export function moveRect(r: Rect, dx: number, dy: number): Rect {
    return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
}

/**
 * 从一圈像素里挑出「纸面色」。
 *
 * 直接填 #fff 的问题：拍出来的纸是灰的（台灯光下常是 #e6e4df），
 * 抹一块纯白上去像贴了张创可贴，比原来的批改痕迹还显眼。
 * 这里取中位数并丢掉暗像素（那是墨迹），得到的就是这块纸本来的颜色。
 *
 * @param rgba 长度必须是 4 的倍数，格式同 ImageData.data
 */
export function pickPaperColor(rgba: ArrayLike<number>): string {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let i = 0; i + 3 < rgba.length; i += 4) {
        if (rgba[i + 3] < 16) continue; // 透明像素不参与
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma < 150) continue; // 墨迹、阴影
        rs.push(r);
        gs.push(g);
        bs.push(b);
    }
    if (!rs.length) return "#ffffff";
    const mid = (arr: number[]) => {
        arr.sort((a, b) => a - b);
        return arr[Math.floor(arr.length / 2)];
    };
    const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${hex(mid(rs))}${hex(mid(gs))}${hex(mid(bs))}`;
}

/** 历史最多保留多少步（指令很轻，20 步足够回退到「刚进编辑器」附近） */
export const MAX_HISTORY = 20;

export function pushOp(ops: EditOp[], op: EditOp): EditOp[] {
    const next = [...ops, op];
    return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

export function popOp(ops: EditOp[]): EditOp[] {
    return ops.slice(0, -1);
}

/** 一句话描述当前改了什么，给顶栏显示 */
export function summarize(ops: EditOp[]): { erase: number; move: number } {
    let erase = 0;
    let move = 0;
    for (const op of ops) {
        if (op.type === "erase") erase++;
        else move++;
    }
    return { erase, move };
}
