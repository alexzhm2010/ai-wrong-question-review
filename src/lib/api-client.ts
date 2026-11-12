type RequestOptions = RequestInit & {
    params?: Record<string, string>;
    timeout?: number; // 超时时间（毫秒），默认 60000
};

/**
 * 站内切换的 stale-while-revalidate 缓存。
 *
 * 静态站点每次切页都要重新走一整轮 REST；对「配置/标签/用户」这类变化不频繁的
 * GET，命中缓存时立即返回旧数据（<1ms 出内容），同时后台静默刷新缓存。
 * 列表与批次状态接口不缓存，任何写操作成功后清空全部缓存，避免显示脏数据。
 */
const GET_CACHE_TTL = 15_000;
const getCache = new Map<string, { at: number; data: unknown }>();
const CACHE_SKIP_PREFIXES = [
    "/api/error-items/list",
    "/api/error-items/images",
    "/api/batch/",
    "/api/admin/",
];
const cacheable = (url: string) =>
    !CACHE_SKIP_PREFIXES.some((p) => url.startsWith(p));

export class ApiError extends Error {
    constructor(public status: number, public statusText: string, public data: unknown) {
        super(`API Error: ${status} ${statusText}`);
        this.name = 'ApiError';
    }
}

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const { params, headers, timeout = 60000, ...rest } = options;

    let finalUrl = url;
    if (params) {
        const searchParams = new URLSearchParams(params);
        finalUrl += `?${searchParams.toString()}`;
    }

    const defaultHeaders: HeadersInit = {
        'Content-Type': 'application/json',
    };

    // 创建 AbortController 用于超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // 若调用方也传了 signal，把它链接到内部控制器，而不是让它覆盖超时控制。
    // 原实现把 ...rest 放在 signal 之后，外部 signal 会直接顶掉内部超时，
    // 导致首页 AI 分析的超时设置实际失效。
    const externalSignal = rest.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
        const res = await fetch(finalUrl, {
            ...rest,
            headers: {
                ...defaultHeaders,
                ...headers,
            },
            // 内部控制器必须放在最后，保证超时始终生效
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onExternalAbort);

        if (!res.ok) {
            let errorData;
            try {
                errorData = await res.json();
            } catch {
                errorData = await res.text();
            }
            throw new ApiError(res.status, res.statusText, errorData);
        }

        // Handle empty responses (e.g. 204 No Content)
        if (res.status === 204) {
            return {} as T;
        }

        try {
            return await res.json();
        } catch {
            // If JSON parse fails but response was OK, return text or empty object?
            // For now, assume JSON APIs.
            return {} as T;
        }
    } catch (error) {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', onExternalAbort);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new ApiError(408, 'Request Timeout', {
                message: 'AI_TIMEOUT_ERROR'
            });
        }
        throw error;
    }
}

/** 任何写操作成功后让 GET 缓存失效，避免列表/详情显示刚被改过的旧数据 */
const invalidate = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => { getCache.clear(); return v; });

const get = <T>(url: string, options?: RequestOptions): Promise<T> => {
    const useCache = cacheable(url) && !options?.params;
    if (useCache) {
        const hit = getCache.get(url);
        if (hit && Date.now() - hit.at < GET_CACHE_TTL) {
            // 立即出旧数据；后台静默刷新，供下一次访问使用
            void request<T>(url, { method: 'GET' })
                .then((fresh) => getCache.set(url, { at: Date.now(), data: fresh }))
                .catch(() => {});
            return Promise.resolve(hit.data as T);
        }
    }
    return request<T>(url, { ...options, method: 'GET' }).then((data) => {
        if (useCache) getCache.set(url, { at: Date.now(), data });
        return data;
    });
};

export const apiClient = {
    get,
    post: <TResponse, TBody = any>(url: string, body: TBody, options?: RequestOptions) =>
        invalidate(request<TResponse>(url, { ...options, method: 'POST', body: JSON.stringify(body) })),
    put: <TResponse, TBody = any>(url: string, body: TBody, options?: RequestOptions) =>
        invalidate(request<TResponse>(url, { ...options, method: 'PUT', body: JSON.stringify(body) })),
    patch: <TResponse, TBody = any>(url: string, body: TBody, options?: RequestOptions) =>
        invalidate(request<TResponse>(url, { ...options, method: 'PATCH', body: JSON.stringify(body) })),
    delete: <T>(url: string, options?: RequestOptions) =>
        invalidate(request<T>(url, { ...options, method: 'DELETE' })),
};
