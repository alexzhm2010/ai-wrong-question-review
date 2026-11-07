# 代码审查报告

> **归档说明**：本报告是 v1.9.1 时期的第一期 P0 安全审查快照，记录的 13 项问题已在后续提交中修复。修复对照见 `doc/security/P0-fixes-report.md`，请以当前代码为准。

## 0. 概览

- **审查对象**：`ai-wrong-question-review` v1.9.1（本仓库）
- **审查范围**：第一期 P0 专项 —— 鉴权/越权（IDOR）与 SSRF。逐文件通读 `src/middleware.ts`、`src/lib/auth.ts`、`src/lib/config.ts`、`src/lib/api-errors.ts` 及 `src/app/api/` 下全部 42 个 `route.ts`。第二期（正确性、性能、架构、测试）未纳入本报告。
- **技术栈**：Next.js 16 App Router + React 19 + NextAuth v4（JWT session）+ Prisma 5.22 + PostgreSQL
- **审查方式**：静态代码追溯（输入点 → Prisma 查询 / 出站 `fetch`），未运行服务、未连数据库。所有「需验证」项均明确标注。
- **总体结论**：**存在阻断问题，不建议以当前状态部署到公网多用户环境。**
- **问题统计**：Blocker ×2，Critical ×2，High ×4，Medium ×3，Low ×2（共 13 项）

### 根因

`src/middleware.ts:71` 的 matcher 为 `"/((?!api|_next/static|_next/image|favicon.ico).*)"`，**把 `/api` 整体排除在统一鉴权之外**。因此 42 个 API 路由必须各自重复 `getServerSession` + 查库 + 判归属。凡漏写任意一环，该端点即暴露。本报告的 Blocker/Critical/High 项基本都是这一根因的具体表现，而非彼此独立的偶发 bug。

另有一个放大器：`src/lib/config.ts:92` 的 `allowRegistration: true`（`register/status/route.ts:7` 亦以 `!== false` 判定），注册接口 `register/route.ts:16-66` 无邮箱验证、无速率限制。**匿名者自建一个账号即可满足所有「需登录」漏洞的前置条件**，因此这些漏洞的实际利用门槛接近未鉴权。

---

## 1. 问题清单（按优先级排序）

### [B-01] `/api/ai/models` 完全无鉴权，且 `baseUrl`/`apiKey` 由请求参数决定 → SSRF + 密钥外泄

- **位置**：`src/app/api/ai/models/route.ts:68-102`（关键行：70-73、85-90、19、44-51、98）
- **维度**：安全性
- **严重程度**：**Blocker**
- **现状**：

```ts
// :68-90  整个 GET 没有任何 getServerSession
const { searchParams } = new URL(req.url);
const apiKey = searchParams.get('apiKey');      // :72 密钥走 query string
const baseUrl = searchParams.get('baseUrl');    // :73 出站地址完全可控
const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1';
models = await fetchOpenAIModels(apiKey, effectiveBaseUrl);

// :19  Gemini 分支把密钥拼进 URL
const url = `${baseUrl}/v1beta/models?key=${apiKey}`;
// :44-51 OpenAI 分支向任意主机发送带凭据的请求
const response = await fetch(`${baseUrl}/models`, {
  headers: { 'Authorization': `Bearer ${apiKey}`, ... },
});
```

- **风险**：① 未鉴权的 SSRF —— 可令服务端向 `127.0.0.1`、`10.x`、`169.254.169.254`（云元数据）等发起带自定义 header 的请求，`fetchOpenAIModels` 会解析响应 JSON、`fetchGeminiModels:27` 会把 `errorText` 写入日志、`:98` 把 `error.message` 回显给调用方，构成可盲打的探测通道；② `apiKey` 经 GET query 明文传输，会落在反向代理访问日志、浏览器历史、Referer 中；③ 攻击者可把 `baseUrl` 指向自己控制的服务器，反向诱骗客户端把密钥发过去。
- **改进建议**（三处同时改，缺一不可）：

