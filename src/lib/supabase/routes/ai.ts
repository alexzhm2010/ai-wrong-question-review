/** AI 端点：全部转发到 Supabase Edge Function ai-proxy（密钥不落前端） */
import { aiEdge, nowIso, requireAdmin, restJson } from "../core";
import { apiError, json, type RouteContext } from "../http";
import { buildQuotaView, DEFAULT_QUOTA_SETTINGS, toNumber } from "../../quota-view";

const EDGE_ACTIONS: Record<string, string> = {
  "/api/analyze": "analyze",
  "/api/reanswer": "reanswer",
  "/api/geogebra-analyze": "geogebra_analyze",
  "/api/geogebra_analyze": "geogebra_analyze",
  "/api/ai/test": "test",
  "/api/grade-page": "grade_page",
};

async function readRawConfig(): Promise<Record<string, any>> {
  const rows = await restJson<any[]>(
    "/AppSetting?key=eq.app_config_public&select=value",
  ).catch(() => []);
  try {
    return JSON.parse(rows?.[0]?.value || "{}") || {};
  } catch {
    return {};
  }
}

async function readQuotaSnapshot(): Promise<Record<string, any> | null> {
  const rows = await restJson<any[]>(
    "/quota_snapshot?select=*&order=captured_at.desc&limit=1",
  ).catch(() => []);
  return rows?.[0] || null;
}

async function quotaView(): Promise<Record<string, any>> {
  const [snap, cfg] = await Promise.all([readQuotaSnapshot(), readRawConfig()]);
  return buildQuotaView(snap, cfg);
}

/** 保存手动录入的余额与额度设置；只写 app_config_public.quota，不触碰全局阻断表。 */
async function saveQuotaSettings(body: Record<string, any> | undefined): Promise<Response> {
  await requireAdmin();
  const cfg = await readRawConfig();
  const prev = { ...DEFAULT_QUOTA_SETTINGS, ...(cfg.quota || {}) };
  const next: Record<string, any> = { ...prev };
  const input = body || {};

  if (Object.prototype.hasOwnProperty.call(input, "manualBalance")) {
    const parsed = toNumber(input.manualBalance);
    next.manualBalance = parsed;
    if (parsed !== null) next.balanceSyncedAt = nowIso();
  }
  if (input.warnThreshold !== undefined) {
    const parsed = toNumber(input.warnThreshold);
    next.warnThreshold = parsed !== null && parsed > 0 ? parsed : 20;
  }
  if (input.freeQuotaExpireAt !== undefined) {
    next.freeQuotaExpireAt = String(input.freeQuotaExpireAt || "");
  }
  if (input.stopWhenFreeExpired !== undefined) {
    next.stopWhenFreeExpired = input.stopWhenFreeExpired !== false;
  }

  cfg.quota = next;
  try {
    await restJson("/AppSetting", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        key: "app_config_public",
        value: JSON.stringify(cfg),
        updatedAt: nowIso(),
      }),
    });
  } catch {
    return apiError(403, "保存失败：需要管理员权限，或数据库拒绝写入");
  }
  return json({ success: true, quota: next });
}

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
    if (ctx.method === "POST") return saveQuotaSettings(ctx.body);
    return json(await quotaView());
  }

  return apiError(404, "Unknown AI endpoint");
}
