import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorItemDetailHref, isPaperBackPath } from "@/lib/paper-archive";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("试卷题目 -> 错题本详细解析：跳转地址", () => {
    it("errorItemDetailHref 带题目 id、from=paper 与来源试卷 back", () => {
        const href = errorItemDetailHref("EID123", "/mark?c=ABC&from=papers");
        expect(href).toContain("id=EID123");
        expect(href).toContain("from=paper");
        // back 整段被编码进 query，解码后仍是完整的来源试卷地址
        expect(decodeURIComponent(href)).toContain("back=/mark?c=ABC&from=papers");
    });

    it("题目 id 含特殊字符正确编码，无来源时不产生空 back", () => {
        const href = errorItemDetailHref("a b&c", "");
        expect(href).toContain("id=a+b%26c");
        expect(href).not.toContain("back=");
    });

    it("isPaperBackPath 只放行练习试卷相关站内路径，防开放重定向", () => {
        expect(isPaperBackPath("/papers")).toBe(true);
        expect(isPaperBackPath("/paper-view?c=ABC")).toBe(true);
        expect(isPaperBackPath("/mark?c=ABC&from=papers")).toBe(true);
        // 错题本列表、协议相对地址、绝对外链、空值一律拒绝
        expect(isPaperBackPath("/notebook?id=x")).toBe(false);
        expect(isPaperBackPath("//evil.com/x")).toBe(false);
        expect(isPaperBackPath("https://evil.com")).toBe(false);
        expect(isPaperBackPath(null)).toBe(false);
        expect(isPaperBackPath("")).toBe(false);
    });
});

describe("试卷题目 -> 错题本详细解析：页面接线", () => {
    const card = read("src/components/paper-question-card.tsx");
    const view = read("src/app/paper-view/page.tsx");
    const mark = read("src/app/mark/page.tsx");
    const item = read("src/app/item/page.tsx");

    it("共享卡片：题目内容区可点击整页跳转，判定按钮在可点击区之外", () => {
        expect(card).toContain("detailHref");
        expect(card).toContain("hardNavigate(detailHref)");
        expect(card).toContain('role={detailHref ? "button" : undefined}');
        expect(card).toContain("onKeyDown");
        expect(card).toContain("点击查看该题完整解析与错因");
        // children（批改页判定按钮）渲染在 onClick 容器之后，即容器之外
        expect(card.indexOf("{children}")).toBeGreaterThan(card.indexOf("onClick={openDetail}"));
    });

    it("查看页与批改页都给每张题目卡片传入详情地址，且回各自的来源页", () => {
        expect(view).toContain("errorItemDetailHref");
        expect(view).toContain("detailHref={errorItemDetailHref(");
        expect(view).toContain("/paper-view?c=${encodeURIComponent(code)}");
        expect(mark).toContain("errorItemDetailHref");
        expect(mark).toContain("detailHref={errorItemDetailHref(");
        expect(mark).toContain("/mark?c=${encodeURIComponent(code)}");
    });

    it("错题详情页识别 from=paper：返回来源试卷、标题改为题目解析", () => {
        expect(item).toContain('q.get("from") === "paper"');
        expect(item).toContain("isPaperBackPath(back)");
        expect(item).toContain("hardNavigate(");
        expect(item).toContain('title={fromPaper ? "返回试卷" : "返回错题本"}');
        expect(item).toContain('fromPaper ? "题目解析" : t.detail.title');
    });

    it("加载失败且来自试卷时回来源试卷，不再误跳错题本列表", () => {
        expect(item).toContain("Failed to load item");
        // catch 分支里先判断 from=paper
        const catchIdx = item.indexOf("Failed to load item");
        const paperIdx = item.indexOf('q.get("from") === "paper"', catchIdx);
        expect(paperIdx).toBeGreaterThan(catchIdx);
    });
});
