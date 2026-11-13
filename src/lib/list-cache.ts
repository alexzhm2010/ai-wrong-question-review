/**
 * 列表「回访缓存」：从题目卡片进详情、编辑完再返回时，列表不应该重来一遍。
 *
 * 现状问题（v1.18.40）：
 *   `/notebook?id=x` 与 `/item?id=y` 是两个独立页面，返回即重新挂载，
 *   于是重新拉一次列表、闪一次骨架屏、滚动条回到顶部——用户还得自己再找那道题。
 *
 * 这里做四件事，全部是纯前端、零后端改动：
 *   1. 快照：按「科目 + 筛选条件 + 页码」缓存列表数据和总数；
 *   2. 滚动：记住离开时的 scrollY，回来第一帧就还原；
 *   3. 焦点：记住刚点开的那道题，回来后高亮 2 秒并在视口内居中；
 *   4. 来源：记住详情页是从哪个列表进来的，返回时优先 back（不新增历史）。
 *
 * 内存优先、sessionStorage 兜底：同一次导航必然命中内存；整页刷新后还能命中 session。
 */

export interface ListSnapshot<T> {
    items: T[];
    total: number;
    totalPages: number;
    page: number;
    /** 写入时间戳，用于判过期 */
    at: number;
}

/** 内存只留最近几份，避免长会话里堆着一堆旧筛选结果 */
const MAX_ENTRIES = 8;
const mem = new Map<string, ListSnapshot<unknown>>();

const NS = "wq:list:v1";
/** 超过这个时间的快照不再用于「秒开」，但仍会立刻发起刷新 */
const STALE_MS = 30 * 60 * 1000;

function storage(): Storage | null {
    try {
        if (typeof window === "undefined") return null;
        return window.sessionStorage;
    } catch {
        return null;
    }
}

/** 筛选条件 → 稳定字符串（键排序，保证同样条件总得到同样的键） */
function fingerprint(filters: Record<string, unknown>): string {
    return Object.keys(filters)
        .sort()
        .map((k) => {
            const v = filters[k];
            return `${k}=${v === null || v === undefined ? "" : String(v)}`;
        })
        .join("&");
}

export function listCacheKey(scope: string, filters: Record<string, unknown>, page: number): string {
    return `${scope}|${page}|${fingerprint(filters)}`;
}

function memPut(key: string, snap: ListSnapshot<unknown>): void {
    mem.delete(key);
    mem.set(key, snap);
    while (mem.size > MAX_ENTRIES) {
        const oldest = mem.keys().next().value;
        if (!oldest) break;
        mem.delete(oldest);
    }
}