```ts
// src/app/api/ai/models/route.ts
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getAppConfig } from '@/lib/config';

const ALLOWED_HOSTS = new Set(['api.openai.com', 'generativelanguage.googleapis.com']);

function assertSafeBaseUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('Only https is allowed');
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error('Host not in allowlist');
  if (/^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)) {
    throw new Error('Private address is not allowed');
  }
  return u;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'admin')
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const instanceId = searchParams.get('instanceId');   // 只接受实例 ID，不接受 URL / 密钥
  const config = await getAppConfig();
  const instance = config.openai?.instances?.find(i => i.id === instanceId);
  if (!instance) return NextResponse.json({ error: 'Unknown instance' }, { status: 400 });

  assertSafeBaseUrl(instance.baseUrl);
  return NextResponse.json({ models: await fetchOpenAIModels(instance.apiKey, instance.baseUrl) });
}
```

> 补充：`ALLOWED_HOSTS` 只解决「显式内网地址」。完整 SSRF 防护还需处理 DNS rebinding（解析后校验 IP 并固定连接目标）与重定向（设置 `redirect: 'manual'`）。若部署在云上，应同时在出站防火墙层封禁元数据地址。

- **验证方式**：修复前，在测试环境匿名请求 `GET /api/ai/models?provider=openai&apiKey=test&baseUrl=http://127.0.0.1:PORT/models`，观察服务端是否向本地端口发起连接；修复后该请求应返回 401（未登录）/ 403（非 admin）/ 400（非法实例），且服务端不产生任何对外连接。另确认访问日志中不再出现 `apiKey=`。

---

### [B-02] `/api/ai/test` 登录后仍可指定任意 `baseUrl`/`endpoint` → 认证后 SSRF

- **位置**：`src/app/api/ai/test/route.ts:94-107`（校验）、`:127`、`:136`、`:147-153`（把地址传入 Provider）
- **维度**：安全性
- **严重程度**：**Blocker**（结合 H-04 注册默认开放，实际门槛≈匿名）
- **现状**：`:97-100` 只校验 `session?.user` 存在；`:103` 从 body 解构 `baseUrl`、`endpoint`；随后直接构造 `new OpenAIProvider({ apiKey, baseUrl, model })`、`new AzureOpenAIProvider({ apiKey, endpoint, ... })`，由 Provider 向该地址发起带 `Authorization` 的出站请求。`:246` 还会把 `error.message` 原样返回。
- **风险**：与 B-01 同类，但攻击者可携带**服务端配置中的真实 API Key** 向任意地址发起请求（设置页可读取配置后回填），或通过错误码差异（`parseErrorCode`，`:16-70` 对 `ECONNREFUSED`/`ETIMEDOUT` 等有区分）做内网端口与服务指纹探测。这实质是一个带响应判别的 SSRF 探针。
- **改进建议**：服务端强制忽略请求体中的 `baseUrl`/`endpoint`，只从 `getAppConfig()` 已保存的实例读取；若确需「临时测试未保存的配置」，则复用 B-01 的 `assertSafeBaseUrl()` 并把权限收窄到 admin；`fetch` 增加 `redirect: 'manual'` 与超时；`:246` 改为返回固定文案 + 内部 `errorId`，不回显 `error.message`。
- **验证方式**：以普通注册账号 POST `/api/ai/test`，`baseUrl` 指向 `http://127.0.0.1:1`，观察返回的错误码是否为 `AI_CONNECTION_FAILED`（说明服务端确实发起了连接）；修复后应返回 400/403 且不发起连接。

---

### [C-01] `PATCH /api/error-items/[id]/notes` 缺归属校验 → 任意登录用户可篡改他人笔记（IDOR）

- **位置**：`src/app/api/error-items/[id]/notes/route.ts:29-38`
- **维度**：安全性 / 正确性
- **严重程度**：**Critical**
- **现状**：

```ts
// :15-27 只确认「有这个人」
const session = await getServerSession(authOptions);
...
if (!user) return unauthorized("Authentication required");
const { userNotes } = await req.json();
// :31-38 直接按 id 更新，where 中没有 userId
const errorItem = await prisma.errorItem.update({
  where: { id: id },
  data: { userNotes: userNotes },
});
```

