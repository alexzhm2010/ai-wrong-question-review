/**
 * 轻量结构化日志。
 * 静态版没有服务端日志采集，这里只做分级控制台输出，保持统一的调用形状。
 */
type LogContext = { [key: string]: unknown };

export interface Logger {
  trace: (ctx: LogContext | string, msg?: string) => void;
  debug: (ctx: LogContext | string, msg?: string) => void;
  info:  (ctx: LogContext | string, msg?: string) => void;
  warn:  (ctx: LogContext | string, msg?: string) => void;
  error: (ctx: LogContext | string, msg?: string) => void;
  fatal: (ctx: LogContext | string, msg?: string) => void;
  child: (bindings: LogContext) => Logger;
  box: (title: string, content?: string | LogContext, emoji?: string) => void;
  divider: (char?: string) => void;
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  if (process.env.LOG_LEVEL && process.env.LOG_LEVEL in LEVELS) {
    return LEVELS[process.env.LOG_LEVEL as Level];
  }
  return process.env.NODE_ENV === 'production' ? LEVELS.warn : LEVELS.debug;
}

function emit(level: Level, scope: string, first: LogContext | string, second?: string) {
  if (LEVELS[level] < threshold()) return;
  const text = typeof first === 'string' ? first : (second ?? '');
  const extra = typeof first === 'string' ? undefined : first;
  const line = scope ? `[${scope}] ${text}` : text;
  const fn = level === 'trace' || level === 'debug' ? console.debug
           : level === 'warn' ? console.warn
           : level === 'error' || level === 'fatal' ? console.error
           : console.log;
  if (extra) fn(line, extra); else fn(line);
}

function build(scope: string, bindings: LogContext): Logger {
  const write = (level: Level) => (first: LogContext | string, second?: string) => {
    const merged = typeof first === 'string'
      ? (Object.keys(bindings).length ? { ...bindings } : undefined)
      : { ...bindings, ...first };
    emit(level, scope, (merged ?? first) as LogContext | string, typeof first === 'string' ? second : undefined);
  };
  return {
    trace: write('trace'), debug: write('debug'), info: write('info'),
    warn: write('warn'), error: write('error'), fatal: write('fatal'),
    child: (b: LogContext) => build(scope, { ...bindings, ...b }),
    box: (title: string, content?: string | LogContext) => {
      if (LEVELS.info < threshold()) return;
      console.log(`┌─ ${title} ─`);
      if (content) console.log(typeof content === 'string' ? `│ ${content}` : content);
      console.log('└─');
    },
    divider: (char = '─') => { if (LEVELS.debug >= threshold()) console.log(char.repeat(40)); },
  };
}

export const logger = build('app', { env: process.env.NODE_ENV });
export function createLogger(module: string): Logger { return build(module, {}); }
