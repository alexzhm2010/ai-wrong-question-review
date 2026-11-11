/** AI 端点：全部转发到 Supabase Edge Function ai-proxy（密钥不落前端） */
import { aiEdge, restJson } from "../core";
import { apiError, json, type RouteContext } from "../http";

const EDGE_ACTIONS: Record<string, string> = {
  "/api/analyze": "analyze",
  "/api/reanswer": "reanswer",
  "/api/geogebra-analyze": "geogebra_analyze",
  "/api/geogebra_analyze": "geogebra_analyze",
  "/api/ai/test": "test",
};

export async function handleAiRoute(ctx: RouteContext): Promise<Response> {
  const action = EDGE_ACTIONS[ctx.path];
  if (action) return aiEdge(action, ctx.body, ctx.signal);

  if (ctx.path === "/api/ai/models") {
    return json({
      models: [
        { id: "qwen3-vl-plus", name: "通义千问 3 VL Plus", provider: "openai", vision: true },
        { id: "qwen-vl-max", name: "通义千问 VL Max", provider: "openai", vision: true },
      ],
      defaultModel: "qwen3-vl-plus",
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
