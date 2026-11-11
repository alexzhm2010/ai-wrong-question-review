# 静态版迁移与部署指南

## 1. 为什么要这样迁移

Vercel / Render 版是 Next.js 全栈应用：42 个 `src/app/api/**` 路由 + Prisma + PostgreSQL + NextAuth，必须跑 Node 服务端。GitHub Pages 只提供静态文件，不能执行服务端代码。

迁移采取**「前端零改动、后端整体搬迁」**的策略：

1. 保留全部页面、组件、状态管理与工具函数（214 个 `src` 文件里的前端部分）。
2. 删除 `src/app/api/**`、`src/middleware.ts`（静态导出不允许）。
3. 新增 `src/lib/supabase/bridge.ts`，在浏览器里接管 `window.fetch`：所有 `/api/*` 请求不再发到服务器，而是交给本地路由处理器。
4. 路由处理器按业务域拆分，用 Supabase 的三种能力复刻原服务端逻辑：
   - **PostgREST**（`/rest/v1/*`）→ 原来的 Prisma CRUD
   - **RPC**（`/rpc/*`）→ 注册、管理员增删用户、重置数据等特权操作
   - **Edge Functions**（`/functions/v1/*`）→ AI 分析、重新解题、练习生成、批量导入
5. 认证从 NextAuth 换成 Supabase Auth，但保留 `useSession` / `signIn` / `signOut` / `SessionProvider` 的调用签名，页面无需改动。
6. `next.config.ts` 改为 `output: 'export'` + `basePath` + `trailingSlash`。

## 2. 接口对照（42 个 → 处理器）

| 旧接口 | 静态版实现位置 | Supabase 能力 |
|---|---|---|
| `/api/version` | `routes/misc.ts` | 本地常量 |
| `/api/settings` GET/POST | `routes/misc.ts` | `AppSetting` 表（公开读 / 管理员写） |
| `/api/user`、`/api/user/last-grade` | `routes/misc.ts` | `User` / `ErrorItem` 表 |
| `/api/notebooks`、`/api/notebooks/:id` | `routes/notebooks.ts` | `Subject` 表 |
| `/api/error-items`（含 list / batch-delete / clear / :id / mastery / notes / geogebra / delete） | `routes/error-items.ts` | `ErrorItem` + `_ErrorItemToKnowledgeTag` + `KnowledgeTag` |
| `/api/tags`、`/tags/stats`、`/tags/suggestions` | `routes/tags.ts` | `KnowledgeTag` 表（树形组装） |
| `/api/analytics` | `routes/tags.ts` | `ErrorItem` 聚合 |
| `/api/stats/practice`、`/stats/practice/clear` | `routes/practice.ts` | `PracticeRecord` 表 |
| `/api/practice/record`、`/practice/generate` | `routes/practice.ts` | 表 + `ai-proxy` |
| `/api/export`、`/api/import` | `routes/practice.ts` | `ErrorItem` / `Subject` 批量读写 |
| `/api/analyze`、`/reanswer`、`/geogebra-analyze`、`/ai/test`、`/ai/models` | `routes/ai.ts` | `ai-proxy` Edge Function |
| `/api/ai-quota` | `routes/ai.ts` | `quota_snapshot` 表 |
| `/api/register`、`/register/status` | `routes/misc.ts` | `rpc/register_user` + 公开配置 |
| `/api/admin/*`（dashboard / users / migrate-tags / system-reset） | `routes/admin.ts` | `User` 表 + RPC |
| `/api/logs/frontend` | `routes/misc.ts` | `frontend_logs` 表 |
| `/api/openclaw/batch-upload` | `routes/misc.ts` | `openclaw-upload` Edge Function |
| `/api/auth/*` | `routes/auth.ts` | Supabase Auth 兼容端点 |

未命中的次要端点返回 `{success:true, stub}` 占位，避免旧代码抛错。

## 3. Supabase 侧依赖

**现有线上项目已全部具备，恢复前端代码时无需改动数据库。**

- 表：`User`、`Subject`、`ErrorItem`、`KnowledgeTag`、`_ErrorItemToKnowledgeTag`、`ReviewSchedule`、`PracticeRecord`、`AppSetting`、`frontend_logs`、`quota_snapshot`。列名沿用 Prisma 的 camelCase。
- RLS：所有业务表按 `auth.uid() → "User".auth_uid` 隔离；`AppSetting` 的 `app_config_public` 行匿名可读、仅管理员可写。
- RPC：`register_user`、`admin_create_user`、`admin_delete_user`、`reset_user_data`。
- Edge Functions：`ai-proxy`（`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` 等 Secrets）、`openclaw-upload`。

迁移到**全新** Supabase 项目时：执行 `supabase/schema.sql`，部署 `supabase/functions/` 下的函数，配置 Edge Function Secrets，然后修改 `.env.local` / CI 变量指向新项目。

> ⚠️ 不要对现有库重复执行 `schema.sql` 的 CREATE 语句，会与已有对象冲突并可能危及数据。

## 4. 发布步骤

