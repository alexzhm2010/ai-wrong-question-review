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

## 8. 「参考答案」与「解析思路」结论不一致（前端 v1.18.1 + ai-proxy v3）

**现象**：一道题的「参考答案」写 `(1/2, 2]`，而「解析思路」分步推导到最后的「综上」得到 `[-1, 1/2)`。数学上后者正确，前者是把不等号方向写反后叠加定义域上限的结果。

**根因**：`answerText` 与 `analysis` 是 AI 一次响应里两个**独立**字段。原提示词把 `<answer_text>` 排在 `<analysis>` 之前（先写结论、后推导），又要求「解析一次成型、结论写出后立即收尾、禁止追加复核段落」，导致模型在写答案时还没展开分情况讨论、反了号，之后也无法在解析里回头修正。前端把两个字段原样并列渲染，没有任何一致性校验。这与数据库权限、RLS 无关——数据库只是如实存了 AI 返回的两个矛盾字段。

**前端兜底（已上线，无需任何额外权限）**：`src/lib/answer-consistency.ts` 保守地从解析末尾的总结句提取最终区间表达式，与答案比对；不一致时在「参考答案」卡片显示醒目告警，并提供「采用解析结论」按钮，由用户确认后一键替换（绝不静默覆盖）。检测只在「解析末尾能提取到明确结论」且「答案里的区间不在该结论里」时触发，宁可漏报不误报。首次解析、重新解题、打开历史错题都会生效。

**根治（已部署，2026-11-11）**：线上 `ai-proxy` 已从 **version 2 升级到 version 3**，`verify_jwt` 保持开启、匿名调用仍返回 401。

一个此前容易踩的坑：线上真实函数是**多文件结构**（`index.ts` + `lib/prompts.ts` + `lib/response-guard.ts` + `lib/mistake-status.ts`，提示词与输出护栏 100% 复用主仓库 `src/lib/ai`），而仓库里原先那份 `supabase/functions/ai-proxy/index.ts` 只是简化的单文件灾备副本，**两者不是同一份代码**。本次部署前先用 Management API 的 `Get a function body` 把线上 ESZIP 产物里的 `sourcesContent` 完整还原成源码，再基于线上真实版本做最小改动，避免覆盖掉线上已有的 `verifyUser()` 用户 JWT 校验。仓库的 `supabase/functions/ai-proxy/` 现已同步为线上真实版本（4 个文件），以后从仓库部署不会再有差异。

改动只有两处：

| 文件 | 改动 |
|---|---|
| `lib/prompts.ts` | `DEFAULT_ANALYZE_TEMPLATE` 与 `DEFAULT_REANSWER_TEMPLATE`：要求 `<analysis>` 末尾用 `<final_answer>` 写出唯一最终结论（必须含完整区间/解集），`<answer_text>` 必须逐字复制它；放宽原先「禁止回头改判 / 禁止复核」两条纪律中会把错误答案固化的部分 |
| `index.ts` | `parseResponse()` 从解析里提取 `<final_answer>`，用它覆盖 `answerText`；标签本身由既有 `stripLeakedTags()` 剥离，正文只留结论；模型未输出该标签时保持原样，由前端一致性守卫兜底 |

**安全降级**：不重排标签顺序（避免牵动作答判定段与流式截断逻辑），不静默猜测——只有模型明确给出 `<final_answer>` 时才覆盖，否则一律沿用原答案并靠前端告警提示人工确认。

部署方式：`SUPABASE_ACCESS_TOKEN=<PAT> supabase functions deploy ai-proxy --project-ref sheoajxitvznnjlfyugq`。也可在 Dashboard → Edge Functions → `ai-proxy` 的编辑器里粘贴同样的改动后点 Deploy。

> 注意：`sb_publishable_*` / anon key 是公开的**前端**密钥，本来就已内联在静态产物里。它能读公开配置，但不能写业务表、不能改提示词、更不能部署 Edge Function。重新部署需要 Supabase 账号的 **Personal Access Token**（当前 scoped token 前缀为 `sbp_fc...`，老的全权限 token 为 `sbp_...` 并被标记 Legacy），或直接在 Dashboard 操作。PAT 是账号级凭据，请在 Dashboard 里按最小权限（单项目 + `Edge Functions` Read-write）与短过期创建，用完立即撤销。

## 9. LaTeX 反斜杠被吞 + 解析行文啰嗦（v1.18.2，2026-11-11）

**现象 A**：解析里出现 `3otin[-2,2]`，本意是 `$3 \notin [-2,2]$`。

**根因**：`src/components/markdown-renderer.tsx` 为了把 AI 偶发返回的字面 `\n` 转成真实换行，做了 `.replace(/\\n/g, '\n')`。但 `\notin`、`\neq`、`\nabla`、`\nsubseteq` 等 LaTeX 命令都以 `\n` 开头，反斜杠被吃掉后就变成 `otin` / `eq` / `abla`。

