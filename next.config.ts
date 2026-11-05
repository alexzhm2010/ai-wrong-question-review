import type { NextConfig } from "next";

// Docker / 自托管需要 standalone 产物；Vercel 由其平台自行打包，无需 standalone
const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
};

export default nextConfig;
