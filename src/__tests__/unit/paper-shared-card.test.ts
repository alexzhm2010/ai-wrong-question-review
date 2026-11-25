import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("试卷题目卡片：扫码批卷与练习试卷查看共用同一组件", () => {
    const card = read("src/components/paper-question-card.tsx");
    const view = read("src/app/paper-view/page.tsx");
    const mark = read("src/app/mark/page.tsx");

    it("共享组件统一呈现题号、短码、判定标签、题图、参考答案", () => {
        expect(card).toContain("export function PaperQuestionCard");
        expect(card).toContain("第 {index + 1} 题");
        expect(card).toContain("item.shortCode");
        expect(card).toContain("imageSrc(item.imageUrl)");
        expect(card).toContain("item.questionText");
        expect(card).toContain("参考答案");
        expect(card).toContain("<ReferenceAnswer");
        expect(card).toContain("{children}");
    });

    it("查看页复用共享卡片，不再内联题目卡片样式", () => {
        expect(view).toContain('from "@/components/paper-question-card"');
        expect(view).toContain("<PaperQuestionCard");
        // 不应再各自复制卡片结构
        expect(view).not.toContain('className="rounded-xl border bg-white p-3 space-y-2.5"');
        expect(view).not.toContain("<ReferenceAnswer");
    });

    it("批改页复用共享卡片，并把判定按钮作为 children 注入", () => {
        expect(mark).toContain('from "@/components/paper-question-card"');
        expect(mark).toContain("<PaperQuestionCard");
        expect(mark).toContain("verdict={chosen}");
        // 批改页仍有判定按钮与提交（核心批改能力不丢）
        expect(mark).toContain('"/api/paper/submit"');
        expect(mark).toContain("提交批改");
        expect(mark).toContain("PAPERS_HOME"); // 批改中心已并入练习试卷，出口回 /papers
        // 不应再各自复制卡片结构/参考答案区
        expect(mark).not.toContain('className="rounded-xl border bg-white p-3 space-y-2.5"');
        expect(mark).not.toContain("<ReferenceAnswer");
    });

    it("两页都不残留重复的 PaperItem 类型定义，改用共享类型", () => {
        expect(view).not.toContain("type PaperItem = {");
        expect(mark).not.toContain("type PaperItem = {");
        expect(card).toContain("export type PaperQuestionItem");
    });
});
