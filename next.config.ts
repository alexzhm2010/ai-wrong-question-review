import type { NextConfig } from "next";

/**
 * GitHub Pages 静态导出配置。
 * 旧版的 output:'standalone'（Docker/Vercel 服务端）在这里不适用：
 * 静态导出不允许 API Routes、middleware 与服务端渲染时的数据读取，
 * 这些能力已迁移到 src/lib/supabase（fetch 桥接 + Supabase REST/Edge Function）。
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/ai-wrong-question-review";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  // GitHub Pages 以目录形式提供文件，必须生成 xxx/index.html
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
