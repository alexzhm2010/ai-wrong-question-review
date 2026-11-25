/**
 * 「完全掌握」判定（verdict=mastered）的前后端契约测试（2026-11-23）。
 * 前端：批改页第 4 个按钮 + 路由白名单放行 + 卡片标签；
 * 后端：paper_submit 把 mastered 计为答对并归档 masteryLevel=3。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf-8");

describe("完全掌握按钮 - 前端", () => {
    it("批改页定义 mastered 判定与独立按钮文案", () => {
        const mark = read("app/mark/page.tsx");
        expect(mark).toContain('type Verdict = "correct" | "wrong" | "blank" | "mastered"');
        expect(mark).toContain("完全掌握（不再出现）");
        expect(mark).toContain('onClick={() => pick(it.errorItemId, MASTERED.key)}');
    });

    it("预填支持 mastered，保证重新打开时回显完全掌握", () => {
        const mark = read("app/mark/page.tsx");
        expect(mark).toContain('it.verdict === "mastered"');
    });

    it("提交路由放行 mastered", () => {
        const route = read("lib/supabase/routes/paper.ts");
        expect(route).toContain('["correct", "wrong", "blank", "mastered"].includes');
    });

    it("共享卡片有完全掌握标签与配色", () => {
        const card = read("components/paper-question-card.tsx");
        expect(card).toContain('mastered: "完全掌握"');
        expect(card).toContain('verdict === "mastered"');
    });
});

describe("完全掌握 - 后端迁移契约", () => {
    const sql = read("../supabase/migrations/20261123_paper_mastered.sql");

    it("paper_submit 接受 mastered 判定", () => {
        expect(sql).toContain("'correct', 'wrong', 'blank', 'mastered'");
    });

    it("mastered 计分为答对", () => {
        expect(sql).toContain("v_is_correct := (v_new = 'correct' or v_new = 'mastered')");
    });

    it("mastered 直接归档 masteryLevel=3 且 streak≥2", () => {
        expect(sql).toContain("if v_new = 'mastered' then");
        expect(sql).toContain("v_mastery := 3;");
        expect(sql).toContain("v_streak  := greatest(v_streak, 2)");
    });

    it("correct 与 mastered 互切时计数不重复累加（撤销旧含 mastered）", () => {
        expect(sql).toContain("if v_old = 'correct' or v_old = 'mastered' then v_cc := v_cc - 1;");
    });
});
