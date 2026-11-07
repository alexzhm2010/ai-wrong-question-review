# P0 安全修复 · 实施报告

> **归档说明**：本报告记录 v1.9.1 第一期 P0 安全审查问题的修复对照，修复代码已合入本仓库。

- **对象**：`alexzhm2010/ai-wrong-question-review` v1.9.1
- **依据**：`doc/security/P0-security-review.md`（第一期审查，13 项问题）
- **变更规模**：31 个文件，`+937 / -331`；新增 1 个文件 `src/lib/ssrf-guard.ts`
- **校验**：`npx tsc --noEmit` 无错误；`npx vitest run` **32 个测试文件 / 508 个用例全部通过**
- **补丁**：`P0-fixes.patch` 为本地生成的差异文件，未随仓库提交；修复已直接合入代码

---

## 1. 逐项修复对照

| 编号 | 级别 | 文件 | 修复做法 |
|---|---|---|---|
| B-01 | Blocker | `src/app/api/ai/models/route.ts`、`src/components/ui/model-selector.tsx` | 改为 **POST + JSON body**（密钥不再进 URL query）；加登录 + admin 校验；`baseUrl` 经 SSRF 白名单校验；出站 fetch 禁重定向 + 10s 超时；上游失败返回 502 而非伪装 200；错误详情不回显 |
| B-02 | Blocker | `src/app/api/ai/test/route.ts` | 加 admin 校验；表单传入的 `baseUrl`/`endpoint` 全部经 `assertSafeOutboundUrl()` 校验后才交给 Provider；顶层异常返回固定文案 |
| C-01 | Critical | `src/app/api/error-items/[id]/notes/route.ts` | `update({where:{id}})` → `updateMany({where:{id,userId}})`，原子校验归属；无匹配返回 404；补 `userNotes` 类型校验 |
| C-02 | Critical | `src/app/api/practice/generate/route.ts` | `findUnique({where:{id}})` → `findFirst({where:{id,userId:session.user.id}})`；补 `errorItemId` 非空校验 |
| H-01 | High | `src/app/api/error-items/route.ts` | 创建时 `subjectId` 用 `findFirst({where:{id,userId}})` 验归属，不匹配返回 403（与 `PUT /[id]` 一致） |
| H-02 | High | `src/app/api/tags/stats/route.ts` | 加登录校验 + `where:{userId}`；不再返回全站错题总数 |
| H-03 | High | `src/app/api/openclaw/batch-upload/route.ts` | apikey 模式身份改由服务端 `OPENCLAW_SERVICE_USER_EMAIL` 绑定，忽略请求体 `userEmail`；`createErrorItem` 内校验 `subjectId` 归属，不匹配则不写入 |
| H-04 | High | `src/lib/config.ts`、`src/app/api/register/route.ts` | 出厂默认 `allowRegistration: false`；注册接口加按 IP 的进程内限流（5 次/小时）；导出 `resetRegisterRateLimit()` 供测试隔离 |
| M-01 | Medium | `src/app/api/logs/frontend/route.ts` | 加登录校验；单批 ≤50 条、消息 ≤2000 字符；`context` 改为 6 个字段白名单并记录 `userId` |
| M-02 | Medium | `src/middleware.ts` | **把 `/api` 纳入 matcher**；公开端点白名单（`/api/auth/*`、`/api/register*`、`/api/version`、`/api/openclaw/*`）；鉴权异常 **fail-closed**（API→503 JSON，页面→登录页）；API 未登录返回 401 JSON 而非 302；admin 页面与 `/api/admin/*` 统一拦截；显式 `NextResponse.next()`；cookie 读取改为「固定名优先 + 默认名回退」 |
| M-03 | Medium | `src/app/api/admin/system-reset/route.ts`、`src/components/settings-dialog.tsx` | 服务端独立校验请求体 `confirm === 'RESET'`，前端把已输入的确认串一并提交 |
| L-01 | Low | `ai/models`、`ai/test`、`src/app/api/reanswer/route.ts` | 不再回显 `error.message`；reanswer 只透传 5 个标准 AI 错误码，其余返回 `AI_UNKNOWN_ERROR` |
| L-02 | Low | `openclaw/batch-upload/route.ts` | `apiKey` 比较改为 SHA-256 后 `crypto.timingSafeEqual`（常量时间、等长） |

### 顺带修掉的已确认正确性缺陷

- `src/lib/api-client.ts`：`...rest` 覆盖内部 `signal` 导致超时失效；现在把外部 signal 链接到内部 `AbortController`，内部 signal 放在最后。
- `src/lib/auth.ts`：移除 `@ts-expect-error` 强塞的 `trustHost: true`（**已核实** `next-auth@4.24.13` 全包无 `trustHost` 定义，属 v5 幻觉配置）；同步去掉日志里的 `AUTH_TRUST_HOST`。
- `src/app/api/export/route.ts`：`{ userId: { not: undefined } }` 是无效过滤，改为空 `where`，与其它表的 `userFilter` 语义一致。
- `.env.example`：新增 `OPENCLAW_SERVICE_USER_EMAIL`、`AI_ALLOW_PRIVATE_ENDPOINTS` 说明；标注 `AUTH_TRUST_HOST` 在 v4 不生效。