- **风险**：已知或可枚举的 `id` 即可覆写任意用户的 `userNotes`。这是明确的越权写入（CWE-639）。
- **关键对照证据**（证明是遗漏而非设计）：同一批端点都做了 owner 校验 ——
  - `error-items/[id]/route.ts:47-49`（GET）、`:89-91`（PUT）
  - `error-items/[id]/mastery/route.ts:31-43`
  - `error-items/[id]/delete/route.ts:29-40`
  - `error-items/[id]/geogebra/route.ts:42-44`
- **改进建议**（用 `updateMany` 把归属条件放进 `where`，原子且避免 TOCTOU）：

```ts
const result = await prisma.errorItem.updateMany({
  where: { id, userId: user.id },
  data: { userNotes },
});
if (result.count === 0) return notFound('Item not found');
return NextResponse.json({ id, userNotes });
```

- **验证方式**：在测试环境建 A、B 两个账号，用 A 的会话 `PATCH /api/error-items/<B的错题id>/notes`，修复前返回 200 且 B 的笔记被改；修复后应返回 404（或 403）。

---

### [C-02] `POST /api/practice/generate` 可用任意 `errorItemId` 读取他人题目并消耗服务端 AI 配额

- **位置**：`src/app/api/practice/generate/route.ts:22-27`、`:41-47`
- **维度**：安全性 / 性能
- **严重程度**：**Critical**
- **现状**：

```ts
const { errorItemId, language, difficulty } = await req.json();   // :22 id 完全来自 body
const errorItemWithSubject = await prisma.errorItem.findUnique({
  where: { id: errorItemId },          // :24-27 无 userId 条件
  include: { subject: true }
});
...
const similarQuestion = await aiService.generateSimilarQuestion(
  errorItemWithSubject.questionText || "",   // :42 把他人题目内容送进 AI
  ...
);
return NextResponse.json(similarQuestion);  // :54 返回结果
```

- **风险**：① 越权读取他人错题内容（题目文本、知识点、年级、学科会以「相似题」形式间接返回）；② 每次调用都触发一次真实的 AI 推理，且 `:17-19` 只校验登录、无配额/速率限制，可被用来刷爆 API 账单。
- **改进建议**：

```ts
const errorItemWithSubject = await prisma.errorItem.findFirst({
  where: { id: errorItemId, userId: session.user.id },  // id 来自 auth.ts:104 的 token.id
  include: { subject: true },
});
if (!errorItemWithSubject) return notFound('Item not found');
```

  同时对 AI 生成类端点（`/analyze`、`/reanswer`、`/practice/generate`、`/geogebra-analyze`）加基于用户的速率限制。
- **验证方式**：用 A 的会话 POST `{"errorItemId":"<B的错题id>"}`，修复前应返回基于 B 题目生成的相似题；修复后返回 404。

---

### [H-01] `POST /api/error-items` 的 `subjectId` 不验归属 → 可把错题写入他人错题本

- **位置**：`src/app/api/error-items/route.ts:117`、`:173`
- **维度**：安全性
- **严重程度**：**High**
- **现状**：`:117` 仅 `subject.findUnique({ where: { id: subjectId } })` 用于推断学科；`:173` 直接 `subjectId: subjectId || undefined` 落库，全程未比较 `subject.userId`。
- **关键对照证据**：`error-items/[id]/route.ts:102-109`（PUT 移动错题本）明确写了：

```ts
const targetSubject = await prisma.subject.findUnique({ where: { id: subjectId } });
if (!targetSubject || targetSubject.userId !== user.id) {
  return forbidden("Not authorized to move to this notebook");
}
```

  同一资源的编辑路径校验了、创建路径没校验 —— 典型的复制粘贴遗漏。
- **改进建议**：`:117` 改为 `findFirst({ where: { id: subjectId, userId: user.id } })`，并在 `subjectId` 非空而查询为空时返回 `forbidden(...)`。
- **验证方式**：用 A 的会话提交带 B 的 `subjectId` 的新错题，修复后应返回 403。

---

