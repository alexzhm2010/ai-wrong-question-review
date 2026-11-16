/**
 * 批改目标题来源解析回归：
 * 从「我的 → 拍照批改」进 /scan 时没有 ?ids=，必须回退到上次打印，
 * 否则 items 为空会把每个题号都误判成「库里没有这个号」。
 */
import { describe, it, expect } from "vitest";
import { resolveScanIds, readLastPrintIds } from "@/lib/resolve-scan-ids";

function storageWith(value: string | null) {
    return { getItem: () => value };
}

describe("resolveScanIds", () => {
    it("URL 的 ids 优先，且标记不是来自上次打印", () => {
        const r = resolveScanIds("a,b,c", storageWith(JSON.stringify({ ids: ["x", "y"] })));
        expect(r.ids).toEqual(["a", "b", "c"]);
        expect(r.fromLastPrint).toBe(false);
    });

    it("URL 无 ids 时回退到上次打印记录", () => {
        const r = resolveScanIds("", storageWith(JSON.stringify({ ids: ["x", "y"] })));
        expect(r.ids).toEqual(["x", "y"]);
        expect(r.fromLastPrint).toBe(true);
    });

    it("URL 带空格等脏字符时正确清洗", () => {
        const r = resolveScanIds(" a , b ,,c ", null);
        expect(r.ids).toEqual(["a", "b", "c"]);
    });

    it("既无 URL 也无打印记录时返回空，标记来自上次打印", () => {
        const r = resolveScanIds(null, storageWith(null));
        expect(r.ids).toEqual([]);
        expect(r.fromLastPrint).toBe(true);
    });

    it("打印记录损坏时安全返回空", () => {
        const r = resolveScanIds("", storageWith("not-json"));
        expect(r.ids).toEqual([]);
    });

    it("打印记录 ids 非数组时返回空", () => {
        const r = resolveScanIds("", storageWith(JSON.stringify({ ids: "oops" })));
        expect(r.ids).toEqual([]);
    });
});

describe("readLastPrintIds", () => {
    it("storage 为空时返回空数组", () => {
        expect(readLastPrintIds(null)).toEqual([]);
    });

    it("过滤掉空 id 并转成字符串", () => {
        const s = storageWith(JSON.stringify({ ids: ["a", "", null, 42] }));
        expect(readLastPrintIds(s)).toEqual(["a", "42"]);
    });
});