### 新增模块 `src/lib/ssrf-guard.ts`

`assertSafeOutboundUrl(raw)`：强制 HTTPS、拒绝 URL 内嵌凭据与本地主机名、用 `dns.lookup(all)` 解析后拒绝任何私有/保留 IP（含 IPv4 私有段、CGNAT、链路本地/云元数据 `169.254`、IPv6 ULA/ll/mapped），清除 query/fragment 但**保留 pathname**（兼容 DashScope 等带路径前缀的 OpenAI 兼容端点）。提供 `AI_ALLOW_PRIVATE_ENDPOINTS=true` 逃生开关用于公司内网 AI 网关。

---

## 2. 测试同步

原有测试大量断言旧行为（中间件返回 `null`/`undefined`、settings 返回明文密钥、模型列表伪装成功等），已全部迁移到新契约，并补了安全回归用例：

- `models-route.test.ts` 重写为 POST 契约：401/403、内网 baseUrl 拒绝（且不发 fetch）、502 而非 200、禁重定向。
- `middleware.test.ts`：新增「公开 API 放行」「未登录 API 返回 401 JSON」「非 admin 403」「admin 放行」「异常 fail-closed」。
- `error-items.test.ts` / `practice.test.ts` / `tags.test.ts`：新增越权回归断言（查询必须带 `userId`，不匹配不得触发 AI 调用或写入）。
- 修正 `settings.test.ts` 缺失的 `next-auth` mock、`seed-admin.test.ts` 缺失的 vitest 导入、`gemini-retry.test.ts` 的 `afterEach` 与超时（Provider 使用 1s/2s/4s 退避）。

结果：**508/508 通过，`tsc --noEmit` 零错误**。

---

## 3. 部署前必须注意（行为变更）

1. **`OPENCLAW_SERVICE_USER_EMAIL` 必填**：仅当 `OPENCLAW_AUTH_MODE=apikey` 时。未配置时批量上传接口会直接返回 500（fail-closed），不再接受请求体 `userEmail`。建议建专用服务账号。
2. **注册默认关闭**：首个管理员仍由 `npm run db:seed` 创建的 `admin@localhost` 担任；如需开放注册，由管理员在设置页手动开启。
3. **`/api/ai/models` 从 GET 改为 POST**：`apiKey`/`baseUrl` 移到 JSON body。本项目前端已同步；如有外部脚本直接调该接口，需一并修改。
4. **`/api/admin/system-reset` 需要 `{ "confirm": "RESET" }`**。
5. **中间件现在拦截所有 `/api`**：若有新增的公开端点，需加入 `src/middleware.ts` 的 `PUBLIC_API_PREFIXES`。`/api/logs/frontend` 现在要求登录，登录页的前端日志会被丢弃（静默失败）。
6. **自托管 AI 网关在内网时**需设 `AI_ALLOW_PRIVATE_ENDPOINTS=true`，并自行承担 SSRF 风险。

---

## 4. 残余风险（未纳入本次修复）

- **DNS rebinding**：`assertSafeOutboundUrl` 校验后若 DNS 被改指向内网仍可绕过；彻底防护需在 HTTP 客户端固定已校验 IP 或在出站防火墙封禁元数据网段。
- **限流为进程内 Map**：serverless 多实例下各实例独立计数，公网部署仍需在网关层叠加限流。
- **`tags/stats` 仍全表拉回内存**统计 JSON 列；数据量增大后应迁移到 `KnowledgeTag` 关联表的数据库侧聚合。
- **间隔复习 `ReviewSchedule` + `scheduler.ts` 仍是零调用的半成品**（第二期范围）。
- AI 消耗型端点（`/analyze`、`/reanswer`）尚未加按用户配额/速率限制。
- 文档 `doc/PROJECT_OVERVIEW.md`、`doc/operational_flow.md` 仍停留在 v1.5.5 / SQLite / JSON mode 的旧描述，未同步。

---

## 5. 提交状态

- 本地：`git init` 完成，两个 commit 已生成，工作区干净。
- 远端：通过 `push_to_github.py` 以 `api.github.com` Git Data API 基于远端 `main` HEAD 创建单个提交（**保留完整历史、不 force push**）；默认推 `fix/p0-security` 分支，可用 `--main` 直接更新主分支。
- 写入凭据：通过 GitHub OAuth device flow 获取，令牌只在进程内存中使用，不落盘、不打印。
