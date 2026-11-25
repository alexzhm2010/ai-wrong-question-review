/**
 * 批改「未做」(blank) 等同 skip 的契约测试（2026-11-26）。
 * 后端：paper_submit 不再把 blank 计错/清连对，lastResult 写 skip。
 * 前端：scoreItem 对 skip 给「补做」理由。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf-8");

describe("未做(blank)等同 skip - 后端迁移契约", () => {
    const sql = read("../supabase/migrations/20261126_paper_blank_skip.sql");

    it("blank 写 lastResult='skip'，而不是 wrong", () => {
        expect(sql).toContain("when v_is_skip then 'skip'");
        expect(sql).toContain("v_is_skip := (v_new = 'blank')");
    });

    it("blank 不计错：加新分支只有 wrong 才 v_wc+1", () => {
        expect(sql).toContain("elsif v_new = 'wrong' then v_wc := v_wc + 1; end if;");
    });

    it("blank 撤销旧时不再减 wrongCount", () => {
        expect(sql).toContain("elsif v_old = 'wrong' then v_wc := v_wc - 1; end if;");
        // 不再有 v_old = 'blank' 触发的减 wrong
        expect(sql).not.toContain("v_old = 'wrong' or v_old = 'blank'");
    });

    it("blank 不打断连对、不改掌握档位、不改错状态", () => {
        expect(sql).toContain("elsif v_new = 'wrong' then");
        expect(sql).toContain("v_streak := coalesce(v_e.\"correctStreak\", 0);");
        expect(sql).toContain("elsif v_is_skip then");
        expect(sql).toContain("v_mastery := coalesce(v_e.\"masteryLevel\", 0);");
        expect(sql).toContain("when v_is_correct or v_is_skip");
    });

    it("计分仍按答对数/题数，blank 不得分", () => {
        expect(sql).toContain("if v_is_correct then v_correct := v_correct + 1; end if;");
    });
});
