/**
 * 免费实例保活：Render 免费 Web Service 在 15 分钟无入站请求后会休眠，
 * 这里在服务进程内定时请求自身的公网地址，产生入站请求以避免休眠。
 *
 * 仅在存在 RENDER_EXTERNAL_URL 时启用，本地/其他平台不会触发。
 *
 * 可用环境变量：
 *   KEEPALIVE_INTERVAL_MS  基础间隔（毫秒），默认 600000（10 分钟）
 *   KEEPALIVE_ENABLED      设为 false 可关闭
 *
 * 每轮会在基础间隔上叠加 ±25% 的随机抖动，避免固定节奏。
 */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // Render 休眠阈值是 15 分钟
const MIN_INTERVAL_MS = 5 * 1000;

export function startKeepAlive() {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) return;
  if (process.env.KEEPALIVE_ENABLED === 'false') return;

  const interval = Number(process.env.KEEPALIVE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
    console.warn('[KeepAlive] Invalid KEEPALIVE_INTERVAL_MS, keep-alive disabled');
    return;
  }

  const globalStore = globalThis as typeof globalThis & { __keepAliveStarted?: boolean };
  if (globalStore.__keepAliveStarted) return;
  globalStore.__keepAliveStarted = true;

  const target = `${baseUrl.replace(/\/$/, '')}/api/version`;

  const ping = async () => {
    const startedAt = Date.now();
    try {
      const res = await fetch(target, { cache: 'no-store' });
      console.log(`[KeepAlive] ping ${res.status} in ${Date.now() - startedAt}ms`);
    } catch (error) {
      console.warn('[KeepAlive] ping failed:', error instanceof Error ? error.message : error);
    }
  };

  const scheduleNext = () => {
    const jitter = interval * 0.25;
    const delay = interval + (Math.random() * 2 - 1) * jitter;
    const timer = setTimeout(async () => {
      await ping();
      scheduleNext();
    }, delay);
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
  };

  // 启动 60 秒后先打一次，让实例在冷启动后立即恢复活跃
  const first = setTimeout(async () => {
    await ping();
    scheduleNext();
  }, 60 * 1000);
  if (typeof first.unref === 'function') first.unref();

  console.log(`[KeepAlive] enabled, interval ~${Math.round(interval / 1000)}s (jitter ±25%) -> ${target}`);
}
