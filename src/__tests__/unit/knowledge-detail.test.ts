/**
 * 「必备知识点精讲」(knowledgeDetail) 全链路契约测试（2026-11-28）。
 * 覆盖：数据库列 / 两套 prompt 标签 / 守卫标签表 / 流式解析 /
 *       Edge 解析写回 / 批量链路 / 前端录入与详情页 / 旧题补生成入口。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf-8");

describe("必备知识点精讲 - 数据库迁移", () => {
    const sql = read("supabase/migrations/20261128_knowledge_detail.sql");

    it("ErrorItem 增加 knowledgeDetail 列", () => {
        expect(sql).toContain('add column if not exists "knowledgeDetail" text');
    });

    it("BatchItem 也增加该列，避免批量 worker 写入时报 400", () => {
        expect(sql).toContain('alter table public."BatchItem"');
        expect(sql).toContain('add column if not exists "knowledgeDetail" text');
    });
});

describe("必备知识点精讲 - AI 提示词", () => {
    const front = read("src/lib/ai/prompts.ts");
    const edge = read("supabase/functions/ai-proxy/lib/prompts.ts");

    it("前后端 prompt 副本完全一致", () => {
        expect(edge).toBe(front);
    });

    it("analyze 与 reanswer 模板都包含 knowledge_detail 标签与写作要求", () => {
        for (const tpl of [front, edge]) {
            expect(tpl).toContain("<knowledge_detail>");
            expect(tpl).toContain("</knowledge_detail>");
            expect(tpl).toContain("让学生读完就能独立掌握");
            expect(tpl).toContain("易错点与边界");
        }
    });

    it("有独立的旧题补生成提示词函数", () => {
        expect(front).toContain("DEFAULT_KNOWLEDGE_DETAIL_TEMPLATE");
        expect(front).toContain("export function generateKnowledgeDetailPrompt");
        expect(front).toContain("<knowledge_detail>");
    });
});

describe("必备知识点精讲 - 输出守卫标签表", () => {
    it("前端与 Edge 的 AI_TAG_NAMES 都登记了 knowledge_detail", () => {
        for (const p of [
            "src/lib/ai/response-guard.ts",
            "supabase/functions/ai-proxy/lib/response-guard.ts",
        ]) {
            expect(read(p)).toContain("'knowledge_detail'");
        }
    });
});

describe("必备知识点精讲 - Edge 解析与写回", () => {
    const proxy = read("supabase/functions/ai-proxy/index.ts");
    const worker = read("supabase/functions/batch-worker/index.ts");

    it("ai-proxy parseResponse 提取并清洗 knowledge_detail", () => {
        expect(proxy).toContain('extractTag(text, "knowledge_detail")');
        expect(proxy).toContain("const knowledgeDetail = detailRaw ? sanitizeBodyText(detailRaw) : \"\"");
        expect(proxy).toContain("knowledgeDetail,");
    });

    it("ai-proxy 有旧题补生成 action，只产出精讲标签", () => {
        expect(proxy).toContain('action === "knowledge_detail"');
        expect(proxy).toContain('extractTagSafe(text, "knowledge_detail")');
    });

    it("batch worker 解析并写入 knowledgeDetail", () => {
        expect(worker).toContain('extractTag(text, "knowledge_detail")');
        expect(worker).toContain("knowledgeDetail: parsed.knowledgeDetail || null");
    });
});

describe("必备知识点精讲 - 存储与批量链路", () => {
    const items = read("src/lib/supabase/routes/error-items.ts");
    const batch = read("src/lib/supabase/routes/batch.ts");

    it("buildItem 的字段表包含 knowledgeDetail", () => {
        expect(items).toContain('"knowledgeDetail"');
    });

    it("批量 finalize 把精讲带入 ErrorItem", () => {
        expect(batch).toContain("knowledgeDetail: item.knowledgeDetail ?? null");
    });
});

describe("必备知识点精讲 - 前端页面", () => {
    it("录入编辑器支持查看/编辑/重解更新精讲", () => {
        const editor = read("src/components/correction-editor.tsx");
        expect(editor).toContain('"knowledgeDetail"');
        expect(editor).toContain("必备知识点精讲");
        expect(editor).toContain("result.knowledgeDetail ?? prev.knowledgeDetail");
    });

    it("题目详情页展示精讲并支持 AI 补生成", () => {
        const item = read("src/app/item/page.tsx");
        expect(item).toContain('knowledgeDetail?: string | null');
        expect(item).toContain("/api/knowledge-detail");
        expect(item).toContain("AI 生成精讲");
    });

    it("流式预览展示精讲栏目", () => {
        const review = read("src/components/streaming-review.tsx");
        expect(review).toContain("必备知识点精讲");
        expect(review).toContain("data.knowledgeDetail");
    });

    it("前端 AI 路由登记了 knowledge-detail 端点", () => {
        const ai = read("src/lib/supabase/routes/ai.ts");
        expect(ai).toContain('"/api/knowledge-detail": "knowledge_detail"');
    });
});
