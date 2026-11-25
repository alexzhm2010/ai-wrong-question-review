import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("卷首布局：试卷编号居中大字 + 二维码靠右", () => {
    const comp = read("src/components/paper-qr-code.tsx");
    const page = read("src/app/print-preview/page.tsx");

    it("二维码留在文档流撑高度，编号在容器内绝对居中，文字不压分隔线", () => {
        expect(comp).toContain("wq-paper-header relative");
        // 二维码块在文档流里靠右（flex justify-end），负责撑起容器高度
        expect(comp).toContain('<div className="flex justify-end">');
        // 编号相对整个容器绝对居中，两侧留白避开二维码
        expect(comp).toContain("absolute inset-0 flex items-center justify-center px-20 text-center");
        // 二维码不再用 absolute 脱离文档流（否则文字压分隔线）
        expect(comp).not.toContain("absolute right-0 top-0");
    });

    it("卷首容器底部有内边距，保证「扫码批改」文字与分隔线有间距", () => {
        expect(comp).toContain("border-b border-slate-300 pb-2 print:border-b print:border-slate-400 print:pb-2");
    });

    it("试卷编号用明显更大的字号（屏幕 xl / 打印 18pt）", () => {
        expect(comp).toContain("text-xl font-bold tracking-wider text-black print:text-[18pt]");
        // 旧的小字已移除
        expect(comp).not.toContain("font-mono text-[10px] tracking-tight");
    });

    it("二维码尺寸缩小以节省纸张纵向空间", () => {
        expect(comp).toContain("print:[&>svg]:h-[20mm] print:[&>svg]:w-[20mm]");
        expect(comp).not.toContain("print:[&>svg]:h-[22mm]");
    });

    it("卷首条从 space-y-8 中独立出来，与第一题只用紧凑间距", () => {
        // paperCode 时题目容器用 mt-4（打印 mt-3），避免被 space-y-8 推远
        expect(page).toContain('paperCode ? "mt-4 space-y-8 print:mt-3" : "space-y-8"');
        // PaperQrCode 在题目容器之前单独渲染
        const headerIdx = page.indexOf("<PaperQrCode");
        const itemsIdx = page.indexOf("{orderedItems.map(");
        expect(headerIdx).toBeGreaterThan(-1);
        expect(itemsIdx).toBeGreaterThan(headerIdx);
    });
});
