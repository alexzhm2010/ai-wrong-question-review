/**
 * 图片引用（ImageRef）的编解码 —— 纯函数，不做 IO，方便单测。
 *
 * 为什么需要这一层：
 * 现在图片是 base64 直存数据库（题目表 originalImageUrl、批次表 imageBase64），
 * 前端到处写 `<img src={item.originalImageUrl}>`。一旦换成 R2/COS，
 * 库里存的是对象 key，src 要拼 CDN 前缀，读写两侧十几处都得改。
 * 这里先把「引用」定义成一个不透明字符串，并统一提供「引用 → 可显示地址」的转换，
 * 让调用方只认 `imageSrc()`，将来换存储时不用回头找 `<img>`。
 *
 * 目前支持的引用形态：
 *   - `data:image/jpeg;base64,...`  当前正式格式（题目表就是它）
 *   - 裸 base64（`/9j/...`）        历史批次数据，读写时自动补前缀
 *   - `r2://bucket/key`             将来切对象存储时的格式
 *   - `https://...` / `/path`       已经是可直接访问的地址，原样返回
 */

/** 对象存储引用前缀；改存储方案时只在这里加一种 */
const REMOTE_SCHEMES = ["r2://", "s3://", "cos://"] as const;

export interface RemoteRef {
    scheme: string;
    bucket: string;
    key: string;
}

export const isDataRef = (ref: string): boolean => ref.startsWith("data:");

/**
 * 没有任何前缀的裸 base64（历史 BatchItem 里存的就是这个）。
 *
 * 长度阈值必须够大：JPEG 的 base64 恰好以 `/9j/` 开头，
 * 短串很容易和站点内路径（`/images/a.jpg`）撞车，所以先按长度筛。
 * 一张 240px 缩略图的 base64 也有几 KB，200 字符是安全下限。
 */
export function isBareBase64(ref: string): boolean {
    if (!ref || ref.length < 200) return false;
    if (ref.startsWith("data:") || ref.startsWith("http")) return false;
    return /^[A-Za-z0-9+/=\r\n]+$/.test(ref.slice(0, 200));
}

export function isRemoteRef(ref: string): boolean {
    return REMOTE_SCHEMES.some((s) => ref.startsWith(s));
}

/** 已经是可访问地址（绝对 URL、站点内路径、blob） */
export function isDirectUrl(ref: string): boolean {
    return /^(https?:)?\/\//i.test(ref) || ref.startsWith("/") || ref.startsWith("blob:");
}

/** 解析 `r2://bucket/key`；不是对象存储引用时返回 null */
export function parseRemoteRef(ref: string): RemoteRef | null {
    const scheme = (REMOTE_SCHEMES as readonly string[]).find((s) => ref.startsWith(s));
    if (!scheme) return null;
    const rest = ref.slice(scheme.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    return { scheme: scheme.slice(0, -3), bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

/** 按 base64 魔数猜 MIME，猜不出按 JPEG（库里 99% 是 JPEG） */
export function sniffMime(b64: string): string {
    const head = b64.slice(0, 12);
    if (head.startsWith("iVBOR")) return "image/png";
    if (head.startsWith("R0lGOD")) return "image/gif";
    if (head.startsWith("UklGR")) return "image/webp";
    if (head.startsWith("PHN2Zy") || head.startsWith("PD94bWw")) return "image/svg+xml";
    return "image/jpeg";
}

/** 裸 base64 / 远程引用 → 可直接当 src 的 data URL；本身已是 data URL 就原样返回 */
export function toDataUrl(ref: string): string {
    const s = (ref || "").trim();
    if (!s) return "";
    if (isDataRef(s)) return s;
    if (isBareBase64(s)) return `data:${sniffMime(s)};base64,${s}`;
    return "";
}

export interface SrcOptions {
    /** 对象存储的访问前缀，如 `https://img.example.com` */
    cdnBase?: string;
}

/**
 * 引用 → `<img src>` 能直接吃的字符串。**同步**，因为 img 不等 Promise。
 * 空引用返回空串（调用方自己判断要不要渲染）。
 */
export function refToSrc(ref: string | null | undefined, opts: SrcOptions = {}): string {
    const s = (ref || "").trim();
    if (!s) return "";
    // 先判裸 base64：JPEG 的 base64 以 `/9j/` 开头，会被 isDirectUrl 的路径分支误吞
    if (isDataRef(s) || isBareBase64(s)) return toDataUrl(s);
    if (isDirectUrl(s)) return s;

    const remote = parseRemoteRef(s);
    if (remote) {
        const base = (opts.cdnBase || "").replace(/\/+$/, "");
        // 没配 CDN 时把 key 原样吐出来：宁可 404 也别渲染出半个 base64 把人误导
        return base ? `${base}/${remote.key}` : s;
    }
    return toDataUrl(s);
}

/**
 * 判断字段里「有没有图」。
 *
 * 不能再用 `!!imageBase64`：远程引用只有几十个字符，
 * 而历史判重用的是「长度 > 100」（为了过滤空串和占位符）。
 * 这里把两种都认下来。
 */
export function hasImageRef(ref: unknown): boolean {
    if (typeof ref !== "string") return false;
    const s = ref.trim();
    if (s.length < 8) return false;
    return isRemoteRef(s) || isDirectUrl(s) || isDataRef(s) || isBareBase64(s);
}

/** 从 data URL 里取出裸 base64（给只收 base64 的 AI 接口用） */
export function stripDataUrl(ref: string): string {
    return (ref || "").replace(/^data:[^;,]+;base64,/, "");
}
