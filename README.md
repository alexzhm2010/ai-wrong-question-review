# AI 错题复习平台 · 静态版（GitHub Pages + Supabase）

一个基于 AI 的智能错题管理与复习平台。**这一版是纯静态前台**：整个站点由 Next.js 静态导出（`output: 'export'`）生成，托管在 GitHub Pages；数据持久化由 Supabase（Postgres + Auth + Edge Functions）承担，不再需要 Vercel / Render / Docker 等 Node 服务端。

> 本项目移植自 [wttwins/wrong-notebook](https://github.com/wttwins/wrong-notebook)（MIT License）。
> 本静态版是在原 Vercel 全栈版（`main` 分支历史）基础上迁移而来，**完整保留原有 42 个接口的业务语义与全部前端页面**。

## 架构

```
浏览器（GitHub Pages 静态文件）
  ├─ 页面 / 组件 / 交互逻辑：与 Vercel 版完全一致（214 个 src 文件）
  ├─ apiClient.get('/api/xxx')  ──►  fetch 桥接层（src/lib/supabase/bridge.ts）
  │                                    └─► 本地路由处理器（src/lib/supabase/routes/*）
  │                                          ├─ PostgREST  /rest/v1/*        数据 CRUD
  │                                          ├─ RPC        /rpc/*            注册 / 管理员操作
  │                                          └─ Edge Func  /functions/v1/*   AI 分析 / 批量导入
  ├─ Supabase Auth（password + refresh_token，会话存 localStorage）
  └─ PWA（manifest / sw.js / 图标，路径自动带 basePath）
```

关键点：**前端代码不需要知道后端已经换掉**。`window.fetch` 被桥接层接管，所有 `/api/*` 请求在本地翻译成 Supabase 调用并合成 Response 返回，因此旧版页面、组件、类型、状态管理全部沿用。

## 快速开始

```bash
npm ci
cp .env.example .env.local      # 填入 Supabase URL / publishable key
npm run dev                     # 本地开发（http://localhost:3000）
npm run pages:build             # 生成 out/（含 .nojekyll / 404 fallback / sw.js 修正）
```

把 `out/` 放到任意静态服务器即可访问；本地想按仓库子路径预览时设置 `NEXT_PUBLIC_BASE_PATH`。

## 发布到 GitHub Pages

1. 把**源码**推送到 `main` 分支（这次一定要推源码，不能只推构建产物）。
2. 仓库 **Settings → Pages** 选择 **Deploy from a branch → `gh-pages` / root**。
3. 可选：在 Settings → Secrets and variables → Actions 配置
   `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`（Secret）、`NEXT_PUBLIC_BASE_PATH`。
   不配置时会使用 `src/lib/supabase/config.ts` 中内置的现有项目地址。
4. 推送 `src/**`、`public/**`、`package*.json` 等变更会自动触发
   `.github/workflows/deploy-pages.yml`：`npm ci` → `npm run pages:build` → 把 `out/` 推到 `gh-pages` 分支。
   也可在 Actions 页手动 **Run workflow**。

> 首次运行会用新构建产物覆盖 `gh-pages` 分支上的旧文件，这是预期行为。

## 数据层

- 数据表沿用旧版 Prisma 模型名与列名（`User` / `Subject` / `ErrorItem` / `KnowledgeTag` / `PracticeRecord` / `AppSetting` 等），由 RLS 按 `auth.uid()` 隔离。
- AI 密钥不落前端：`ai-proxy` Edge Function 持有 `AI_API_KEY`，前端只发 `{action, payload}`。
- 注册、管理员增删用户、重置数据走 `SECURITY DEFINER` 的 RPC 函数。
- **现有线上 Supabase 项目及数据保持不变**，重建后的前端直接接回即可；只有迁移到全新项目时才需要执行 `supabase/schema.sql` 并部署 `supabase/functions/`。

## 目录

| 路径 | 说明 |
|---|---|
| `src/lib/supabase/config.ts` | 项目地址 / key / basePath / 版本 |
| `src/lib/supabase/core.ts` | 会话、PostgREST、RPC、Edge Function 封装 |
| `src/lib/supabase/session.tsx` | 兼容 `next-auth/react` 的 Supabase Auth 会话层 |
| `src/lib/supabase/bridge.ts` | `window.fetch` 拦截与请求分发 |
| `src/lib/supabase/routes/*` | 按业务域实现的 42 个接口处理器 |
| `supabase/schema.sql` | 灾备 / 新环境用的表、RLS、RPC |
| `supabase/functions/*` | Edge Function 参考实现 |
| `scripts/prepare-pages.mjs` | `.nojekyll` / `404.html` / sw.js 修正 |
| `doc/STATIC_DEPLOY.md` | 完整迁移与部署说明、功能对照、已知差异 |

## 说明

详细的迁移对照、部署步骤与已知降级点见 **[doc/STATIC_DEPLOY.md](doc/STATIC_DEPLOY.md)**。
