/**
 * 火山方舟额度视图（纯函数，无 IO，便于单测）。
 *
 * 推理用的 ark- API Key 没有账单权限，无法在前端直接查余额：
 * 数字优先取服务端同步的 quota_snapshot 快照，其次取管理员从控制台手动录入的值。
 * quota_snapshot 只开放 SELECT（写权限保留给 Edge Function），避免普通用户改动全局阻断开关。
 */

/** 线上生效的火山方舟配置，与 Edge Function 的 OPENAI_* 环境变量保持一致。 */
export const VOLC_PROVIDER = {
  name: "火山方舟（豆包）",
  model: "doubao-seed-2-1-lite-260915",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
};

/** 火山引擎费用中心 → 资金账户 → 账户余额 */
export const VOLC_CONSOLE_URL = "https://console.volcengine.com/finance/fund/account-balance";

export const DEFAULT_QUOTA_SETTINGS: Record<string, any> = {
  warnThreshold: 20,
  freeQuotaExpireAt: "",
  stopWhenFreeExpired: true,
  manualBalance: null,
  balanceSyncedAt: null,
  autoSyncConfigured: false,
};

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function buildQuotaView(
  snap: Record<string, any> | null,
  cfg: Record<string, any>,
): Record<string, any> {
  const settings = { ...DEFAULT_QUOTA_SETTINGS, ...(cfg.quota || {}) };
  const snapBalance = toNumber(snap?.balance);
  const manualBalance = toNumber(settings.manualBalance);

  let amount: number | null = null;
  let source: "volc-api" | "manual" | "none" = "none";
  let fetchedAt: string | undefined;
  let cashBalance: number | null = null;
  let creditAmount = 0;

  if (snap && snapBalance !== null) {
    amount = snapBalance;
    source = snap.source === "manual" ? "manual" : "volc-api";
    fetchedAt = snap.captured_at || undefined;
    cashBalance = toNumber(snap.raw?.CashBalance ?? snap.raw?.cashBalance);
    creditAmount = toNumber(snap.raw?.CreditLimit ?? snap.raw?.creditLimit) ?? 0;
  } else if (manualBalance !== null) {
    amount = manualBalance;
    source = "manual";
    fetchedAt = settings.balanceSyncedAt || undefined;
  }

  const freeQuotaExpired = snap?.free_quota_expired === true;
  const stopWhenFreeExpired = snap?.stop_when_free_expired !== false;

  return {
    configured: amount !== null,
    status: amount !== null ? "ok" : "unconfigured",
    ...(amount !== null
      ? {
          balance: {
            currency: snap?.currency || "CNY",
            availableAmount: amount,
            availableCashAmount: cashBalance,
            creditAmount,
          },
        }
      : {}),
    source,
    fetchedAt,
    consoleUrl: VOLC_CONSOLE_URL,
    autoSyncConfigured: settings.autoSyncConfigured === true,
    message: amount === null ? "尚未同步火山方舟账户余额" : undefined,
    settings: {
      warnThreshold: toNumber(settings.warnThreshold) ?? 20,
      freeQuotaExpireAt: String(settings.freeQuotaExpireAt || ""),
      stopWhenFreeExpired: settings.stopWhenFreeExpired !== false,
      manualBalance,
    },
    availability: {
      allowed: !(freeQuotaExpired && stopWhenFreeExpired),
      freeQuotaExpired,
      ...(freeQuotaExpired && stopWhenFreeExpired ? { code: "AI_QUOTA_BLOCKED" } : {}),
    },
    provider: VOLC_PROVIDER,
  };
}
