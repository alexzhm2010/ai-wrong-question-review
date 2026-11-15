/**
 * Supabase Edge Function：火山方舟账户余额自动同步。
 *
 * 职责单一：用服务端 IAM 只读密钥（VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY）
 * 调用火山引擎费用中心 QueryBalanceAcct，把真实余额写入 quota_snapshot 表。
 * 前端 /api/ai-quota 只读快照表，永不接触 AK/SK。
 *
 * 与 ai-proxy 完全隔离：本函数不参与任何题目解析，部署/失败都不影响线上 AI 调用。
 *
 * 触发方式：
 *  - 前端 GET /api/ai-quota 时按需调用（force=false），10 分钟内复用已有快照；
 *  - 用户点「刷新」时 force=true，跳过节流立即查；
 *  - 运维可用 SUPABASE_SERVICE_ROLE_KEY 作 Bearer 直接调用做自检。
 */
import { queryVolcBalance } from "../_shared/volc-billing.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const VOLC_AK = Deno.env.get("VOLC_ACCESS_KEY_ID") || "";
const VOLC_SK = Deno.env.get("VOLC_SECRET_ACCESS_KEY") || "";
/** 运维自检 / 未来定时任务用的专用令牌；前端走用户 JWT，不需要它 */
const SYNC_TOKEN = Deno.env.get("QUOTA_SYNC_TOKEN") || "";

/** 快照有效期：10 分钟内重复打开页面不再打火山 API，避免无谓调用与限流 */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** service_role 走 PostgREST 可绕过 RLS 写 quota_snapshot（该表只开放 SELECT 给登录用户） */
function serviceHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * 鉴权：只接受合法用户 JWT，或服务端 service_role 密钥（供定时/运维自检）。
 * 匿名 anon key 一律拒绝，避免任何人都来触发账单接口。
 */
async function isAuthorized(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return true;
  if (SYNC_TOKEN && token === SYNC_TOKEN) return true;
  if (token === ANON_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function latestSnapshot(): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/quota_snapshot?select=*&order=captured_at.desc&limit=1`,
      { headers: serviceHeaders() },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] || null;
  } catch {
    return null;
  }
}

/** 读取 app_config_public.quota，用于计算免费额度到期与「到期即停」标记 */
async function readQuotaSettings(): Promise<Record<string, any>> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/AppSetting?key=eq.app_config_public&select=value`,
      { headers: serviceHeaders() },
    );
    if (!res.ok) return {};
    const rows = await res.json();
    const cfg = JSON.parse(rows?.[0]?.value || "{}");
    return cfg?.quota && typeof cfg.quota === "object" ? cfg.quota : {};
  } catch {
    return {};
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await isAuthorized(req))) return json({ error: "Unauthorized" }, 401);

  let force = false;
  try {
    const body = await req.json();
    force = body?.force === true;
  } catch { /* 空 body 视为普通同步 */ }

  if (!VOLC_AK || !VOLC_SK) {
    return json({
      error: "VOLC_BILLING_NOT_CONFIGURED",
      message: "服务端未配置 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY",
    }, 503);
  }

  const prev = await latestSnapshot();
  const age = prev?.captured_at
    ? Date.now() - new Date(prev.captured_at).getTime()
    : Number.POSITIVE_INFINITY;
  if (!force && Number.isFinite(age) && age < SNAPSHOT_TTL_MS) {
    return json({
      ok: true,
      cached: true,
      source: prev.source || "volc-api",
      balance: Number(prev.balance),
      capturedAt: prev.captured_at,
    });
  }

  let balance: Awaited<ReturnType<typeof queryVolcBalance>>;
  try {
    balance = await queryVolcBalance({
      accessKeyId: VOLC_AK,
      secretAccessKey: VOLC_SK,
    });
  } catch (e) {
    // 火山侧异常时不写表，保留上一份快照供前端降级展示
    return json({
      error: "VOLC_BILLING_FAILED",
      message: e instanceof Error ? e.message : String(e),
      hasFallback: !!prev,
    }, 502);
  }
  if (!balance) {
    return json({ error: "VOLC_BILLING_EMPTY_RESULT", hasFallback: !!prev }, 502);
  }

  const settings = await readQuotaSettings();
  const expiry = String(settings.freeQuotaExpireAt || "");
  const expiryMs = expiry ? new Date(`${expiry}T23:59:59+08:00`).getTime() : NaN;
  const freeQuotaExpired = Number.isFinite(expiryMs) && expiryMs < Date.now();
  const stopWhenFreeExpired = settings.stopWhenFreeExpired !== false;

  const raw = {
    AvailableBalance: balance.availableAmount,
    CashBalance: balance.cashAmount,
    CreditLimit: balance.creditLimit,
    ArrearsBalance: balance.arrearsAmount,
    FreezeAmount: balance.frozenAmount,
    Currency: balance.currency,
  };

  const capturedAt = new Date().toISOString();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/quota_snapshot`, {
      method: "POST",
      headers: { ...serviceHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        balance: balance.availableAmount,
        currency: balance.currency,
        source: "volc-api",
        raw,
        free_quota_expired: freeQuotaExpired,
        stop_when_free_expired: stopWhenFreeExpired,
        captured_at: capturedAt,
      }),
    });
    if (!res.ok) {
      return json({
        error: "SNAPSHOT_WRITE_FAILED",
        message: `PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`,
      }, 500);
    }
  } catch (e) {
    return json({
      error: "SNAPSHOT_WRITE_FAILED",
      message: e instanceof Error ? e.message : String(e),
    }, 500);
  }

  return json({
    ok: true,
    cached: false,
    source: "volc-api",
    balance: balance.availableAmount,
    cashBalance: balance.cashAmount,
    currency: balance.currency,
    capturedAt,
  });
});