1. **推源码**：把本项目源码提交并推送到 GitHub 仓库的 `main` 分支（昨天的问题就是只推了 `gh-pages` 分支的构建产物，源码没进仓库）。
2. **Pages 设置**：Settings → Pages → Build and deployment → **Deploy from a branch** → `gh-pages` / `root`。
3. **CI 变量**（可选）：Settings → Secrets and variables → Actions
   - Variables：`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_BASE_PATH`（`/ai-wrong-question-review`）
   - Secrets：`NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - 不配置时使用 `src/lib/supabase/config.ts` 的内置默认值。
4. **触发**：推送 `src/**` 等变更自动触发 `deploy-pages.yml`，或在 Actions 手动运行。工作流执行 `npm ci` → `npm run pages:build` → 把 `out/` 推送到 `gh-pages` 分支。
5. 等待约 1–2 分钟，访问 `https://<user>.github.io/<repo>/`。

`scripts/prepare-pages.mjs` 会处理 GitHub Pages 的三个坑：
- `.nojekyll`：否则 Jekyll 会丢弃 `_next/` 目录导致白屏；
- `404.html`：复制首页内容，兼容不带尾斜杠的深层路由；
- `sw.js`：图标缓存路径补上 basePath。

## 5. 本地验证

```bash
npm ci
npm run pages:build
npx serve out            # 或任意静态服务器
```

`NEXT_PUBLIC_BASE_PATH` 设为 `/` 时可在根路径预览；保持仓库子路径时，静态服务器需要把 `out/` 挂到同名子目录下。

## 6. 功能对照与已知差异

| 能力 | 状态 |
|---|---|
| 错题录入 / AI 识别 / 解析 / 知识点标签 | ✅ 保留（`ai-proxy` 返回完整结果） |
| 多错题本、筛选分页、掌握状态、笔记、打印导出、导入导出 | ✅ 保留 |
| 智能练习、统计图表、管理员后台、用户注册/登录 | ✅ 保留 |
| PWA 安装、流式进度条、多语言、响应式 | ✅ 保留 |
| AI 逐段打字动画 | ⚠️ 取决于线上 `ai-proxy`；参考实现只发一条 `done`（结果完整，无逐段 delta） |
| GeoGebra 动态演示 | ⚠️ 静态版曾降级为占位；已改为转发 `geogebra_analyze`，Edge Function 未启用时返回空命令 |
| `/api/admin/migrate-tags` | ⚠️ 静态版无需标签迁移，返回 `migrated: 0` |
| 阿里云余额实时查询 | ⚠️ 改为读取 `quota_snapshot` 快照表（密钥不再落前端） |

## 7. 安全提示

- `NEXT_PUBLIC_*` 值会内联进静态产物，属于**公开值**。数据隔离依赖 RLS，AI 厂商密钥依赖 Edge Function Secrets，切勿把 service_role key 或 AI API Key 放进 `NEXT_PUBLIC_*`。
- 部署前确认 RLS 已对所有业务表启用，且 `anon` 角色没有越权策略。
- 若更换 Supabase 项目，旧项目的数据需要自行导出迁移。

## 8. 「参考答案」与「解析思路」结论不一致（v1.18.1）

**现象**：一道题的「参考答案」写 `(1/2, 2]`，而「解析思路」分步推导到最后的「综上」得到 `[-1, 1/2)`。数学上后者正确，前者是把不等号方向写反后叠加定义域上限的结果。

**根因**：`answerText` 与 `analysis` 是 AI 一次响应里两个**独立**字段。原提示词把 `<answer_text>` 排在 `<analysis>` 之前（先写结论、后推导），又要求「解析一次成型、结论写出后立即收尾、禁止追加复核段落」，导致模型在写答案时还没展开分情况讨论、反了号，之后也无法在解析里回头修正。前端把两个字段原样并列渲染，没有任何一致性校验。这与数据库权限、RLS 无关——数据库只是如实存了 AI 返回的两个矛盾字段。

**前端兜底（已上线，无需任何额外权限）**：`src/lib/answer-consistency.ts` 保守地从解析末尾的总结句提取最终区间表达式，与答案比对；不一致时在「参考答案」卡片显示醒目告警，并提供「采用解析结论」按钮，由用户确认后一键替换（绝不静默覆盖）。检测只在「解析末尾能提取到明确结论」且「答案里的区间不在该结论里」时触发，宁可漏报不误报。首次解析、重新解题、打开历史错题都会生效。

**根治（需要重新部署线上 `ai-proxy`）**：仓库里的 `supabase/functions/ai-proxy/index.ts` 已改成「单一真相源」——提示词要求模型在 `analysis` 末尾输出 `<final_answer>` 作为唯一结论、`answerText` 必须逐字复制它；服务端 `reconcileAnalysisResult()` 用该标签覆盖 `answerText` 并从解析正文移除标签。要把这份改动同步到线上，需要 Supabase 的**部署途径**（Supabase Dashboard 的 Edge Functions 编辑器，或 `supabase functions deploy ai-proxy` + Supabase access token）。

> 注意：`sb_publishable_*` / anon key 是公开的**前端**密钥，本来就已内联在静态产物里。它能读公开配置，但不能写业务表、不能改提示词、更不能部署 Edge Function。重新部署需要 Supabase 账号的部署凭据（`sbp_...` access token）或直接在 Dashboard 操作，不是 publishable key。
