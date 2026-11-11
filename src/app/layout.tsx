import type { Metadata, Viewport } from "next";
import { BASE_PATH } from "@/lib/supabase/config";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
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