### [H-02] `GET /api/tags/stats` 无鉴权，且全表跨用户聚合

- **位置**：`src/app/api/tags/stats/route.ts:14-21`、`:48-52`
- **维度**：安全性 / 性能
- **严重程度**：**High**
- **现状**：整个文件没有 `getServerSession`；`:17-21` 为 `prisma.errorItem.findMany({ select: { knowledgePoints: true } })`，**无 `where`**，扫描全库所有用户；`:50` 还返回 `total: errorItems.length`（全站错题总数）。
- **风险**：匿名即可获取全站知识点分布与业务规模；且随数据增长，每次请求把全表拉进内存做 `JSON.parse` 统计，是明确的慢查询/内存隐患。
- **改进建议**：加登录校验 + `where: { userId }`；更优做法是用数据库侧聚合替代全表 `findMany`（如把知识点统计改为按标签关联表 `groupBy`，或对统计结果做缓存）。
- **验证方式**：匿名 `GET /api/tags/stats`，修复后应返回 401。

---

### [H-03] `/api/openclaw/batch-upload` 在 API Key 模式下由请求体决定「以谁的身份写入」

- **位置**：`src/app/api/openclaw/batch-upload/route.ts:214-237`、`:284`、`:314-317`、`:366-372`、`:120`
- **维度**：安全性 / 架构
- **严重程度**：**High**（需持有集成 API Key，故未定 Blocker）
- **现状**：当 `OPENCLAW_AUTH_MODE=apikey` 且配置了 `OPENCLAW_INTEGRATION_API_KEY` 时：

```ts
// :236-237  身份与目标错题本均由请求体指定
userEmail = requestData.userEmail;
subjectId = requestData.subjectId;
// :314-317 按这个 email 查用户
dbUser = await prisma.user.findUnique({ where: { email: userEmail } });
// :366-372 以该用户身份建错题
createErrorItem(dbUser.id, base64, mimeType, openclawResponse.data, subjectId);
// :120 subjectId 同样只查存在性，不查 userId
const subject = subjectId ? await prisma.subject.findUnique({ where: { id: subjectId } }) : null;
```

- **风险**：一把全局集成 Key 即可冒充**任意用户（含 admin）**写入错题，并挂到任意错题本，无需知道该用户密码。密钥一旦泄露，影响面是「全库可写」而非「单点可写」。此外 credentials 模式（默认）下 `:272` 的 `compare(password, user.password)` 无失败次数限制，可在线暴力破解。
- **改进建议**：① 不允许请求体指定 `userEmail`，改为由服务端把 API Key 映射到固定用户（如 `OPENCLAW_SERVICE_USER_EMAIL`）；② `createErrorItem` 内对 `subjectId` 用 `findFirst({ where: { id: subjectId, userId } })` 校验归属；③ 给两种认证模式都加限流；④ `OPENCLAW_API_URL`（`:56`）默认 `http://localhost:8080`，属本机假设，部署时需在启动时显式校验。
- **验证方式**：在测试环境设 `apikey` 模式，POST 时把 `userEmail` 填成另一个账号，修复后该请求应被拒绝或始终落到绑定账号。

---

### [H-04] 注册默认开放且无验证/限流，放大上述所有「需登录」漏洞

- **位置**：`src/lib/config.ts:92`、`src/app/api/register/route.ts:16-66`、`src/app/api/register/status/route.ts:7`
- **维度**：安全性 / 配置
- **严重程度**：**High**（本身是配置默认值，作为风险放大器定级）
- **现状**：`allowRegistration: true` 为出厂默认；注册只需 `email`（正则 `^[^\s@]+@[^\s@]+$`）、`password`（≥6 位）、`name`，无邮箱验证、无验证码、无速率限制，成功后立即可登录。
- **风险**：把 C-01/C-02/H-01/B-02 的门槛从「已有账号」降为「花几秒注册一个」，并使 `/analyze`、`/reanswer` 等 AI 端点成为可匿名刷的计费入口。
- **改进建议**：默认值改为 `allowRegistration: false`，由管理员在设置页显式开启；对注册接口加 IP/邮箱维度限流；如面向家庭/小团队使用，优先改成「管理员创建账号」。
- **验证方式**：全新安装后匿名 POST `/api/register`，修复后应返回 403。

