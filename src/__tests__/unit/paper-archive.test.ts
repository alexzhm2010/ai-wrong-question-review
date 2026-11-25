import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    canView,
    canDelete,
    paperViewHref,
    paperMarkHref,
    deleteConfirmText,
    isSubmitted,
    scoreLabel,
    deletableCodes,
    PAPER_PAGE_SIZE,
    totalPages,
    pageAfterDelete,
} from "@/lib/paper-archive";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("练习试卷归档：选中约束纯逻辑", () => {
    it("查看必须恰好选中一份", () => {
        expect(canView(0)).toBe(false);
        expect(canView(1)).toBe(true);
        expect(canView(2)).toBe(false);
        expect(canView(5)).toBe(false);
    });

    it("删除可选中一份或多份", () => {
        expect(canDelete(0)).toBe(false);
        expect(canDelete(1)).toBe(true);
        expect(canDelete(3)).toBe(true);
    });

    it("查看链接带编码后的 code", () => {
        expect(paperViewHref("abc123")).toBe("/paper-view?c=abc123");
        expect(paperViewHref("a b&c")).toBe("/paper-view?c=a%20b%26c");
    });

    it("批改页链接带编码 code 与来源参数 from=papers", () => {
        expect(paperMarkHref("abc123")).toBe("/mark?c=abc123&from=papers");
        expect(paperMarkHref("a b&c")).toBe("/mark?c=a%20b%26c&from=papers");
    });

    it("删除确认文案带份数、提示不可恢复，并说明已批改卷被保留", () => {
        const text = deleteConfirmText(3);
        expect(text).toContain("3");
        expect(text).toContain("无法恢复");
        expect(text).toContain("已批改");
    });
});

describe("练习试卷归档：得分列与已批改禁删", () => {
    it("isSubmitted：score 或 submittedAt 任一存在即已批改，0 分也算", () => {
        expect(isSubmitted({ score: 85, submittedAt: "2026-01-01" })).toBe(true);
        expect(isSubmitted({ score: 0, submittedAt: "2026-01-01" })).toBe(true); // 全错也是已批改
        expect(isSubmitted({ score: null, submittedAt: null })).toBe(false);
        expect(isSubmitted({ score: null, submittedAt: "2026-01-01" })).toBe(true);
        expect(isSubmitted({ score: 85, submittedAt: null })).toBe(true);
    });

    it("scoreLabel：已批改显示分数（含 0），未批改显示破折号", () => {
        expect(scoreLabel({ score: 85, submittedAt: "x" })).toBe("85");
        expect(scoreLabel({ score: 0, submittedAt: "x" })).toBe("0");
        expect(scoreLabel({ score: null, submittedAt: null })).toBe("—");
    });

    it("deletableCodes：只保留未批改卷的 code", () => {
        const rows = [
            { code: "a", score: 80, submittedAt: "x" },
            { code: "b", score: null, submittedAt: null },
            { code: "c", score: 0, submittedAt: "x" },
            { code: "d", score: null, submittedAt: null },
        ];
        expect(deletableCodes(rows)).toEqual(["b", "d"]);
    });
});

describe("练习试卷归档：删除 RPC 与路由", () => {
    it("migration 定义 paper_delete 且强制按当前用户过滤、只授权登录用户", () => {
        const sql = read("supabase/migrations/20261119_paper_delete.sql");
        expect(sql).toContain("function public.paper_delete");
        expect(sql).toContain("current_app_user_id()");
        expect(sql).toContain('"userId" = v_uid');
        expect(sql).toContain("jsonb_array_elements_text(p_codes)");
        expect(sql).toContain('"submittedAt" is null'); // 已批改卷禁止删除，保留批改明细
        expect(sql).toContain("on delete cascade"); // 注释里说明级联
        expect(sql).toContain("to authenticated");
        expect(sql).toMatch(/revoke[\s\S]*from public, anon/);
    });

    it("路由注册 /api/paper/delete 且归一化 codes 入参", () => {
        const src = read("src/lib/supabase/routes/paper.ts");
        expect(src).toContain('ctx.parts[1] !== "delete"');
        expect(src).toContain('"paper_delete"');
        expect(src).toContain("handleDelete");
        expect(src).toContain("ctx.body?.codes");
    });
});

