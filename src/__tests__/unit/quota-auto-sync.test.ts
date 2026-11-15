import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * 余额自动同步的安全护栏。
 * 核心约束：火山 IAM 的 AK/SK 只能存在于 Supabase Edge Function secrets，
 * 绝不能出现在前端源码、静态产物、数据库配置或测试文件里。
 */
describe("余额自动同步：凭证绝不落前端", () => {
    const FILES = [
        "src/lib/supabase/config.ts",
        "src/lib/supabase/core.ts",
        "src/lib/supabase/routes/ai.ts",
        "src/lib/quota-view.ts",
        "src/components/ai-quota-card.tsx",
        "src/lib/translations.ts",
        "supabase/functions/quota-sync/index.ts",
        "supabase/functions/_shared/volc-billing.ts",
        "supabase/schema.sql",
    ];

    it("所有相关源码都不含硬编码的火山 AK/SK 字面量", () => {
        for (const file of FILES) {
            const src = read(file);
            // 火山 IAM AccessKey 以 AKLT 开头；SecretAccessKey 是 base64/长串。
            // 只检查「形如赋值/内联的真实凭证」，避免误伤文档里的变量名。
            expect(src, `${file} 不应出现 AK 字面量`).not.toMatch(/AKLT[A-Za-z0-9+/=]{20,}/);
            expect(src, `${file} 不应把 SecretAccessKey 值写死`).not.toMatch(
                /(?:SECRET|secret|Secret)[A-Za-z_]*\s*[:=]\s*["']?[A-Za-z0-9+/=]{40,}["']?/
            );
            expect(src, `${file} 不应出现 VOLC_ACCESS_KEY_ID= 形式的赋值`).not.toMatch(
                /VOLC_ACCESS_KEY_ID\s*=\s*[A-Za-z0-9]/
            );
        }
    });

    it("凭证只通过 Deno.env.get 在服务端读取，前端不引用任何火山密钥变量", () => {
        const edge = read("supabase/functions/quota-sync/index.ts");
        expect(edge).toContain('Deno.env.get("VOLC_ACCESS_KEY_ID")');
        expect(edge).toContain('Deno.env.get("VOLC_SECRET_ACCESS_KEY")');
        expect(edge).toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');

        for (const file of [
            "src/lib/supabase/config.ts",
            "src/lib/supabase/core.ts",
            "src/lib/supabase/routes/ai.ts",
            "src/components/ai-quota-card.tsx",
        ]) {
            const src = read(file);
            expect(src, `${file} 不应读取火山密钥`).not.toContain("VOLC_ACCESS_KEY_ID");
            expect(src, `${file} 不应读取火山密钥`).not.toContain("VOLC_SECRET_ACCESS_KEY");
            expect(src, `${file} 不应持有 service_role`).not.toContain("SERVICE_ROLE_KEY");
        }
    });

    it("前端只调用独立同步函数，密钥不随请求体下发", () => {
        const core = read("src/lib/supabase/core.ts");
        expect(core).toContain("QUOTA_EDGE");
        expect(core).toContain("export async function quotaSyncEdge");
        // 请求体只允许 force 布尔，不能夹带任何凭证字段
        expect(core).toContain("JSON.stringify({ force })");
        expect(core).not.toContain("accessKeyId");
        expect(core).not.toContain("secretAccessKey");
        expect(read("src/lib/supabase/config.ts")).toContain("/functions/v1/quota-sync");
    });
});

describe("余额自动同步：链路与文案一致", () => {
    it("额度读取会触发同步，且失败可静默降级", () => {
        const routes = read("src/lib/supabase/routes/ai.ts");
        expect(routes).toContain("await quotaSyncEdge(force)");
        expect(routes).toContain("catch");
        expect(routes).toContain('ctx.query.get("refresh") === "1"');
        expect(routes).toContain("readQuotaSnapshot()");
    });

    it("同步函数是独立部署单元，不改 ai-proxy 解析链路", () => {
        expect(existsSync(resolve(root, "supabase/functions/quota-sync/index.ts"))).toBe(true);
        const edge = read("supabase/functions/quota-sync/index.ts");
        expect(edge).toContain("QueryBalanceAcct");
        expect(edge).toContain('source: "volc-api"');
        expect(edge).toContain("/rest/v1/quota_snapshot");
        expect(edge).toContain("SNAPSHOT_TTL_MS");
        // 匿名请求必须被拒
        expect(edge).toContain("Unauthorized");
        const proxy = read("supabase/functions/ai-proxy/index.ts");
        expect(proxy).not.toContain("quota-sync");
        expect(proxy).not.toContain("VOLC_ACCESS_KEY_ID");
    });

    it("卡片文案不再声称「无法自动读取」，并展示自动同步状态", () => {
        const card = read("src/components/ai-quota-card.tsx");
        expect(card).toContain("data?.autoSyncConfigured");
        expect(card).toContain("autoSyncOn");
        expect(card).not.toContain("无法自动读取账户余额");
        const zh = read("src/lib/translations.ts");
        expect(zh).toContain("已配置火山引擎 IAM 只读密钥");
        expect(zh).toContain("自动同步已开启");
        expect(zh).not.toContain("没有账单查询权限，无法自动读取账户余额");
    });

    it("schema 中快照表补齐真实列，默认值改为 volc-api", () => {
        const schema = read("supabase/schema.sql");
        expect(schema).toContain("source                 text default 'volc-api'");
        expect(schema).toContain("raw                    jsonb");
        expect(schema).toContain("stop_when_free_expired boolean");
        expect(schema).not.toContain("aliyun-bss");
    });
});