---

### [M-01] `POST /api/logs/frontend` 无鉴权、无条数上限 → 日志伪造与资源耗尽

- **位置**：`src/app/api/logs/frontend/route.ts:28-63`
- **维度**：安全性 / 性能
- **严重程度**：**Medium**
- **现状**：`:28` POST 无鉴权；`:33` `logs` 数组无长度校验；`:35-61` 逐条写入后端 logger；`:45` 用 `...context` 把用户可控对象整体展开进日志上下文。
- **风险**：匿名者可伪造任意 `level`/`prefix`/`message`/`context` 污染审计日志，或一次性提交超大数组打满日志配额/磁盘。
- **改进建议**：加登录校验；限制 `logs.length <= 50`、单条 `message.length <= 2000`；`context` 改为字段白名单而非展开；对该端点单独限流。

---

### [M-02] 中间件在异常时 fail-open，且 `isAuthPage` 分支返回 `null`

- **位置**：`src/middleware.ts:31-37`、`:56-59`、`:62-73`
- **维度**：架构 / 安全性
- **严重程度**：**Medium**（是本报告多项问题的结构性根因）
- **现状**：

```ts
if (isAuthPage) {
    if (isAuth) return NextResponse.redirect(new URL("/", req.url));
    return null;                       // :36 middleware 返回 null 语义不清
}
...
} catch (e) {
    logger.error({ error: e }, 'Error processing token');
    return NextResponse.next();        // :58 鉴权异常 → 直接放行（fail-open）
}
```

- **风险**：`getToken` 在密钥缺失/损坏/cookie 异常时抛错，页面级鉴权即被整体绕过；`return null` 依赖框架对空返回值的隐式处理，Next 版本升级后行为可能改变。叠加 matcher 排除 `/api`，等于「页面层可能放行、API 层全靠自觉」。
- **改进建议**：catch 分支改为 **fail-closed**（重定向到 `/login` 或返回 500），`isAuthPage` 分支显式 `return NextResponse.next()`；把 `/api` 纳入 matcher，用 `PUBLIC_API_PREFIXES` 白名单放行 `/api/auth/*`、`/api/register*`、`/api/version`、`/api/openclaw/*`（后者自带认证）。**注意**：中间件只能统一解决「是否登录」，**不能替代路由内的 owner 校验** —— C-01/C-02/H-01 仍须逐条修。
- **验证方式**：临时置空 `NEXTAUTH_SECRET` 后访问 `/notebooks`，修复后应跳登录页而非渲染页面。

---

### [M-03] `/api/admin/system-reset` 单次 POST 不可逆清空全库且删除其他用户

- **位置**：`src/app/api/admin/system-reset/route.ts:39-73`（尤其 `:65-71`）
- **维度**：可维护性 / 运维安全
- **严重程度**：**Medium**
- **现状**：admin 校验存在且正确（`:19-21`），但事务内 `practiceRecord.deleteMany({})`、`errorItem.deleteMany({})`、`subject.deleteMany({})`、`knowledgeTag.deleteMany({ isSystem:false })` 全库清空，并 `user.deleteMany({ email: { not: session.user.email } })` 删除除自己外的所有用户。无 confirm token、无 dry-run、无前置备份、无二次确认。代码注释（`:22-34`）显示这是有意的「Factory Reset」设计。
- **风险**：误触或 CSRF 触发即造成不可逆的全租户数据丢失。
- **改进建议**：要求请求体携带一次性确认串（如输入 `RESET` 或项目名）；执行前自动调用导出逻辑生成备份快照；改为 POST + 幂等键；记录审计日志。这是设计加固建议，不是已确认漏洞。

---

### [L-01] 错误信息回显内部细节

- **位置**：`ai/models/route.ts:98`、`ai/test/route.ts:246`、`reanswer/route.ts:50-61`
- **严重程度**：**Low**
- **现状**：把 `error.message` 原样作为响应体返回，可能含上游地址、端点、网络错误细节。
- **改进建议**：对外返回固定文案 + 内部 `errorId`，详情只写服务端日志。

