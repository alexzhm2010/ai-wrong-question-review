import type { Metadata, Viewport } from "next";
import { BASE_PATH, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase/config";
import "./globals.css";
import { Providers } from "@/components/providers";
import { PwaInstaller } from "@/components/pwa-installer";

export const viewport: Viewport = {
  themeColor: '#f97316',
  width: 'device-width',
  initialScale: 1,
  // standalone / 全面屏下让内容延伸到刘海与状态栏区域，避免顶部出现白边
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: "AI 错题复习平台",
  description: "基于AI的智能错题管理与复习平台，帮助学生高效整理、分析和复习错题",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'AI错题复习',
  },
  // Next 16 的 appleWebApp 只输出标准版 mobile-web-app-capable，iOS Safari 仍然只认
  // apple- 前缀。缺这一条时「添加到主屏幕」会退化成普通书签：从桌面图标打开照样带
  // 地址栏和底部工具栏，看起来就像全屏没生效。
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: `${BASE_PATH}/icons/icon.png`,
    apple: `${BASE_PATH}/icons/icon.png`,
  },
};

/**
 * 首屏提前取数（静态导出站点的关键优化）。
 *
 * 静态页要等 30 多个 JS 分片下载执行完（线上实测 ~9.9s）才会发出第一个
 * REST 请求。这段空窗期网络是闲着的。这里用一段 HTML 内联脚本在解析阶段
 * 就并行发出关键 GET，结果存到 window.__aqrPrefetch，core.ts 的 restRequest
 * 命中后直接使用，hydration 后组件零等待。
 *
 * 安全约束：只在 token 明显有效时发起；结果非 2xx 一律被 core.ts 忽略并
 * 走正常刷新流程，绝不会把 401 当成数据。anon key 与 URL 本来就是公开值。
 */
const PREFETCH_SCRIPT = `
(function(){
  try {
    var raw = localStorage.getItem('sb-static-session');
    if (!raw) return;
    var s = JSON.parse(raw);
    if (!s || !s.access_token || !s.expires_at || Date.now() > s.expires_at - 60000) return;
    var uid = '';
    try {
      var p = s.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      uid = JSON.parse(decodeURIComponent(escape(atob(p)))).sub || '';
    } catch (e) {}
    if (!uid) return;
    var base = ${JSON.stringify(SUPABASE_URL + "/rest/v1")};
    var key = ${JSON.stringify(SUPABASE_ANON_KEY)};
    var entries = {};
    window.__aqrPrefetch = { entries: entries };
    var headers = { 'apikey': key, 'Authorization': 'Bearer ' + s.access_token };
    function warm(path) {
      var url = base + path;
      entries[url] = fetch(url, { headers: headers })
        .then(function (r) { return r.text().then(function (t) { return { status: r.status, body: t }; }); })
        .catch(function () { return null; });
      return entries[url];
    }
    // User 是几乎所有接口的第一步，先发；拿到 User.id 后再并行取错题本与错题 id，
    // 这两条原本要严格排在 User 之后，现在与 hydration 同时进行。
    var userP = warm('/User?select=*&auth_user_id=eq.' + encodeURIComponent(uid) + '&limit=1');
    warm('/AppSetting?key=eq.app_config_public&select=value');
    userP.then(function (r) {
      if (!r || r.status !== 200) return;
      try {
        var rows = JSON.parse(r.body);
        var id = rows && rows[0] && rows[0].id;
        if (!id) return;
        var scope = 'userId=eq.' + encodeURIComponent(id);
        warm('/Subject?select=*&' + scope + '&order=createdAt.desc');
        warm('/ErrorItem?select=id,subjectId');
      } catch (e) {}
    });
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 提前完成 DNS / TLS / HTTP2 连接，省掉每个跨境请求的一次 RTT */}
        <link rel="preconnect" href={SUPABASE_URL} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href={SUPABASE_URL} />
        <script dangerouslySetInnerHTML={{ __html: PREFETCH_SCRIPT }} />
      </head>
      <body
        className="antialiased"
        suppressHydrationWarning={true}
      >
        <Providers>
          {children}
          <PwaInstaller />
        </Providers>
      </body>
    </html>
  );
}
