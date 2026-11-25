import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSubmitted } from "@/lib/paper-archive";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("已批改试卷只读锁定：判定依据", () => {
    it("复用 isSubmitted 作为锁定依据：提交过即锁定（含 0 分）", () => {
        expect(isSubmitted({ score: 72, submittedAt: "2026-11-21" })).toBe(true);
        expect(isSubmitted({ score: 0, submittedAt: "2026-11-21" })).toBe(true);
        expect(isSubmitted({ score: null, submittedAt: null })).toBe(false);
        expect(isSubmitted({})).toBe(false);
    });
});

describe("已批改试卷只读锁定：批改页接线", () => {
    const mark = read("src/app/mark/page.tsx");

    it("批改页引入 isSubmitted 并据 paper 计算 locked", () => {
        expect(mark).toContain("errorItemDetailHref, isSubmitted");
        expect(mark).toContain("const locked = !!paper && isSubmitted(paper)");
    });

    it("判定按钮在锁定时禁用，且 pick/submit 有两道护栏", () => {
        expect(mark).toContain("disabled={locked}");
        expect(mark).toContain("if (locked) return;");
        expect(mark).toContain("if (locked || !allJudged || submitting || !paper) return;");
    });

    it("已批改时底部隐去提交按钮，改为只读返回条", () => {
        // 从底部栏注释开始截取，锁定分支是返回按钮，提交按钮只在 else 分支
        const barIdx = mark.indexOf("底部栏：已批改卷只读");
        expect(barIdx).toBeGreaterThan(-1);
        const bar = mark.slice(barIdx);
        const elseIdx = bar.indexOf(") : (");
        expect(elseIdx).toBeGreaterThan(-1);
        const lockedBranch = bar.slice(0, elseIdx);
        const editableBranch = bar.slice(elseIdx);
        expect(lockedBranch).toContain("onClick={backToCenter}");
        expect(lockedBranch).not.toContain("onClick={submit}");
        expect(editableBranch).toContain("onClick={submit}");
    });

    it("锁定状态有明确只读提示与徽章", () => {
        expect(mark).toContain("批改结果已锁定，不能再修改");
        expect(mark).toContain("已批改 · 只读");
        expect(mark).toContain('locked ? "bg-emerald-50 text-emerald-700"');
    });

    it("结果层文案随锁定切换，不误导为可重新批改", () => {
        expect(mark).toContain('stayLabel={locked ? "留在本页查看试卷" : "留在本页重新批改"}');
        expect(mark).toContain("stayLabel?: string");
    });
});

describe("我的页管理工具不再暴露练习试卷入口", () => {
    it("SHORTCUTS 中已无 /papers 项，也不再引入 ScanLine 图标", () => {
        const me = read("src/app/me/page.tsx");
        expect(me).not.toContain('href: "/papers"');
        expect(me).not.toContain("ScanLine");
        // 其余管理工具仍在
        expect(me).toContain('href: "/tags"');
        expect(me).toContain('href: "/stats"');
        expect(me).toContain('href: "/batch"');
    });
});