---

### [L-02] 集成 API Key 使用非常量时间字符串比较

- **位置**：`openclaw/batch-upload/route.ts:226`
- **严重程度**：**Low**
- **现状**：`if (apiKey !== expectedApiKey)` 为普通字符串比较，理论上存在时序侧信道。
- **改进建议**：改用 `crypto.timingSafeEqual`（注意先做等长处理）。实际风险低，可随 H-03 一并处理。

---

## 2. 六维审查小结

| 维度 | 结论 | 备注 |
|------|------|------|
| 正确性 | ⚠️ | 本期只覆盖鉴权相关正确性：C-01/C-02/H-01 的越权写入会污染数据；`api-client.ts:36-37` 的 `signal` 被 `...rest` 覆盖导致超时失效，属范围外，留待第二期 |
| 可读性 | ⚠️ | 42 个路由重复「getServerSession → 按 email 查 user → 判空」样板，既冗长又容易漏写归属判断；已有 `auth-utils.ts` 但只提供 `requireAdmin` |
| 性能 | ⚠️ | `tags/stats` 全表加载；AI 类端点（`analyze`/`reanswer`/`practice/generate`）无速率限制，可被刷计费 |
| 安全性 | ❌ | 2 个 Blocker、2 个 Critical、4 个 High，且中间件 fail-open + 注册默认开放使门槛进一步降低 |
| 可维护性 | ⚠️ | 同一资源的创建/编辑路径鉴权不一致（H-01 对照证据）；错误处理混用 `api-errors.ts` 与手写 `NextResponse.json` |
| 架构合理性 | ❌ | 缺统一的服务端鉴权与授权层；出站请求无 URL 白名单；「验登录」与「验归属」两个概念在代码里未分离 |

> 本期未评估：AI Provider 实现正确性、React 组件状态管理、Prisma 查询性能全貌、测试覆盖率、文档一致性。

---

## 3. AI 生成代码专项发现

逐条核对专家清单 7 项，以下为**在可见代码中确认或需验证**的项：

1. **幻觉式配置假设**：`src/lib/auth.ts:15` 用 `@ts-expect-error` 强行加入 `trustHost: true`，注释称「trustHost is a valid option in newer NextAuth versions but types might be lagging」。项目使用 **NextAuth v4**（`NextAuthOptions`），而 `trustHost` 是 Auth.js v5 的配置项；`:129` 日志里读的 `AUTH_TRUST_HOST` 同样是 v5 环境变量。**需验证**：查 `package.json` 中 `next-auth` 版本及 `node_modules/next-auth` 类型定义，确认该字段在 v4 是否被忽略。若被忽略，`NEXTAUTH_URL` 相关的代理部署假设需重新核对。此处标注「需验证」，不臆造结论。
2. **边界情况遗漏**：`logs/frontend/route.ts:33` 数组无上限；`ai/models/route.ts:98` 捕获异常后返回 **HTTP 200 + 空 models**（注释「allow manual input」），把错误伪装成成功，前端无法区分「无模型」与「请求失败」。
3. **错误处理假象**：`src/middleware.ts:58` 鉴权异常 `return NextResponse.next()`（见 M-02）；`src/lib/config.ts:164-167` 读配置失败时静默返回 `DEFAULT_CONFIG`，可能把用户已关闭的注册开关、已配置的 AI 实例悄悄重置为默认值，属静默降级。
4. **冗余与重复逻辑**：`error-items/[id]/route.ts:129-135` 手写字符串匹配推断学科（只认 math/english/other），与 `inferSubjectFromName`（`src/lib/knowledge-tags.ts`）并存且结论可能不一致；三家 Provider 的 `extractTag`/`handleError` 复制三份（本期未展开，属第二期）。
5. **配置与环境假设**：`config.ts:98` 默认 `OPENAI_BASE_URL` 指向 `dashscope.aliyuncs.com`、默认模型 `qwen3-vl-plus`，与 README 描述的 OpenAI 不一致；`openclaw/batch-upload/route.ts:56` 默认 `http://localhost:8080`。二者均需部署时显式覆盖。
6. **无效的过滤条件**：`export/route.ts:56` 的 `{ errorItem: { userId: { not: undefined } } }` 中 `not: undefined` 在 Prisma 里等价于不加约束（admin 全量导出场景下结果虽符合预期，但写法无效，易误导后续维护）。
7. **虚构 API / 错误依赖引用**：本期范围内**未发现**不存在的 import 或方法调用；`auth.ts:15` 的 `trustHost` 是唯一的疑似项，已列入「需验证」。

