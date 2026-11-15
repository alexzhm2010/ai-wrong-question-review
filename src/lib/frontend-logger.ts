/**
 * 浏览器侧诊断日志。
 * 静态版不采集用户日志，这里只在控制台输出，并在内存里保留最近若干条便于排查。
 */

type Level = 'info' | 'warn' | 'error';
type Details = Record<string, unknown>;

export interface LogOptions { sendToBackend?: boolean }

interface Record_ { at: string; level: Level; scope: string; text: string; details?: Details }

const CAPACITY = 50;

class BrowserDiagnostics {
  private recent: Record_[] = [];

  private push(level: Level, scope: string, text: string, details?: Details) {
    this.recent.push({ at: new Date().toISOString(), level, scope, text, details });
    if (this.recent.length > CAPACITY) this.recent.shift();
    const line = `${scope} ${text}`;
    if (level === 'error') console.error(line, details ?? '');
    else if (level === 'warn') console.warn(line, details ?? '');
    else console.log(line, details ?? '');
  }

  info(scope: string, text: string, details?: Details, _options: LogOptions = {}) { this.push('info', scope, text, details); }
  warn(scope: string, text: string, details?: Details, _options: LogOptions = {}) { this.push('warn', scope, text, details); }
  error(scope: string, text: string, details?: Details, _options: LogOptions = {}) { this.push('error', scope, text, details); }

  /** 保留给页面卸载等场景调用；内存缓冲无需网络刷新。 */
  forceFlush() { /* no-op: 无远端采集 */ }
  getRecent() { return [...this.recent]; }
}

export const frontendLogger = new BrowserDiagnostics();
