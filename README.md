# AI 错题复习平台 · 静态版（GitHub Pages + Supabase）

面向 K12 学生的 AI 智能错题管理与复习平台。前端由 Next.js 静态导出
（`output: 'export'`）生成，托管在 GitHub Pages；账号、数据与 AI 推理由
Supabase（Postgres + Auth + Edge Functions）承担，无需自建 Node 服务端。

> 版权与第三方许可：主版权见 [LICENSE](LICENSE)，第三方组件与历史来源声明见
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 架构

```
浏览器（GitHub Pages 静态文件）
  ├─ 页面 / 组件 / 交互逻辑
  ├─ apiClient.get('/api/xxx')  ──►  fetch 桥接层（src/lib/supabase/bridge.ts）
  │                                    └─► 本地路由处理器（src/lib/supabase/routes/*）
  │                                          ├─ PostgREST  /rest/v1/*        数据 CRUD
  │                                          ├─ RPC        /rpc/*            注册 / 管理员操作
  │                                          └─ Edge Func  /functions/v1/*   AI 分析 / 批量导入
  ├─ Supabase Auth（password + refresh_token，会话存 localStorage）
  └─ PWA（manifest / sw.js / 图标，路径自动带 basePath）
```

关键点：页面通过统一的 `apiClient` 访问 `/api/*`，桥接层在浏览器内把请求翻译为
Supabase 调用并合成标准 `Response` 返回，因此更换后端不需要改动页面代码。

## 快速开始

```bash
npm ci
cp .env.example .env.local      # 填入 Supabase URL / publishable key
npm run dev                     # 本地开发（http://localhost:3000）
npm run pages:build             # 生成 out/（含 .nojekyll / 404 fallback / sw.js 修正）
```

把 `out/` 放到任意静态服务器即可访问；本地想按仓库子路径预览时设置 `NEXT_PUBLIC_BASE_PATH`。

## 发布到 GitHub Pages

1. 把**源码**推送到 `main` 分支。
2. 仓库 **Settings → Pages** 选择 **Deploy from a branch → `gh-pages` / root**。
3. 可选：在 Settings → Secrets and variables → Actions 配置
   `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`（Secret）、`NEXT_PUBLIC_BASE_PATH`。
   不配置时会使用 `src/lib/supabase/config.ts` 中内置的现有项目地址。
4. 推送 `src/**`、`public/**`、`package*.json` 等变更会自动触发
   `.github/workflows/deploy-pages.yml`：`npm ci` → `npm run pages:build` → 把 `out/` 推到 `gh-pages` 分支。
   也可在 Actions 页手动 **Run workflow**。

> 首次运行会用新构建产物覆盖 `gh-pages` 分支上的旧文件，这是预期行为。

## 数据层

- 数据表由 `supabase/schema.sql` 定义，RLS 按 `auth.uid()` 隔离用户数据。
- AI 密钥不落前端：`ai-proxy` Edge Function 持有密钥，前端只发 `{action, payload}`。
- 注册、管理员增删用户、重置数据走 `SECURITY DEFINER` 的 RPC 函数。
- 迁移到全新 Supabase 项目时执行 `supabase/schema.sql` 并部署 `supabase/functions/`。

## 目录

| 路径 | 说明 |
|---|---|
| `src/lib/supabase/config.ts` | 项目地址 / key / basePath / 版本 |
| `src/lib/supabase/core.ts` | 会话、PostgREST、RPC、Edge Function 封装 |
| `src/lib/supabase/session.tsx` | 兼容 `next-auth/react` 的会话层 |
| `src/lib/supabase/bridge.ts` | `window.fetch` 拦截与请求分发 |
| `src/lib/supabase/routes/*` | 按业务域实现的接口处理器 |
| `supabase/schema.sql` | 表、RLS、RPC |
| `supabase/functions/*` | Edge Function 实现 |
| `scripts/prepare-pages.mjs` | `.nojekyll` / `404.html` / sw.js 修正 |
| `doc/STATIC_DEPLOY.md` | 完整部署说明与已知差异 |

## 说明

详细的部署步骤与已知降级点见 **[doc/STATIC_DEPLOY.md](doc/STATIC_DEPLOY.md)**。
