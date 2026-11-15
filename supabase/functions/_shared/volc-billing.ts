/**
 * 火山引擎 Billing OpenAPI —— QueryBalanceAcct（查询账户余额）。
 *
 * 仅供服务端使用（Supabase Edge Function），**严禁把 AK/SK 传入浏览器或写入数据库**。
 * 环境变量约定：VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY（可选 VOLC_REGION，默认 cn-beijing）。
 *
 * 为什么需要它：火山方舟的推理 API Key（ark-...）只有调用 /api/v3 的权限，
 * 实测用它请求 QueryBalanceAcct 会返回 InvalidAuthorization；查账户余额必须用
 * 火山引擎 IAM 的 AccessKey ID / SecretAccessKey 做 HMAC-SHA256 签名。
 *
 * 该模块目前是「接入就绪」状态：签名与解析均已实现并有单测覆盖，
 * 待配置好 IAM 只读密钥后，由 Edge Function 定时/按需调用并把结果写入 quota_snapshot，
 * 前端 /api/ai-quota 就会自动优先展示服务端同步的真实余额（source = "volc-api"）。
 *
 * 参考：https://www.volcengine.com/docs/BillingCenter/QueryBalanceAcct-Queryuseraccountbalanceinformation
 */

const SERVICE = "billing";
const VERSION = "2022-01-01";
const ACTION = "QueryBalanceAcct";
const DEFAULT_HOST = "billing.volcengineapi.com";
const DEFAULT_REGION = "cn-beijing";

export interface VolcCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
}

export interface VolcBalance {
  currency: string;
  availableAmount: number;
  cashAmount: number;
  creditLimit: number;
  arrearsAmount: number;
  frozenAmount: number;
}

export interface SignedBalanceRequest {
  url: string;
  /** 只需这两个头；Host 由 URL 决定，签名时按 canonical headers 计算即可 */
  headers: { "X-Date": string; Authorization: string };
  host: string;
}

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return hex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array | string, message: string): Promise<Uint8Array> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return new Uint8Array(signature);
}

/** 生成火山引擎 OpenAPI V4 签名请求（不发起网络调用，便于单测）。 */
export async function buildBalanceRequest(
  creds: VolcCredentials,
  now: Date = new Date(),
): Promise<SignedBalanceRequest> {
  const region = creds.region || DEFAULT_REGION;
  const host = creds.endpoint || DEFAULT_HOST;
  const xDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const shortDate = xDate.slice(0, 8);
  const query = `Action=${ACTION}&Version=${VERSION}`;

  const canonicalRequest = [
    "GET",
    "/",
    query,
    `host:${host}\n`,
    "host",
    await sha256Hex(""),
  ].join("\n");

  const credentialScope = `${shortDate}/${region}/${SERVICE}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(creds.secretAccessKey, shortDate);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, "request");
  const signature = hex(await hmac(kSigning, stringToSign));

  return {
    url: `https://${host}/?${query}`,
    host,
    headers: {
      "X-Date": xDate,
      Authorization: `HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=host, Signature=${signature}`,
    },
  };
}

/** 解析 QueryBalanceAcct 的 Result；缺少 AvailableBalance 视为无效响应。 */
export function parseBalanceResponse(payload: unknown): VolcBalance | null {
  const body = payload as Record<string, any> | null;
  const result = body?.Result ?? body?.result;
  if (!result || typeof result !== "object") return null;
  const raw = result.AvailableBalance ?? result.availableBalance;
  if (raw === undefined || raw === null) return null;
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    currency: String(result.Currency || result.currency || "CNY"),
    availableAmount: num(raw),
    cashAmount: num(result.CashBalance ?? result.cashBalance ?? 0),
    creditLimit: num(result.CreditLimit ?? result.creditLimit ?? 0),
    arrearsAmount: num(result.ArrearsBalance ?? result.arrearsBalance ?? 0),
    frozenAmount: num(result.FreezeAmount ?? result.freezeAmount ?? 0),
  };
}

/** 查询真实账户余额；未配置凭证返回 null（不做任何网络请求）。 */
export async function queryVolcBalance(
  creds: Partial<VolcCredentials> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<VolcBalance | null> {
  if (!creds?.accessKeyId || !creds?.secretAccessKey) return null;
  const signed = await buildBalanceRequest(creds as VolcCredentials);
  const response = await fetchImpl(signed.url, { method: "GET", headers: signed.headers });
  if (!response.ok) throw new Error(`VOLC_BILLING_HTTP_${response.status}`);
  const balance = parseBalanceResponse(await response.json());
  if (!balance) throw new Error("VOLC_BILLING_EMPTY_RESULT");
  return balance;
}