> **已核实并排除的疑似问题（避免误报）**：
> - `GET /api/settings` 的密钥掩码是安全的 —— `maskConfig`（`settings/route.ts:15-29`）覆盖 `gemini.apiKey`、`azure.apiKey`、`openai.instances[].apiKey`；且 `config.ts:125-137` 的 `mergeConfig()` 每次重建 `openai` 对象只保留 `instances`/`activeInstanceId`，遗留的顶层 `openai.apiKey`（`config.ts:47-51` 的 Legacy 类型）不会经 `getAppConfig()` 流出。POST 另有 admin 校验（`:47-49`）。
> - 以下端点的归属过滤**均正确**，不计入问题清单：`error-items/list/route.ts:38-40`、`error-items/batch-delete/route.ts:48-77`（先查再按 `ownedIds` 过滤）、`error-items/[id]/route.ts:47-49,89-91`、`[id]/mastery:31-43`、`[id]/delete:29-40`、`[id]/geogebra:42-44`、`analytics/route.ts:24,30,40`、`export/route.ts:29-34`、`import/route.ts:97-115`、全部 `admin/*`（`requireAdmin` 或 role 检查）。

---

## 4. 修改方案与落地建议

原则：先阻断、后收敛、再补测试。每个 PR 只做一件事，便于回滚。

### P0（立即，部署到公网前必须完成）

1. **B-01**：`/api/ai/models` 加鉴权 + 收窄为 admin；`apiKey`/`baseUrl` 改为服务端读取；加出站地址白名单。（单文件，约 30 行改动）
2. **B-02**：`/api/ai/test` 忽略请求体中的 `baseUrl`/`endpoint`，或复用同一白名单并收窄到 admin。
3. **C-01 / C-02 / H-01**：三处 IDOR，各改 1-3 行，把 `userId` 放进查询条件。这是**性价比最高的一组**。
4. **H-02**：`/api/tags/stats` 加鉴权 + `where: { userId }`。
5. **H-04**：`config.ts:92` 默认关闭注册。

### P1（上线前）

6. **M-02**：中间件 fail-closed、显式 `NextResponse.next()`、把 `/api` 纳入 matcher + 公开端点白名单。
7. **H-03**：Openclaw 身份绑定 + `subjectId` 归属校验 + 限流。
8. **M-01**：日志端点鉴权、条数与字段白名单。
9. 为 AI 端点加基于用户的速率限制；抽一个 `requireUser()` / `requireOwner()` 工具函数到 `auth-utils.ts`，逐步替换 42 处样板代码。

### P2（择机）

10. **M-03** 系统重置二次确认与备份；**L-01/L-02** 错误信息与常量时间比较；`tags/stats` 改为数据库侧聚合。
11. 补回归测试：越权用例（A 用户操作 B 的资源应 403/404）、SSRF 白名单拒绝用例、注册开关默认值用例。当前 13 个「集成测试」实为 mock 掉 Prisma 的路由单测，无法捕获这类问题，建议至少为核心写路径补一个连真实测试库的集成用例。
12. 第二期审查：正确性（AI 输出解析、`api-client.ts` 超时、年级推算三套实现）、性能（N+1、base64 图片存 PG）、架构（三份 Provider 复制）、测试与文档一致性。

---

*报告生成：2026-11-07 · 审查范围：P0 鉴权/越权与 SSRF 专项 · 所有结论基于静态代码，未执行运行时验证*
