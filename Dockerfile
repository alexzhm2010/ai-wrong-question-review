FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies based on the preferred package manager
COPY package.json package-lock.json ./
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Generate Prisma Client only (数据库迁移与初始化在容器启动时执行)
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

# Pre-compile runtime scripts FIRST (needed for tag seeding)
RUN npx tsc scripts/rebuild-system-tags.ts --outDir dist-scripts --esModuleInterop --resolveJsonModule --skipLibCheck --module commonjs --target ES2020

RUN npx prisma generate

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Uncomment the following line in case you want to disable telemetry during runtime.
ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies and create user
RUN apk add --no-cache su-exec openssl \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy Prisma CLI and engine files from builder
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

COPY --from=builder /app/public ./public

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy Prisma schema and migrations for runtime usage if needed (e.g. for migrations)
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Copy pre-compiled runtime scripts
COPY --from=builder --chown=nextjs:nodejs /app/dist-scripts ./dist-scripts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/seed-admin.js ./dist-scripts/scripts/seed-admin.js

# Copy entrypoint and optional HTTPS proxy
COPY --chown=nextjs:nodejs --chmod=755 docker-entrypoint.sh ./
COPY --chown=nextjs:nodejs https-server.js ./

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 数据库连接信息由部署环境注入（Supabase）
# 注：next-auth v4 不读取 AUTH_TRUST_HOST / AUTH_SECRET，请勿再设置这两个变量。
# 会话密钥使用 NEXTAUTH_SECRET，访问地址使用 NEXTAUTH_URL。

# Use entrypoint script to handle DB initialization
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
