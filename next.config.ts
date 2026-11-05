import type { NextConfig } from "next";

// Docker 构建使用 standalone 产物；Vercel 由其平台自行打包，无需 standalone
const nextConfig: NextConfig = {
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
};

export default nextConfig;
