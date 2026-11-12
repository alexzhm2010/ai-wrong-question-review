import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/__tests__/setup.ts'],
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
        include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
        exclude: [
            'node_modules',
            '.next',
            'dist',
            /**
             * 静态迁移（GitHub Pages + Supabase 桥接层）之前的老测试：
             * 它们 import 的是已删除的 `src/app/api/**\/route.ts`、`src/middleware.ts`，
             * 依赖 Prisma / next-auth，收集阶段就会 ENOENT，整个套件因此长期是红的，
             * 真正的回归反而被淹没。统一归档到 legacy/，等有空按新架构重写。
             * 当前等价能力由 api-contract.test.ts（接口契约）+ 各 lib 单测覆盖。
             */
            'src/__tests__/legacy/**',
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/lib/**/*.ts', 'src/app/api/**/*.ts'],
            exclude: ['src/__tests__/**', 'node_modules/**'],
        },
    },
})