**修复**：新增纯函数 `src/lib/markdown-preprocess.ts`。先把 `$...$` / `$$...$$` 数学区整体暂存为占位符，等所有基于换行的段落归一化规则跑完再原样还原；数学区外仍处理字面 `\n`，但用 `(?![a-zA-Z])` 保护未包裹的 LaTeX 命令。顺带修正了旧「紧贴中文补空格」正则会把相邻两个公式之间的正文误配成定界符的问题（改为按真实公式边界逐个判断）。单测 `src/__tests__/unit/markdown-preprocess.test.ts` 覆盖真实案例、多命令、字面 `\n` 回归、块级公式、紧贴定界符等 11 项。

**现象 B**：解析里出现「等等——这里有个关键遗漏！」「但注意！」「但还需验证」「当 $m=-2$ 呢？」这类边想边改的自我复盘口吻。这是上一版为避免固化错误答案而放宽「禁止复核」纪律后的副作用——模型把端点核验、定义域检查写成了事后补记和设问。

**修复**：两份提示词模板（`src/lib/ai/prompts.ts` 设置页默认值、`supabase/functions/ai-proxy/lib/prompts.ts` 线上函数）同步改为：

- 自检改为**静默完成**，其结果直接写成解析里的常规推导步骤；
- 新增【解析行文结构】：前提 → 分步推导 → 边界核验（陈述句）→ `<final_answer>` 结论，一次成型；
- 输出纪律新增口语化转折 / 自问自答禁用清单，并明确 `<final_answer>` 之后不得再有任何文字；
- 保留「发现判断有误时静默改到正确路径并同步修正 `<final_answer>`」的纠错能力，**不固化错误答案**。

两份文件现已完全一致（此前前端副本缺少 `<final_answer>` 相关纪律，用户在设置页「恢复默认」会退回旧模板）。线上 `ai-proxy` 已从 **v3 升级到 v4**（`status ACTIVE`、`verify_jwt=true`）。单测 `src/__tests__/unit/prompt-discipline.test.ts` 校验两份一致性、结构要求、禁用词与纠错能力。

## 10. 参考答案与解析结论再次矛盾（v1.18.3，2026-11-11）

**现象**：新截图里参考答案写成 `(-1/2, 1/2]`，解析第三步推导出的却是 `[-1, 1/2)`；v1.18.1 的琥珀色告警卡片没有出现，v1.18.2 的解析行文收敛也未见效果（「但需注意」「然而，还需验证端点」仍在）。

**为什么 v1.18.1 / v1.18.2 都没修好**：两版都在试图约束「模型怎么写」，而模型行为不可控。

- 根子是**让 AI 把最终结论写两遍**：`<analysis>` 正文推导一次，末尾 `<final_answer>` 再独立写一次；服务端 `answerText = finalAnswer || rawAnswer` 无条件采信第二遍，并把 `<answer_text>` 直接丢弃。只要第二遍抄错端点或开闭（`(1/2,2]`、`(-1/2,1/2]` 两次事故同源），参考答案就会和解析正文矛盾。
- **守卫漏报**：旧 `tailConclusion` 只扫「最后一个总结词之后的 240 字」。这次解析末尾是「所以 m=-1 满足条件」，没有区间表达式，提取不到结论，用截图真实文本实测返回 `conflict: false`。
- **提示词是软约束**：`enableThinking: isMath` 开启时模型把思维链里的「但需注意」「然而，还需验证」原样带进正文。线上核对确认 v4 函数确实含新纪律文本，说明不是「没部署」，而是「部署了也不生效」。

**修复：把答案的真相源从 AI 输出换成解析正文（确定性）**

- 新增同源模块 `src/lib/answer-consistency.ts` / `supabase/functions/ai-proxy/lib/answer-consistency.ts`：
  - `findConclusionExpr()` 全文扫描「结论语境 + 区间」并取最后一次命中；要求引导词与区间紧邻，因此 `g(x)` 在 `[-2,0]` 递增、`g` 在 `[0,2]` 递减这类前提/性质区间不会被误当结论；解析末尾补多少文字都不影响。
  - `deriveAnswerFromAnalysis()` 三方交叉校验：模型答案是区间且解析里能提取到结论时，若两者不一致，**以解析结论为准覆盖参考答案**，并回传 `answerSource=analysis` / `answerConflict` / `originalAnswerText`；一致或提取不到时原样返回。非区间答案（选择题、数值、文字）一律不覆盖。
  - `detectAnswerConflict()` 前端守卫改用全文提取，不再只看最后一句；对历史错题仍能提示并一键采用。
- `parseResponse()` 不再无条件采信 `<final_answer>`；该标签降级为引导模型收束结论的信号，不再是答案来源。覆盖时保留模型答案的 `$` 定界符，避免前端 KaTeX 失去公式渲染。
- 前端告警文案由「解析末尾结论」改为「解析推导结论」。

**验证**：`src/__tests__/unit/answer-source.test.ts` 18 项（含本次截图真实文本、上次事故回归、前提区间不误取、非区间答案不覆盖、`$` 定界符保留、端到端模拟完整 XML 响应）与原有 `answer-consistency.test.ts` 6 项全部通过；Edge Function esbuild 打包校验、`npm run pages:build` 18 个静态页均通过。线上 `ai-proxy` v4 → v5。

**边界**：这是服务端确定性逻辑，对该函数之后的所有 AI 输出生效，不依赖模型是否听话；但**历史已入库的错题不会被自动改写**，需在编辑页由增强后的守卫提示，或点「重新解题」重新生成。
