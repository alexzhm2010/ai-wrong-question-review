import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("今日复习卷：卷首二维码凭证不能丢", () => {
    const page = read("src/app/review/page.tsx");

    it("出卷成功后把 code/paperNo 一起持久化，供继续打印复用", () => {
        // 出卷走公共服务 createPaper，与错题本共用一套逻辑
        expect(page).toContain("createPaper(ids");
        // 今日卷对象里带凭证字段
        expect(page).toMatch(/code\?: string;/);
        expect(page).toMatch(/paperNo\?: string;/);
        // 写入 localStorage 时带上凭证
        expect(page).toMatch(/date: todayKey\(\), ids, code, paperNo, at/);
    });

    it("生成今日卷用整页导航 + printPreviewHref，不再用客户端 router.push 丢 query", () => {
        expect(page).toContain("hardNavigate(printPreviewHref(ids, code, paperNo))");
        expect(page).not.toContain("router.push");
        expect(page).not.toContain("useRouter");
    });

    it("继续打印那份带凭证跳转，且老数据无凭证时现场补出卷", () => {
        // 继续打印走 reprintToday，内部用 printPreviewHref 带 code
        expect(page).toContain("const reprintToday = async () =>");
        expect(page).toContain("hardNavigate(printPreviewHref(ids, code, paperNo))");
        // 无凭证时补出卷，同样走公共服务
        expect(page).toContain('if (!code) {');
        expect(page).toContain('createPaper(ids, [], "")');
    });

    it("读取旧版今日卷数据时把缺失的凭证补成空串，兼容老结构", () => {
        expect(page).toContain('typeof paper.code === "string" ? paper.code : ""');
        expect(page).toContain('typeof paper.paperNo === "string" ? paper.paperNo : ""');
    });
});

describe("打印页：二维码区块由 paper 参数驱动", () => {
    const page = read("src/app/print-preview/page.tsx");

    it("paper 参数非空才渲染卷首二维码组件", () => {
        expect(page).toContain('searchParams?.get("paper") || ""');
        expect(page).toContain("{paperCode && (");
        expect(page).toContain("<PaperQrCode");
    });

    it("答案区不再被 paper 凭证强制屏蔽，勾了附答案就显示", () => {
        const answerGate = page.slice(
            page.indexOf("答案区：统一放卷末"),
            page.indexOf("<section", page.indexOf("答案区：统一放卷末")),
        );
        expect(answerGate).not.toContain("!paperCode");
        // 区块存在只由附答案/附解析勾选 + 有题决定
        expect(page).toContain("(showAnswers || showAnalysis) && total > 0 && (");
    });
});
