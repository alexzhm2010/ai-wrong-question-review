/**
 * 图片存储驱动：把「一张图存哪儿」这件事收成一个接口。
 *
 * 现在用 inline（base64 直存 Supabase），将来切 R2/COS 只需要新增一个驱动，
 * 上层（页面、批量流水线、AI 分析）一行都不用改。
 */
import { toDataUrl } from "./ref";

/** 一张图在业务上的角色，只用来生成对象 key 和决定要不要缩略图 */
export type ImageRole = "question" | "draft" | "thumb";

export interface PutImageInput {
    /** 已规范化（压缩过）的 data URL */
    dataUrl: string;
    role: ImageRole;
    /** 归属 id（题目 / 批次），inline 驱动忽略；远程驱动用它拼对象 key */
    ownerId?: string;
}

export interface ImageStoreDriver {
    readonly name: string;
    /**
     * 是否需要调用方另外生成缩略图。
     * inline 存库要省体积，所以要；远程存储可以交给 CDN 按需缩放，就不必存两份。
     */
    readonly wantsThumb: boolean;
    /** 对象存储的访问前缀；inline 为 undefined */
    readonly cdnBase?: string;
    /** 写入，返回可入库的引用 */
    put(input: PutImageInput): Promise<string>;
    /** 删除一批引用；inline 是空实现（行删了图就没了） */
    remove(refs: string[]): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* inline：base64 直存数据库（当前线上方案）                            */
/* ------------------------------------------------------------------ */

/**
 * 什么都不做，直接把 data URL 当引用。
 *
 * 之所以还要包一层，是为了让「引用」这个概念在代码里显式存在：
 * 一旦哪天改成远程存储，返回的就是 `r2://bucket/key`，
 * 调用方存进库的字段虽然叫 originalImageUrl，其实已经被换成了 key。
 */
export const inlineDriver: ImageStoreDriver = {
    name: "inline",
    wantsThumb: true,
    async put({ dataUrl }) {
        // 进来必须是 data URL；裸 base64 补前缀，避免库里出现两种格式的新数据
        return toDataUrl(dataUrl);
    },
    async remove() {
        /* 行删了图就跟着没了，无需额外清理 */
    },
};

/* ------------------------------------------------------------------ */
/* r2：对象存储（骨架，未启用）                                        */
/* ------------------------------------------------------------------ */

export interface RemoteDriverConfig {
    /** r2 | cos | s3，只影响返回的引用前缀 */
    scheme: "r2" | "cos" | "s3";
    bucket: string;
    /** 读路径前缀，如 https://img.example.com（绑了自定义域就是自己的域名） */
    cdnBase: string;
    /**
     * 签发接口：POST { op: "put"|"delete", key, contentType, size }
     * → put 返回 { uploadUrl, headers }；delete 返回 { ok: true }
     * 由 Supabase Edge Function 用服务端密钥签名，密钥不进前端。
     */
    signUrl: string;
    /** 取当前登录态 token 的回调（Edge Function 要校验归属） */
    authHeader?: () => string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function buildKey(role: ImageRole, ownerId?: string): string {
    const d = new Date();
    const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const rand = Math.random().toString(36).slice(2, 10);
    const owner = (ownerId || "anon").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    return `${role}/${day}/${owner}-${Date.now().toString(36)}-${rand}.jpg`;
}

/**
 * 浏览器直传对象存储：先向 Edge Function 要一个预签名 PUT，再 PUT 二进制上去。
 * 好处是图片不经过 Supabase 数据库，也不占它的存储额度；
 * 代价是要多一次签名往返（约 80ms），相对一张图的上传耗时可忽略。
 */
export function createRemoteDriver(cfg: RemoteDriverConfig): ImageStoreDriver {
    const sign = async (body: unknown) => {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const auth = cfg.authHeader?.();
        if (auth) headers.Authorization = auth;
        const res = await fetch(cfg.signUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`签名失败 ${res.status}`);
        return res.json();
    };

    return {
        name: cfg.scheme,
        wantsThumb: false,
        cdnBase: cfg.cdnBase,
        async put({ dataUrl, role, ownerId }) {
            const blob = await (await fetch(dataUrl)).blob();
            const key = buildKey(role, ownerId);
            const { uploadUrl, headers } = await sign({
                op: "put",
                key,
                contentType: blob.type || "image/jpeg",
                size: blob.size,
            });
            const up = await fetch(uploadUrl, {
                method: "PUT",
                headers: headers || { "Content-Type": blob.type || "image/jpeg" },
                body: blob,
            });
            if (!up.ok) throw new Error(`上传失败 ${up.status}`);
            return `${cfg.scheme}://${cfg.bucket}/${key}`;
        },
        async remove(refs) {
            const prefix = `${cfg.scheme}://${cfg.bucket}/`;
            const keys = refs
                .filter((r) => r.startsWith(prefix))
                .map((r) => r.slice(prefix.length))
                .filter(Boolean);
            if (!keys.length) return;
            await sign({ op: "delete", keys }).catch(() => {
                /* 删不掉图不影响主流程：孤儿对象后续用生命周期规则清 */
            });
        },
    };
}