export function readListSnapshot<T>(key: string): ListSnapshot<T> | null {
    const hit = mem.get(key) as ListSnapshot<T> | undefined;
    if (hit) return hit;
    const st = storage();
    if (!st) return null;
    try {
        const raw = st.getItem(`${NS}:snap:${key}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ListSnapshot<T>;
        if (!parsed || !Array.isArray(parsed.items)) return null;
        memPut(key, parsed as ListSnapshot<unknown>);
        return parsed;
    } catch {
        return null;
    }
}

export function isFreshSnapshot(snap: ListSnapshot<unknown> | null): boolean {
    return !!snap && Date.now() - Number(snap.at || 0) < STALE_MS;
}

export function writeListSnapshot<T>(key: string, snap: Omit<ListSnapshot<T>, "at">): void {
    const full: ListSnapshot<T> = { ...snap, at: Date.now() };
    memPut(key, full as ListSnapshot<unknown>);
    const st = storage();
    if (!st) return;
    try {
        st.setItem(`${NS}:snap:${key}`, JSON.stringify(full));
    } catch {
        // 配额满（题目正文很长时会遇到）就只留内存，下次进详情仍能秒开
    }
}

/**
 * 在详情页改完题干/知识点/掌握度之后，把新值回写到所有列表快照里。
 *
 * 比起「一改就清空缓存」：返回列表时依然是秒开，但看到的是刚编辑过的内容，
 * 不会出现「回去还是旧标题」的错觉。
 */
export function patchListSnapshots(id: string, patch: Record<string, unknown>): void {
    const apply = (snap: ListSnapshot<unknown>): ListSnapshot<unknown> => {
        const items = snap.items as Array<Record<string, unknown>>;
        if (!Array.isArray(items)) return snap;
        let touched = false;
        const next = items.map((it) => {
            if (String(it?.id) !== id) return it;
            touched = true;
            return { ...it, ...patch };
        });
        return touched ? { ...snap, items: next } : snap;
    };

    for (const [k, snap] of mem.entries()) {
        mem.set(k, apply(snap));
    }

    const st = storage();
    if (!st) return;
    try {
        for (let i = 0; i < st.length; i++) {
            const k = st.key(i);
            if (!k || !k.startsWith(`${NS}:snap:`)) continue;
            const raw = st.getItem(k);
            if (!raw) continue;
            const parsed = JSON.parse(raw) as ListSnapshot<unknown>;
            const next = apply(parsed);
            if (next !== parsed) st.setItem(k, JSON.stringify(next));
        }
    } catch {
        /* 结构对不上就算了，下次进列表会重新拉 */
    }
}

/** 增删改之后调用：任何快照都不再可信 */
export function invalidateListSnapshots(): void {    mem.clear();
    const st = storage();
    if (!st) return;
    try {
        const drop: string[] = [];
        for (let i = 0; i < st.length; i++) {
            const k = st.key(i);
            if (k && k.startsWith(`${NS}:snap:`)) drop.push(k);
        }
        drop.forEach((k) => st.removeItem(k));
    } catch {
        /* 读不到就算了 */
    }
}

// ── 列表状态（页码 + 筛选） ─────────────────────────────
export interface ListState {
    page: number;
    search: string;
    mastery: string;
    time: string;
    /** 做题情况（错 2 次以上 / 从没做对 / 连续对 ≥2） */
    practice?: string;
    tag: string | null;
    grade: string;
    chapter: string;
}

/**
 * 页码和筛选也要记住。
 *
 * 否则：在第 2 页点了第 25 道题，返回后 list 组件重新挂载、page 回到 1，
 * 用户看到的是第 1 页——比「刷新」更让人抓狂。
 */
export function saveListState(scope: string, state: ListState): void {
    const st = storage();
    if (!st) return;
    try {
        st.setItem(`${NS}:state:${scope}`, JSON.stringify({ ...state, at: Date.now() }));
    } catch {
        /* 忽略 */
    }
}

export function readListState(scope: string): ListState | null {
    const st = storage();
    if (!st) return null;
    try {
        const raw = st.getItem(`${NS}:state:${scope}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ListState & { at?: number };
        if (!parsed || Date.now() - Number(parsed.at || 0) > STALE_MS) return null;
        return parsed;
    } catch {
        return null;
    }
}

// ── 滚动位置 ─────────────────────────────────────────────
export function saveScrollPos(scope: string, y: number): void {
    const st = storage();
    if (!st) return;
    try {
        st.setItem(`${NS}:scroll:${scope}`, String(Math.max(0, Math.round(y))));
    } catch {
        /* 忽略 */
    }
}

/** 读回滚动位置；超过 30 分钟的旧位置不再使用（页面内容可能早变了） */
export function readScrollPos(scope: string): number {
    const st = storage();
    if (!st) return 0;
    try {
        const raw = st.getItem(`${NS}:scroll:${scope}`);
        if (!raw) return 0;
        const y = Number(raw);
        if (!Number.isFinite(y) || y < 0 || y > 60000) return 0;
        return y;
    } catch {
        return 0;
    }
}

// ── 返回焦点 ─────────────────────────────────────────────
/** 点开某道题时打标，返回列表后用来高亮 */
export function markReturnFocus(id: string): void {
    const st = storage();
    if (!st) return;
    try {
        st.setItem(`${NS}:focus`, id);
    } catch {
        /* 忽略 */
    }
}

/** 读一次就清掉，避免下次正常进列表也莫名高亮 */
export function consumeReturnFocus(): string | null {
    const st = storage();
    if (!st) return null;
    try {
        const id = st.getItem(`${NS}:focus`);
        if (id) st.removeItem(`${NS}:focus`);
        return id;
    } catch {
        return null;
    }
}

// ── 导航来源 ─────────────────────────────────────────────
export function markListOrigin(url: string): void {
    const st = storage();
    if (!st) return;
    try {
        st.setItem(`${NS}:origin`, url);
    } catch {
        /* 忽略 */
    }
}

export function readListOrigin(): string | null {
    const st = storage();
    if (!st) return null;
    try {
        return st.getItem(`${NS}:origin`);
    } catch {
        return null;
    }
}
