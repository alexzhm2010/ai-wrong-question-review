/**
 * 题目缩略图缓存（IndexedDB）。
 *
 * 背景：列表接口刻意不返回 originalImageUrl（单张 base64 几百 KB，全库 7MB+），
 * 但卡片翻转后要显示题目截图，所以只能按需拉单题详情。
 * 拉回来的原图不直接塞进卡片（内存吃不消），而是先缩到 480px 存进 IndexedDB：
 *   - 第二次翻同一张卡是**本地秒开**，不再走网络；
 *   - 换图（原图编辑）后会主动失效，不会显示旧截图。
 *
 * IndexedDB 不可用（无痕模式、部分 WebView）时退化为内存 Map，功能不受影响。
 */

const DB_NAME = "wq-thumbs";
const DB_VERSION = 1;
const STORE = "thumbs";
export const THUMB_WIDTH = 480;

interface ThumbRow {
    id: string;
    url: string;
    /** 原图长度做指纹，换了图就不会命中旧缩略图 */
    sig: number;
    at: number;
}

const memFallback = new Map<string, ThumbRow>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        try {
            if (typeof indexedDB === "undefined") return resolve(null);
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode) {
    return db.transaction(STORE, mode).objectStore(STORE);
}

export async function readThumb(id: string, sig?: number): Promise<string | null> {
    const memHit = memFallback.get(id);
    if (memHit && (sig === undefined || memHit.sig === sig)) return memHit.url;

    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const req = tx(db, "readonly").get(id);
            req.onsuccess = () => {
                const row = req.result as ThumbRow | undefined;
                if (!row || (sig !== undefined && row.sig !== sig)) return resolve(null);
                memFallback.set(id, row);
                resolve(row.url);
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

export async function writeThumb(id: string, url: string, sig: number): Promise<void> {
    const row: ThumbRow = { id, url, sig, at: Date.now() };
    memFallback.set(id, row);
    const db = await openDb();
    if (!db) return;
    try {
        tx(db, "readwrite").put(row);
    } catch {
        /* 写失败不影响本次显示 */
    }
}

export async function dropThumb(id: string): Promise<void> {
    memFallback.delete(id);
    const db = await openDb();
    if (!db) return;
    try {
        tx(db, "readwrite").delete(id);
    } catch {
        /* 忽略 */
    }
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

/** 把原图缩成卡片用的缩略图；失败就原样返回，宁可糊一点也不能空着 */
export async function makeThumb(src: string, width = THUMB_WIDTH): Promise<string> {
    try {
        const img = await loadImage(src);
        const w = Math.min(width, img.naturalWidth || width);
        const h = Math.max(1, Math.round(((img.naturalHeight || w) * w) / (img.naturalWidth || w)));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return src;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
        return src;
    }
}

/** 缩略图未命中时最多并发拉 3 张，避免连翻 20 张卡把网络打满 */
const MAX_FETCH = 3;
let fetching = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
    if (fetching < MAX_FETCH) {
        fetching++;
        return Promise.resolve();
    }
    return new Promise<void>((r) => queue.push(() => { fetching++; r(); }));
}

function release(): void {
    fetching--;
    const next = queue.shift();
    if (next) next();
}

/**
 * 取一张卡的展示图：先查本地缓存，未命中才调用 fetcher 拉原图并缩图。
 * fetcher 由调用方注入（避免这里依赖 apiClient，方便单测）。
 */
export async function ensureThumb(
    id: string,
    fetcher: () => Promise<{ originalImageUrl?: string } | null>,
    sig = 0,
): Promise<string | null> {
    const cached = await readThumb(id, sig || undefined);
    if (cached) return cached;

    await acquire();
    try {
        const again = await readThumb(id, sig || undefined);
        if (again) return again; // 排队期间别人已经拉回来了
        const detail = await fetcher();
        const raw = detail?.originalImageUrl;
        if (!raw) return null;
        const thumb = await makeThumb(raw);
        await writeThumb(id, thumb, sig);
        return thumb;
    } catch {
        return null;
    } finally {
        release();
    }
}
