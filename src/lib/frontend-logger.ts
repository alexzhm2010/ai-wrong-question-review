/**
 * 浏览器侧诊断日志。
 *
 * 2026-11-21 之前这里只在控制台输出、内存保留，数据库 frontend_logs 表形同空壳，
 * 导致线上必现的 150s 崩溃事后完全无从排查。现在 error / warn 级别会额外
 * fire-and-forget 上报到 /api/logs/frontend（写库的路由早已存在），并严格脱敏：
 *   - 不上传任何 imageBase64 / 图片 / 长文本 details；
 *   - details 只保留标量，键名命中敏感词的直接剔除；
 *   - 上报失败完全静默，绝不影响主流程。
 */

type Level = 'info' | 'warn' | 'error';
type Details = Record<string, unknown>;

export interface LogOptions { sendToBackend?: boolean }

interface Record_ { at: string; level: string; scope: string; text: string; details?: Details }

const CAPACITY = 50;
/** 单次会话最多上报多少条，防止异常时日志洪水 */
const MAX_REPORTS = 40;
/** 需要从 details 中剔除的敏感键（图片、密钥、令牌、base64 等） */
const SENSITIVE_KEY = /image|base64|photo|file|token|secret|apikey|api_key|password|credential|authorization|rawdata|payload/i;

let reportCount = 0;

/** 把 details 收敛成可安全上报的标量字典：敏感键剔除，非标量丢弃，值截断 */
function sanitizeDetails(details?: Details): Details {
    const out: Details = {};
    if (!details || typeof details !== 'object') return out;
    for (const [key, value] of Object.entries(details)) {
        if (SENSITIVE_KEY.test(key)) continue;
        if (typeof value === 'string') out[key] = value.slice(0, 300);
        else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
        else if (value === null) out[key] = null;
        // 对象/数组一律不上传（可能内嵌图片或大 payload）
    }
    return out;
}

/** fire-and-forget 上报；任何失败都静默吞掉 */
function report(level: Level, scope: string, text: string, details?: Details) {
    if (level === 'info') return; // 只上报 warn / error
    if (typeof window === 'undefined') return;
    if (reportCount >= MAX_REPORTS) return;
    reportCount += 1;
    try {
        void fetch('/api/logs/frontend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                level,
                message: `${scope} ${text}`.slice(0, 2000),
                context: sanitizeDetails(details),
            }),
            keepalive: true,
        }).catch(() => {});
    } catch {
        /* 上报失败绝不影响主流程 */
    }
}

class BrowserDiagnostics {
    private recent: Record_[] = [];

    private push(level: Level, scope: string, text: string, details?: Details) {
        this.recent.push({ at: new Date().toISOString(), level, scope, text, details });
        if (this.recent.length > CAPACITY) this.recent.shift();
        const line = `${scope} ${text}`;
        if (level === 'error') console.error(line, details ?? '');
        else if (level === 'warn') console.warn(line, details ?? '');
        else console.log(line, details ?? '');
        report(level, scope, text, details);
    }

    info(scope: string, text: string, details?: Details, _options: LogOptions = {}) { this.push('info', scope, text, details); }
    warn(scope: string, text: string, details?: Details, _options: LogOptions = {}) { this.push('warn', scope, text, details); }
    error(scope: string, text: string, details?: Details, _options: LogOptions = {}) { this.push('error', scope, text, details); }

    /** 保留给页面卸载等场景调用；当前为 fire-and-forget，无需刷新。 */
    forceFlush() { /* no-op: 已即时上报 */ }
    getRecent() { return [...this.recent]; }
}

export const frontendLogger = new BrowserDiagnostics();
