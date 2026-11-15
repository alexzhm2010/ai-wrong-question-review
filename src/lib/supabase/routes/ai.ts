/** AI 端点：全部转发到 Supabase Edge Function ai-proxy（密钥不落前端） */
import { aiEdge, restJson } from "../core";
import { apiError, json, type RouteContext } from "../http";

const EDGE_ACTIONS: Record<string, string> = {
  "/api/analyze": "analyze",
  "/api/reanswer": "reanswer",
  "/api/geogebra-analyze": "geogebra_analyze",
  "/api/geogebra_analyze": "geogebra_analyze",
  "/api/ai/test": "test",
  "/api/grade-page": "grade_page",
};

export async function handleAiRoute(ctx: RouteContext): Promise<Response> {
  const action = EDGE_ACTIONS[ctx.path];
  if (action) return aiEdge(action, ctx.body, ctx.signal);

  if (ctx.path === "/api/ai/models") {
    // 静态版实际由 Edge Function ai-proxy 的 OPENAI_* 环境变量决定模型。
    // 这里只列出当前线上确已启用的火山方舟模型，避免下拉里出现根本不会生效的通义千问。
    // 需要其它模型时由用户在「模型名称」里手动填写。
    return json({
      models: [
        { id: "doubao-seed-2-1-lite-260915", name: "豆包 Seed 2.1 Lite（火山方舟 · 当前生效）", provider: "openai", vision: true },
      ],
      defaultModel: "doubao-seed-2-1-lite-260915",
    });
  }

  if (ctx.path === "/api/ai-quota") {
    const rows = await restJson<any[]>(
      "/quota_snapshot?select=*&order=captured_at.desc&limit=1",
    ).catch(() => []);
    if (!rows?.length) {
      return json({
        available: true,
        source: "static",
        balance: null,
        currency: "CNY",
        checkedAt: null,
        message: "余额快照尚未生成",
      });
    }
    const snap = rows[0];
    return json({
      available: snap.free_quota_expired !== true,
      balance: snap.balance ?? null,
      currency: snap.currency || "CNY",
      freeQuotaExpired: snap.free_quota_expired === true,
      checkedAt: snap.captured_at || null,
      source: "quota_snapshot",
    });
  }

  return apiError(404, "Unknown AI endpoint");
}
