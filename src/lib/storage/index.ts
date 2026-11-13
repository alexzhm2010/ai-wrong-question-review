/**
 * 图片存储的唯一入口。
 *
 * 规矩只有一条：**任何地方要存图或取图，都必须经过这里**。
 *   - 存：`putImage()` / `ingestImage()` 返回一个引用（字符串），把它写进库；
 *   - 取：`imageSrc(ref)` 给 `<img src>`，`imageDataUrl(ref)` 给需要 base64 的地方（AI、canvas）。
 *
 * 现在引用就是完整 data URL，所以库里的数据格式和以前一模一样、渲染结果也一模一样；
 * 将来切 R2/COS，只要在 `driver.ts` 里加一个驱动、这里换一行 `createDriver()`，
 * 页面、批量流水线、AI 链路都不用动。
 */
import { compressImage, makeThumbnail } from "../image-utils";
import {
    createRemoteDriver,
    inlineDriver,
    type ImageRole,
    type ImageStoreDriver,
} from "./driver";
import { hasImageRef, isDirectUrl, isRemoteRef, refToSrc, toDataUrl } from "./ref";

/** 构建期选驱动。默认 inline，未配置远程存储时强行传 r2 会退回 inline */
function createDriver(): ImageStoreDriver {
    const kind = (process.env.NEXT_PUBLIC_IMAGE_STORE || "inline").toLowerCase();
    if (kind === "inline") return inlineDriver;

    const bucket = process.env.NEXT_PUBLIC_IMAGE_BUCKET || "";
    const cdnBase = process.env.NEXT_PUBLIC_IMAGE_CDN || "";
    const signUrl = process.env.NEXT_PUBLIC_IMAGE_SIGN_URL || "";
    if (!bucket || !cdnBase || !signUrl) {
        // 配置不全就别硬上：宁可继续用数据库，也不要上线一半图片打不开
        console.warn("[image-store] 远程存储配置不完整，回退 inline");
        return inlineDriver;
    }
    return createRemoteDriver({
        scheme: kind === "cos" ? "cos" : kind === "s3" ? "s3" : "r2",
        bucket,
        cdnBase,
        signUrl,
    });
}

const driver = createDriver();

export const imageStoreKind = driver.name;

/** 引用 → `<img src>`。同步、纯字符串处理，可以直接写在 JSX 里 */
export function imageSrc(ref: string | null | undefined): string {
    return refToSrc(ref, { cdnBase: driver.cdnBase });
}

/** 有没有图。替代散落各处的 `!!imageBase64` / `length > 100` */
export function hasImage(ref: unknown): boolean {
    return hasImageRef(ref);
}

/**
 * 写入一张已经处理好的图（data URL），返回可入库的引用。
 * 一般不用直接调它，用下面的 `ingestImage()` 更省事。
 */
export async function putImage(
    dataUrl: string,
    opts: { role?: ImageRole; ownerId?: string } = {},
): Promise<string> {
    if (!dataUrl) return "";
    return driver.put({
        dataUrl,
        role: opts.role || "question",
        ownerId: opts.ownerId,
    });
}

/** 删除引用。inline 下是空实现；远程存储下删除对象（失败不抛，孤儿对象靠生命周期规则清） */
export async function dropImages(refs: Array<string | null | undefined>): Promise<void> {
    const list = Array.from(new Set(refs.filter((r): r is string => !!r && typeof r === "string")));
    if (!list.length) return;
    await driver.remove(list).catch(() => {});
}

export interface IngestOptions {
    role?: ImageRole;
    ownerId?: string;
    /** 最长边，默认 2400（A4 打印约 200dpi） */
    maxWidth?: number;
    /** JPEG 质量，默认 0.88 */
    quality?: number;
    /** 单张体积上限（MB），默认 2 */
    maxMB?: number;
    /** 是否顺带生成缩略图；不传则按驱动决定（inline 需要，远程不需要） */
    thumb?: boolean;
    /** 缩略图长边，默认 240 */
    thumbWidth?: number;
}

export interface IngestedImage {
    /** 原图引用 */
    ref: string;
    /** 缩略图引用（不需要时为 undefined） */
    thumb?: string;
    /** 规范化后的 data URL —— AI 分析要直接喂给模型，避免再解码一次 */
    dataUrl: string;
    /** 估算字节数，用于界面提示和体积预算 */
    bytes: number;
}

const estimateBytes = (dataUrl: string) => Math.round((dataUrl.length * 3) / 4);

/**
 * 一张用户选的图 → 可入库的引用。
 *
 * 把「压缩 → 缩略图 → 上传」三步合在一起，是因为它们必须一起发生：
 * 分流到各页面自己拼，切存储时就会漏掉某一个入口（历史上换图那条路就漏过压缩）。
 */
export async function ingestImage(
    input: File | string,
    opts: IngestOptions = {},
): Promise<IngestedImage> {
    const dataUrl =
        typeof input === "string"
            ? toDataUrl(input) || input
            : await compressImage(
                  input,
                  opts.maxMB ?? 2,
                  opts.maxWidth ?? 2400,
                  opts.quality ?? 0.88,
              );

    const ref = await putImage(dataUrl, { role: opts.role, ownerId: opts.ownerId });
    const wantThumb = opts.thumb ?? driver.wantsThumb;
    let thumb: string | undefined;
    if (wantThumb && dataUrl) {
        const raw = await makeThumbnail(dataUrl, opts.thumbWidth ?? 240).catch(() => "");
        // makeThumbnail 返回裸 base64，统一补成 data URL 再交给驱动，
        // 保证库里不会同时存在「带前缀」和「不带前缀」两种缩略图
        if (raw) thumb = await putImage(toDataUrl(raw), { role: "thumb", ownerId: opts.ownerId });
    }
    return { ref, thumb, dataUrl, bytes: estimateBytes(dataUrl) };
}

/** 引用 → data URL（远程存储下会走一次网络）；失败返回空串，不抛 */
export async function imageDataUrl(ref: string | null | undefined): Promise<string> {
    const s = (ref || "").trim();
    if (!s) return "";
    const inline = toDataUrl(s);
    if (inline) return inline;

    const src = imageSrc(s);
    if (!src || !(isRemoteRef(s) || isDirectUrl(src))) return "";
    try {
        const res = await fetch(src);
        if (!res.ok) return "";
        const blob = await res.blob();
        return await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve("");
            reader.readAsDataURL(blob);
        });
    } catch {
        return "";
    }
}

/** 引用 → 裸 base64（AI 接口用）；也兼容远程引用 */
export async function imageBase64(ref: string | null | undefined): Promise<string> {
    const dataUrl = await imageDataUrl(ref);
    return dataUrl.replace(/^data:[^;,]+;base64,/, "");
}