describe("练习试卷归档：服务端分页", () => {
    it("分页 RPC 有稳定复合排序、limit 保护、按当前用户过滤", () => {
        const sql = read("supabase/migrations/20261119_paper_list_page.sql");
        expect(sql).toContain("function public.paper_list_page");
        expect(sql).toContain("current_app_user_id()");
        expect(sql).toContain('"userId" = v_uid');
        expect(sql).toContain('order by "createdAt" desc, code desc');
        expect(sql).toContain("limit v_limit offset v_offset");
        expect(sql).toContain("'rows', v_rows");
        expect(sql).toContain("'total', v_total");
        expect(sql).toContain("to authenticated");
    });

    it("分页路由把 page 转成 offset 并调 paper_list_page", () => {
        const src = read("src/lib/supabase/routes/paper.ts");
        expect(src).toContain('ctx.parts[1] !== "list-page"');
        expect(src).toContain('"paper_list_page"');
        expect(src).toContain("p_limit: pageSize, p_offset: offset");
        expect(src).toContain("handleListPage");
    });

    it("总页数计算：0 条也算 1 页，向上取整", () => {
        expect(PAPER_PAGE_SIZE).toBe(20);
        expect(totalPages(0)).toBe(1);
        expect(totalPages(1)).toBe(1);
        expect(totalPages(20)).toBe(1);
        expect(totalPages(21)).toBe(2);
        expect(totalPages(45)).toBe(3);
    });

    it("删除后页码回退：删空当前页则回退，否则保持", () => {
        expect(pageAfterDelete(2, 3, 3)).toBe(1); // 第2页3条全删→回第1页
        expect(pageAfterDelete(2, 20, 5)).toBe(2); // 还剩15条→留第2页
        expect(pageAfterDelete(1, 5, 5)).toBe(1); // 第1页删空也停第1页
        expect(pageAfterDelete(3, 20, 20)).toBe(2); // 第3页删空→回第2页
    });
});

describe("练习试卷归档：页面接线", () => {
    it("归档页操作：查看走只读页、点行跳批改页、删除走批量接口且过滤已批改卷", () => {
        const page = read("src/app/papers/page.tsx");
        expect(page).toContain("/api/paper/list-page?page=");
        expect(page).toContain('"/api/paper/delete"');
        expect(page).toContain("canView(selected.size)");
        expect(page).toContain("canDelete(selected.size)");
        expect(page).toContain("paperViewHref([...selected][0])");
        expect(page).toContain("deleteConfirmText(selected.size)");
        // 点整行进入批改页（带来源），删除前用 deletableCodes 过滤已批改卷
        expect(page).toContain("paperMarkHref");
        expect(page).toContain("onClick={() => openMark(row.code)}");
        expect(page).toContain("deletableCodes(rows).filter((c) => selected.has(c))");
    });

    it("归档页有得分列，已批改卷 checkbox 禁用", () => {
        const page = read("src/app/papers/page.tsx");
        expect(page).toContain("scoreLabel(row)");
        expect(page).toContain("得分");
        expect(page).toContain("disabled={submitted}");
        expect(page).toContain("isSubmitted(row)");
    });

    it("批改页支持 from=papers：返回练习试卷、不自动弹分数层", () => {
        const mark = read("src/app/mark/page.tsx");
        expect(mark).toContain('searchParams.get("from") === "papers"');
        expect(mark).toContain("PAPERS_HOME");
        expect(mark).toContain("返回练习试卷");
        expect(mark).toContain("!fromPapers && p.score !== null"); // 不弹分数层遮挡题目
        expect(mark).toContain("backLabel={backLabel}");
    });

    it("扫码批卷已移植到练习试卷页，批改中心页已移除", () => {
        const papers = read("src/app/papers/page.tsx");
        expect(papers).toContain("<QrScanner");
        expect(papers).toContain("扫码批卷");
        expect(papers).toContain("setScanning(true)");
        const fs = require("node:fs");
        expect(fs.existsSync(resolve(root, "src/app/mark-center/page.tsx"))).toBe(false);
    });

    it("手机底部保留「试卷」Tab，但我的页管理工具里不再显示练习试卷入口", () => {
        const shell = read("src/components/app-shell.tsx");
        expect(shell).toContain('{ href: "/papers", label: "试卷", icon: Files }');
        const me = read("src/app/me/page.tsx");
        expect(me).not.toContain('{ href: "/papers", label: "练习试卷"');
        expect(me).not.toContain('href: "/mark-center"');
    });

    it("归档页有上一页/下一页与页码显示", () => {
        const page = read("src/app/papers/page.tsx");
        expect(page).toContain("上一页");
        expect(page).toContain("下一页");
        expect(page).toContain("第 {page} / {pages} 页");
        expect(page).toContain("void load(page - 1)");
        expect(page).toContain("void load(page + 1)");
    });

    it("查看页只读：用 paper_read 取卷、展示参考答案、无提交按钮", () => {
        const view = read("src/app/paper-view/page.tsx");
        expect(view).toContain("/api/paper/read?c=");
        expect(view).toContain("PaperQuestionCard"); // 题目/答案区已抽成共享卡片
        expect(view).toContain("PAPERS_HOME");
        // 查看页不应出现判分/提交（那是 /mark 的职责）
        expect(view).not.toContain('"/api/paper/submit"');
        expect(view).not.toContain("提交批改");
    });
});
