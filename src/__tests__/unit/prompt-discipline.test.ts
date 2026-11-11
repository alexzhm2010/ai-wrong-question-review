import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    DEFAULT_ANALYZE_TEMPLATE,
    DEFAULT_REANSWER_TEMPLATE,
} from "@/lib/ai/prompts";

const templates = [DEFAULT_ANALYZE_TEMPLATE, DEFAULT_REANSWER_TEMPLATE];

describe("解析行文纪律（收敛自我复盘口吻）", () => {
    it("前端副本与线上 Edge Function 副本完全一致，避免设置页默认值回退到旧模板", () => {
        const edge = readFileSync(
            resolve(process.cwd(), "supabase/functions/ai-proxy/lib/prompts.ts"),
            "utf-8",
        );
        const front = readFileSync(
            resolve(process.cwd(), "src/lib/ai/prompts.ts"),
            "utf-8",
        );
        expect(edge).toBe(front);
    });

    it("要求按「前提 → 推导 → 边界核验 → 结论」一次成型", () => {
        templates.forEach((tpl) => {
            expect(tpl).toContain("【解析行文结构 (ANALYSIS STRUCTURE)】");
            expect(tpl).toContain("边界核验");
            expect(tpl).toContain("普通推导步骤");
            expect(tpl).toContain("自问自答");
        });
    });

    it("明确禁用截图里出现过的口语化转折引导句", () => {
        const banned = [
            "等等",
            "这里有个关键遗漏",
            "但注意！",
            "但还需验证",
            "再仔细看",
            "之前得到",
            "严禁口语化的自我复盘",
        ];
        templates.forEach((tpl) => {
            banned.forEach((kw) => expect(tpl).toContain(kw));
        });
    });

    it("自检改为静默完成，但保留复核与纠错能力，不固化错误答案", () => {
        templates.forEach((tpl) => {
            expect(tpl).toContain("静默自检");
            expect(tpl).toContain("自检只做一次，通过后即锁定结论");
            expect(tpl).toContain("若推导中发现前面判断有误");
            expect(tpl).toContain("静默改到正确路径");
            expect(tpl).toContain("<final_answer>");
        });
    });

    it("结论写出后立即收尾的原有纪律仍在", () => {
        templates.forEach((tpl) => {
            expect(tpl).toContain("结论写出后立即收尾");
            expect(tpl).toContain("解析一次成型");
            expect(tpl).toContain("其后不得再有任何文字");
        });
    });
});
