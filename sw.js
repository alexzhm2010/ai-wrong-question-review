/*
 * 智能错题本 Service Worker
 *
 * 存在目的：满足浏览器「可安装 PWA」的判定条件，使 display: standalone 生效，
 * 从桌面图标启动时不再出现地址栏与底部工具栏。
 *
 * 刻意不缓存页面、API、Next.js 构建产物和 /version.json：历史上多次出现发版后
 * PWA 仍展示旧页面、必须强刷的问题。这里只缓存图标，其余请求一律网络直通。
 */
const CACHE_NAME = 'wrong-review-static-v1';
const ICON_PREFIX = '/ai-wrong-question-review/icons/';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }
    if (url.origin !== self.location.origin) return;

    if (url.pathname.startsWith(ICON_PREFIX)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(request);
            if (cached) return cached;
            const response = await fetch(request);
            if (response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })());
    }

    /*
     * 其余请求一律不接管。
     *
     * 之前这里写的是 respondWith(fetch(request))，看着等价，实际会吞掉
     * AbortSignal：Next 的分片预取靠 abort 取消旧请求，经过 SW 代理后中断
     * 传不进去，慢网下表现为「页面一直加载中，刷新几次偶尔好一次」。
     * 留一个空的 fetch 监听器就够满足 PWA 可安装条件了。
     */
});
