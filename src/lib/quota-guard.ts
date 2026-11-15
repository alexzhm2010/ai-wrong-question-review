/**
 * 导入题目前的 AI 余额闸门（v1.21.5）。
 *
 * 需求：每次导入题目（单张 / 批量）真正开始 AI 解析之前，先读一次余额；
 * 若余额低于后台设置的告警阈值，弹窗提醒用户，由用户决定是否继续；否则直接放行。
 *
 * 现有余额刷新机制（打开页面同步 / 10 分钟节流 / 手动强制刷新）完全不变：
 * 这里只是复用 GET /api/ai-quota 的只读视图，不改 quota-sync、不改 ai-proxy、
 * 不新增任何账单接口调用节奏。
 *
 * 三条硬规则：
 *  1. 查询失败 / 超时 / 尚未同步余额 → 一律放行，绝不因为余额接口阻断或拖慢导入；
 *  2. 阈值取服务端 app_config_public.quota.warnThreshold，前端不另存一份；
 *  3. 弹窗是「提醒」不是「阻断」，用户可选「仍要继续」或「取消本次导入」。
 */
import type { AiQuotaResponse } from "@/types/api";

export interface QuotaWarningDetail {
    balance: number;
    threshold: number;
    currency: string;
    fetchedAt?: string;
    consoleUrl?: string;
}

export const DEFAULT_WARN_THRESHOLD = 20;
/** 超时后直接放行；bridge 会忽略 AbortSignal，所以这里用 Promise.race 兜底 */
export const GUARD_QUERY_TIMEOUT_MS = 4000;

/** 纯函数：余额低于阈值才需要提醒；数据缺失一律放行 */
export function needsQuotaWarning(
    view: AiQuotaResponse | null | undefined,
): QuotaWarningDetail | null {
    // 服务未配置 / 读取失败时不要拿脏数据去弹窗吓用户
    if (!view || view.configured === false || view.status === "error" || view.status === "unconfigured") {
        return null;
    }
    const amount = view?.balance?.availableAmount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return null;

    const raw = view?.settings?.warnThreshold;
    const threshold =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0
            ? raw
            : DEFAULT_WARN_THRESHOLD;

    // 「低于」阈值：严格小于；余额恰好等于阈值不弹窗
    if (amount >= threshold) return null;

    return {
        balance: amount,
        threshold,
        currency: view?.balance?.currency || "CNY",
        fetchedAt: view?.fetchedAt,
        consoleUrl: view?.consoleUrl,
    };
}

/* ------------------------- 全局单例弹窗桥 ------------------------- */

type WarningListener = (detail: QuotaWarningDetail | null) => void;
let listener: WarningListener | null = null;
let settle: ((proceed: boolean) => void) | null = null;
let pending: Promise<boolean> | null = null;

/** 全局唯一的弹窗组件订阅；在 RootLayout 里挂载一次 */
export function subscribeQuotaWarning(fn: WarningListener): () => void {
    listener = fn;
    return () => {
        if (listener === fn) listener = null;
    };
}

/** 弹窗按钮回调：true = 仍要继续导入，false = 取消本次导入 */
export function resolveQuotaWarning(proceed: boolean): void {
    const done = settle;
    settle = null;
    listener?.(null);
    done?.(proceed);
}

/** 弹出低余额提醒并等待用户决定；供导入闸门与单测调用 */
export function showQuotaWarning(detail: QuotaWarningDetail): Promise<boolean> {
    // 用户极快连点导致并发时，共用同一个弹窗与同一个决定，避免弹两次或卡死
    if (pending) return pending;
    pending = new Promise<boolean>((resolve) => {
        if (!listener) {
            resolve(true); // 弹窗未挂载（异常页面）→ 放行，绝不阻断导入
            return;
        }
        settle = resolve;
        listener(detail);
    }).then((proceed) => {
        pending = null;
        settle = null;
        return proceed;
    });
    return pending;
}

/**
 * 每次导入题目前调用一次。返回 true 表示继续导入，false 表示用户取消。
 *
 * 用原生 fetch 而非 apiClient：避开 15 秒 SWR GET 缓存，保证「每次导入前都查一次」；
 * bridge 会拦截 /api/* 走 handleAiRoute → quotaView，沿用现有 10 分钟同步节流。
 */
export async function confirmQuotaBeforeImport(): Promise<boolean> {
    let view: AiQuotaResponse | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const query = (async () => {
            const res = await fetch("/api/ai-quota");
            if (!res.ok) return null;
            return (await res.json()) as AiQuotaResponse;
        })();
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), GUARD_QUERY_TIMEOUT_MS);
        });
        view = await Promise.race([query, timeout]);
    } catch {
        view = null;
    } finally {
        if (timer) clearTimeout(timer);
    }

    const detail = needsQuotaWarning(view);
    if (!detail) return true;
    return showQuotaWarning(detail);
}
