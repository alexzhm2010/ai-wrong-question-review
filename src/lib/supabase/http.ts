/** fetch 桥接层与路由处理器共用的 HTTP 辅助（单独成文件避免循环依赖） */

export interface RouteContext {
  method: string;
  /** 去掉 basePath 后的完整路径，如 /api/error-items/c123 */
  path: string;
  /** path 去掉 /api/ 后按 / 切分的片段 */
  parts: string[];
  query: URLSearchParams;
  body: any;
  signal?: AbortSignal;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response | null> | Response | null;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function apiError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, message, ...extra }, status);
}
