import { describe, expect, it } from "vitest";
import {
    hasImageRef,
    isBareBase64,
    parseRemoteRef,
    refToSrc,
    sniffMime,
    stripDataUrl,
    toDataUrl,
} from "@/lib/storage/ref";
import { inlineDriver } from "@/lib/storage/driver";

/** 够长的假 base64：JPEG 的真实开头是 /9j/，专门用来验证不会被当成路径 */
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD" + "A".repeat(400);
const PNG = "iVBORw0KGgoAAAANSUhEUg" + "B".repeat(400);
const DATA_URL = `data:image/jpeg;base64,${JPEG}`;

describe("图片引用识别", () => {
    it("data URL 原样透出", () => {
        expect(refToSrc(DATA_URL)).toBe(DATA_URL);
    });

    it("裸 base64 补成 data URL", () => {
        expect(refToSrc(JPEG)).toBe(`data:image/jpeg;base64,${JPEG}`);
        expect(refToSrc(PNG).startsWith("data:image/png;base64,")).toBe(true);
    });

    it("以 /9j/ 开头的 JPEG base64 不会被误判成站点内路径", () => {
        expect(refToSrc(JPEG).startsWith("data:image/jpeg")).toBe(true);
        // 真正的站点路径仍然原样返回
        expect(refToSrc("/images/a.jpg")).toBe("/images/a.jpg");
    });

    it("http 与 blob 地址原样返回", () => {
        expect(refToSrc("https://img.example.com/a.jpg")).toBe("https://img.example.com/a.jpg");
        expect(refToSrc("blob:http://localhost/x")).toBe("blob:http://localhost/x");
    });

    it("对象存储引用按 CDN 前缀拼接", () => {
        const ref = "r2://wq-images/question/20261114/a-1.jpg";
        expect(refToSrc(ref, { cdnBase: "https://img.example.com/" })).toBe(
            "https://img.example.com/question/20261114/a-1.jpg",
        );
        // 没配前缀时不能瞎拼，宁可原样吐出来
        expect(refToSrc(ref)).toBe(ref);
    });

    it("空引用返回空串，不渲染破图", () => {
        expect(refToSrc("")).toBe("");
        expect(refToSrc(null)).toBe("");
        expect(refToSrc(undefined)).toBe("");
        expect(refToSrc("   ")).toBe("");
    });
});

describe("对象存储引用解析", () => {
    it("拆出 bucket 与 key", () => {
        expect(parseRemoteRef("r2://bucket/a/b.jpg")).toEqual({
            scheme: "r2",
            bucket: "bucket",
            key: "a/b.jpg",
        });
    });

    it("非对象存储或格式不全时返回 null", () => {
        expect(parseRemoteRef("https://x/a.jpg")).toBeNull();
        expect(parseRemoteRef("r2://bucket")).toBeNull();
        expect(parseRemoteRef("r2:///key")).toBeNull();
    });
});

describe("有没有图", () => {
    it("真实引用算有图", () => {
        expect(hasImageRef(DATA_URL)).toBe(true);
        expect(hasImageRef(JPEG)).toBe(true);
        expect(hasImageRef("r2://bucket/a.jpg")).toBe(true);
        expect(hasImageRef("https://img.example.com/a.jpg")).toBe(true);
    });

    it("空串、占位符、非字符串都不算", () => {
        expect(hasImageRef("")).toBe(false);
        expect(hasImageRef("   ")).toBe(false);
        expect(hasImageRef("none")).toBe(false);
        expect(hasImageRef(null)).toBe(false);
        expect(hasImageRef(undefined)).toBe(false);
        expect(hasImageRef(123)).toBe(false);
    });

    it("短串不会被当成裸 base64", () => {
        expect(isBareBase64("abcd")).toBe(false);
        expect(isBareBase64(JPEG)).toBe(true);
    });
});

describe("格式转换", () => {
    it("按魔数判断 MIME", () => {
        expect(sniffMime(JPEG)).toBe("image/jpeg");
        expect(sniffMime(PNG)).toBe("image/png");
        expect(sniffMime("R0lGODlhAQABAAAAACw=")).toBe("image/gif");
        expect(sniffMime("UklGRhIAAABXRUJQVlA4=")).toBe("image/webp");
    });

    it("data URL 与裸 base64 之间互转", () => {
        expect(stripDataUrl(DATA_URL)).toBe(JPEG);
        expect(toDataUrl(JPEG)).toBe(DATA_URL);
        expect(toDataUrl(DATA_URL)).toBe(DATA_URL);
    });

    it("二进制串不会被 toDataUrl 收下", () => {
        expect(toDataUrl("not-an-image")).toBe("");
    });
});

describe("inline 驱动", () => {
    it("原样返回引用，等价于存库的 data URL", async () => {
        expect(await inlineDriver.put({ dataUrl: DATA_URL, role: "question" })).toBe(DATA_URL);
    });

    it("裸 base64 进来会补成 data URL，库里不出现两种格式", async () => {
        expect(await inlineDriver.put({ dataUrl: JPEG, role: "draft" })).toBe(DATA_URL);
    });

    it("删除是空实现，不抛错", async () => {
        await expect(inlineDriver.remove([DATA_URL])).resolves.toBeUndefined();
    });
});
