import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
    consumeReturnFocus,
    invalidateListSnapshots,
    listCacheKey,
    markReturnFocus,
    patchListSnapshots,
    readListSnapshot,
    readListState,
    readScrollPos,
    saveListState,
    saveScrollPos,
    writeListSnapshot,
} from "@/lib/list-cache";

const filters = { search: "", mastery: "all", time: "all", tag: null, grade: "", chapter: "" };

beforeEach(() => {
    invalidateListSnapshots();
    try {
        window.sessionStorage.clear();
    } catch {
        /* 忽略 */
    }
});

describe("listCacheKey", () => {
    it("筛选条件顺序无关，结果一致", () => {
        const a = listCacheKey("s1", { b: 1, a: 2 }, 1);
        const b = listCacheKey("s1", { a: 2, b: 1 }, 1);
        expect(a).toBe(b);
    });

    it("页码、科目、任一筛选不同都会换 key", () => {
        const base = listCacheKey("s1", filters, 1);
        expect(listCacheKey("s1", filters, 2)).not.toBe(base);
        expect(listCacheKey("s2", filters, 1)).not.toBe(base);
        expect(listCacheKey("s1", { ...filters, search: "函数" }, 1)).not.toBe(base);
    });

    it("null 与空串等价（清除筛选不该多存一份）", () => {
        expect(listCacheKey("s1", { ...filters, tag: null }, 1)).toBe(
            listCacheKey("s1", { ...filters, tag: "" }, 1),
        );
    });
});

describe("列表快照读写", () => {
    it("写入后能读回同样的数据", () => {
        const key = listCacheKey("unit-read", filters, 1);
        writeListSnapshot(key, { items: [{ id: "a" }, { id: "b" }], total: 2, totalPages: 1, page: 1 });
        const snap = readListSnapshot<{ id: string }>(key);
        expect(snap?.items.map((i) => i.id)).toEqual(["a", "b"]);
        expect(snap?.total).toBe(2);
    });

    it("没写过的 key 返回 null", () => {
        expect(readListSnapshot("unit-none|1|")).toBeNull();
    });

    it("清空后读不到（增删改必须让缓存失效）", () => {
        const key = listCacheKey("unit-clear", filters, 1);
        writeListSnapshot(key, { items: [{ id: "a" }], total: 1, totalPages: 1, page: 1 });
        invalidateListSnapshots();
        expect(readListSnapshot(key)).toBeNull();
    });
});

describe("patchListSnapshots：编辑后回写", () => {
    it("只改命中 id 的那一条，其余原样", () => {
        const key = listCacheKey("unit-patch", filters, 1);
        writeListSnapshot(key, {
            items: [
                { id: "a", questionText: "旧题干" },
                { id: "b", questionText: "别人的题" },
            ],
            total: 2,
            totalPages: 1,
            page: 1,
        });

        patchListSnapshots("a", { questionText: "新题干" });

        const snap = readListSnapshot<{ id: string; questionText: string }>(key);
        expect(snap?.items[0].questionText).toBe("新题干");
        expect(snap?.items[1].questionText).toBe("别人的题");
    });

    it("id 不存在时不动任何数据", () => {
        const key = listCacheKey("unit-patch-miss", filters, 1);
        writeListSnapshot(key, { items: [{ id: "a" }], total: 1, totalPages: 1, page: 1 });
        patchListSnapshots("zzz", { questionText: "x" });
        const snap = readListSnapshot<{ id: string; questionText?: string }>(key);
        expect(snap?.items[0].questionText).toBeUndefined();
    });
});

describe("滚动位置", () => {
    it("存进去能读回来", () => {
        saveScrollPos("unit-scroll", 1234);
        expect(readScrollPos("unit-scroll")).toBe(1234);
    });

    it("负数与异常大值当作 0", () => {
        saveScrollPos("unit-scroll-neg", -50);
        expect(readScrollPos("unit-scroll-neg")).toBe(0);
        saveScrollPos("unit-scroll-huge", 999999);
        expect(readScrollPos("unit-scroll-huge")).toBe(0);
    });

    it("没存过返回 0", () => {
        expect(readScrollPos("unit-scroll-none")).toBe(0);
    });
});

describe("返回焦点", () => {
    it("读一次就清掉", () => {
        markReturnFocus("item-1");
        expect(consumeReturnFocus()).toBe("item-1");
        expect(consumeReturnFocus()).toBeNull();
    });
});


describe("列表状态（页码 + 筛选）", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("页码与筛选能原样读回", () => {
        saveListState("unit-state", {
            page: 3,
            search: "函数",
            mastery: "unmastered",
            time: "week",
            tag: "二次函数",
            grade: "初二上",
            chapter: "第一章",
        });
        const got = readListState("unit-state");
        expect(got?.page).toBe(3);
        expect(got?.mastery).toBe("unmastered");
        expect(got?.tag).toBe("二次函数");
    });

    it("没存过返回 null", () => {
        expect(readListState("unit-state-none")).toBeNull();
    });

    it("超过 30 分钟不再沿用（避免很久以后还带着旧筛选）", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
        saveListState("unit-state-old", {
            page: 2,
            search: "",
            mastery: "all",
            time: "all",
            tag: null,
            grade: "",
            chapter: "",
        });
        vi.setSystemTime(new Date("2026-01-01T11:00:00Z"));
        expect(readListState("unit-state-old")).toBeNull();
    });
});
