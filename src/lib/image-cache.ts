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

/**
 * 一级缓存：本会话算出来的缩略图直接驻内存，不再走 IndexedDB。
 *
 * 为什么需要：整页翻到截图态时 18 张卡会同时要图，
 * 如果每张都开事务读 IndexedDB，事务会排队，单张能拖到 2～3 秒
 * （实测第二、第三张卡光「排队 + 读」就 2.3s，而真正缩图只要 3ms）。
 * IndexedDB 只负责**跨会话**保留，显示路径尽量不碰它。
 */
const memThumbs = new Map<string, { url: string; sig: number }>();
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

export async function dropThumb(id: string): Promise<void> {
    memFallback.delete(id);
    memThumbs.delete(id);
    fullMem.delete(id);
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

/**
 * 缩略图未命中时最多并发做 5 张。
 * 整页翻到截图态时视口内通常有 6～9 张，并发太低会让后半屏一直转圈；
 * 太高又会把 4G 打满、界面卡顿，5 是实测比较稳的值。
 */
const MAX_FETCH = 5;
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

/** 同一个 id 的重复请求合并成一个 Promise，避免连点/重渲染时反复解码 */
const inflight = new Map<string, Promise<string | null>>();

/**
 * 一次性把库里已有的缩略图全读进内存。
 *
 * 逐张 get 会在同一个 store 上排 18 个读事务，实测首批要 400ms；
 * 一次 getAll 只要几十毫秒，之后翻卡、翻回、换页全是内存命中。
 */
let warmPromise: Promise<void> | null = null;
function warm(): Promise<void> {
    if (warmPromise) return warmPromise;
    warmPromise = (async () => {
        const db = await openDb();
        if (!db) return;
        await new Promise<void>((resolve) => {
            try {
                const req = tx(db, "readonly").getAll();
                req.onsuccess = () => {
                    for (const row of (req.result || []) as ThumbRow[]) {
                        memThumbs.set(row.id, { url: row.url, sig: row.sig });
                        memFallback.set(row.id, row);
                    }
                    resolve();
                };
                req.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    })();
    return warmPromise;
}

/**
 * 写入合并：400ms 内的多张缩略图攒成一条事务写下去。
 * 逐张 put 会产生 18 个读写事务互相排队，合并后只有 1 个。
 */
let writeQueue: ThumbRow[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flushWrites(): void {
    writeTimer = null;
    const batch = writeQueue;
    writeQueue = [];
    if (batch.length === 0) return;
    void (async () => {
        const db = await openDb();
        if (!db) return;
        try {
            const store = tx(db, "readwrite");
            for (const row of batch) store.put(row);
        } catch {
            /* 写失败不影响本次显示 */
        }
    })();
}

function scheduleWrite(row: ThumbRow): void {
    writeQueue.push(row);
    if (writeTimer) return;
    writeTimer = setTimeout(flushWrites, 400);
}

/**
 * 同步窥一眼内存里的缩略图。
 *
 * 用途：从详情页返回列表时，本会话已经算过的图不该再等一次网络，
 * 卡片拿到就立刻渲染，翻页、翻回都感觉是瞬时的。
 */
export function peekThumb(id: string): string | null {
    return memThumbs.get(id)?.url ?? null;
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
    const memHit = memThumbs.get(id);
    if (memHit && (sig === 0 || memHit.sig === sig)) return memHit.url;

    const running = inflight.get(id);
    if (running) return running;

    const task = (async (): Promise<string | null> => {
        await warm();
        const memNow = memThumbs.get(id);
        if (memNow && (sig === 0 || memNow.sig === sig)) return memNow.url;
        const cached = await readThumb(id, sig || undefined);
        if (cached) {
            memThumbs.set(id, { url: cached, sig });
            return cached;
        }
        await acquire();
        try {
            const detail = await fetcher();
            const raw = detail?.originalImageUrl;
            if (!raw) return null;
            const thumb = await makeThumb(raw);
            memThumbs.set(id, { url: thumb, sig });
            scheduleWrite({ id, url: thumb, sig, at: Date.now() });
            return thumb;
        } catch {
            return null;
        } finally {
            release();
        }
    })();

    inflight.set(id, task);
    try {
        return await task;
    } finally {
        inflight.delete(id);
    }
}

/**
 * 高清原图（放大查看用）。
 *
 * 卡片里的缩略图只有 480px 宽，铺满手机屏幕时要铺到 1000+ 物理像素，
 * 放大后必然发虚 —— 用户看到的"放大不清晰"就是这么来的。
 * 放大层必须换回原始图片（拍照压到 1920px、质量 0.88，够清楚）。
 *
 * 原图是 base64 大字符串（几百 KB），不可能全库驻内存，
 * 这里只保留最近放大的 4 张（LRU），且**不写 IndexedDB**：
 * 缓存是为了少走一次网络，不是为了跨会话持久化。
 */
const FULL_MEM_MAX = 4;
const fullMem = new Map<string, string>();
const fullInflight = new Map<string, Promise<string | null>>();

/** 同步窥一眼内存里已取过的高清图（放大层先渲染，避免二次请求闪白） */
export function peekFullImage(id: string): string | null {
    const hit = fullMem.get(id);
    if (!hit) return null;
    // 重新插到队尾，保持"最近用过"的顺序
    fullMem.delete(id);
    fullMem.set(id, hit);
    return hit;
}

function rememberFull(id: string, url: string): void {
    fullMem.delete(id);
    fullMem.set(id, url);
    while (fullMem.size > FULL_MEM_MAX) {
        const oldest = fullMem.keys().next().value;
        if (oldest === undefined) break;
        fullMem.delete(oldest);
    }
}

/** 取一张卡的高清原图；没有原图返回 null。并发调用会合并成一次请求。 */
export async function ensureFullImage(
    id: string,
    fetcher: () => Promise<{ originalImageUrl?: string } | null>,
): Promise<string | null> {
    const hit = peekFullImage(id);
    if (hit) return hit;

    const running = fullInflight.get(id);
    if (running) return running;

    const task = (async (): Promise<string | null> => {
        try {
            const detail = await fetcher();
            const raw = detail?.originalImageUrl || "";
            if (!raw) return null;
            rememberFull(id, raw);
            return raw;
        } catch {
            return null;
        }
    })();

    fullInflight.set(id, task);
    try {
        return await task;
    } finally {
        fullInflight.delete(id);
    }
}
