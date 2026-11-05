# AI 错题复习平台 (AI Wrong Question Review)

一个基于 AI 的智能错题管理与复习平台，帮助学生高效整理、分析和复习错题。

> 本项目移植自 [wttwins/wrong-notebook](https://github.com/wttwins/wrong-notebook)（MIT License），并在其基础上进行二次开发。

## ✨ 主要功能

- **🤖 AI 智能分析**：自动识别题目内容，生成解析、知识点标签和同类练习题。
- **⚙️ 灵活的 AI 配置**：支持 **OpenAI 兼容接口**（通义千问 VL、智谱 GLM-4V、豆包、硅基流动、Kimi、OpenAI 等，可在设置页一键选择预设）、**Google Gemini** 和 **Azure OpenAI**，可直接在网页设置中动态切换和配置。
- **📱 跨平台使用**：响应式界面 + PWA，手机、平板、PC 浏览器均可使用，可添加到主屏幕。
- **📚 多错题本管理**：支持按科目（如数学、物理、英语）创建和管理多个错题本。
- **🏷️ 智能标签系统**：自动提取知识点标签，支持自定义标签管理。
- **🔍 多维度筛选**：支持按掌握状态、时间范围、知识点标签、年级学期、试卷等级等多种条件筛选错题。
- **🖨️ 灵活导出打印**：一键导出筛选后的错题，支持自定义打印内容（答案/解析/知识点）和图片缩放比例，可直接打印或保存为 PDF。
- **📝 智能练习**：基于错题生成相似的练习题，巩固薄弱环节。
- **📊 数据统计**：可视化展示错题掌握情况和学习进度。
- **🔐 用户管理**：支持多用户注册、登录，数据安全隔离。
- **🛡️ 管理员后台**：提供用户管理功能，可禁用/启用用户、删除违规用户。


## 📸 屏幕截图功能 (HTTPS 设置)

本应用的屏幕截图功能依赖浏览器的安全上下文 (HTTPS)。在 Docker 或局域网环境中使用时，请参考 **[HTTPS 配置指南](doc/HTTPS_SETUP.md)** 启用内置 HTTPS 支持。

## 📱 PWA 支持 (添加到主屏幕)

本项目支持 PWA (Progressive Web App)，您可以将应用添加到手机主屏幕，获得原生应用般的使用体验。

**功能特性**：
- 🚀 **快速启动**：点击主屏幕图标直接打开，无需输入网址。
- 📱 **沉浸体验**：全屏运行，无浏览器地址栏干扰。
- 🎨 **原色适配**：应用图标和启动画面适配系统主题。

**使用方法**：

- **iPhone / iPad (Safari)**: 点击底部 **分享** 按钮 -> 选择 **"添加到主屏幕"**。
- **Android (Chrome)**: 点击右上角 **菜单** -> 选择 **"添加到主屏幕"** 或 **"安装应用"**。

## 🛠️ 技术栈

- **框架**: [Next.js 16](https://nextjs.org/) (App Router)
- **UI 库**: [React 19](https://react.dev/)
- **数据库**: [Supabase](https://supabase.com/) / PostgreSQL (via [Prisma](https://www.prisma.io/))
- **样式**: [Tailwind CSS v4](https://tailwindcss.com/) + [Shadcn UI](https://ui.shadcn.com/)
- **AI**: 通义千问 VL / 智谱 GLM-4V / 豆包 / 硅基流动 / Kimi / OpenAI / Google Gemini / Azure OpenAI
- **部署**: Vercel（推荐）或 Docker
- **认证**: [NextAuth.js](https://next-auth.js.org/)

## 🚀 快速开始

### 方式一：Vercel + Supabase 部署（推荐）

应用需要 Node 服务端运行环境，**无法托管在 GitHub Pages**（GitHub Pages 仅支持静态文件）。GitHub Pages 仅用于展示 [docs/index.html](docs/index.html) 介绍页。

1. **创建 Supabase 项目**，在 Project Settings → Database 复制两个连接串：
   - `DATABASE_URL`：连接池地址（端口 **6543**），追加 `?pgbouncer=true&connection_limit=1`
   - `DIRECT_URL`：直连地址（端口 **5432**），仅用于数据库迁移

2. **在 Vercel 导入本仓库**（或点击 [一键部署](https://vercel.com/new/clone?repository-url=https://github.com/alexzhm2010/ai-wrong-question-review)）

3. **配置环境变量**

   | 变量 | 说明 |
   |---|---|
   | `DATABASE_URL` | Supabase 连接池连接串（6543） |
   | `DIRECT_URL` | Supabase 直连串（5432），用于迁移 |
   | `AUTH_SECRET` | 随机会话密钥，可用 `openssl rand -base64 32` 生成 |
   | `AUTH_TRUST_HOST` | 设为 `true` |
   | `AI_PROVIDER` | 设为 `openai` |
   | `OPENAI_API_KEY` | 通义千问 API Key |
   | `OPENAI_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
   | `OPENAI_MODEL` | `qwen3-vl-plus` |

4. **构建命令**（Vercel → Settings → Build & Development Settings）：

   ```bash
   npx prisma generate && npx prisma migrate deploy && npm run build
   ```

   首次部署会自动创建所有数据表。

> 部署完成后即可在手机、平板、PC 浏览器访问；在移动端浏览器中选择「添加到主屏幕」可作为 PWA 使用。
>
> **注意**：Vercel Hobby 计划的函数最长执行 60 秒，复杂题目的 AI 识别可能超时。如需更长耗时，请升级 Vercel Pro（300 秒）或改用下方 Docker 部署。

### 方式二：Render 部署（无需手机号）

仓库已内置 [`render.yaml`](render.yaml)，在 Render 上用 GitHub 账号登录后：

1. 打开 https://dashboard.render.com/blueprints → **New Blueprint Instance**
2. 选择本仓库，Render 会自动读取 `render.yaml` 创建 Web Service
3. 在环境变量页填写 `DATABASE_URL`、`DIRECT_URL`、`OPENAI_API_KEY`，点击 **Apply**
4. 首次部署会自动执行 `prisma migrate deploy` 创建数据表

> 免费实例闲置 15 分钟后会休眠，首次访问需等待约 30–60 秒冷启动；需要常驻可升级到 Starter（$7/月）。

### 方式三：使用 Docker 部署

#### 1. 启动服务

您可以选择 **直接使用命令** (适合快速测试) 或 **Docker Compose** (适合长期运行)。

**选项 A：直接使用 Docker 命令**

```bash
docker run -d --name ai-wrong-review \
  -e DATABASE_URL="postgresql://...supabase连接池地址:6543/postgres?pgbouncer=true&connection_limit=1" \
  -e DIRECT_URL="postgresql://...supabase直连地址:5432/postgres" \
  -e AUTH_SECRET="your_secret_key" \
  -e OPENAI_API_KEY="sk-..." \
  -e OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1" \
  -e OPENAI_MODEL="qwen3-vl-plus" \
  -p 3000:3000 \
  ghcr.io/wttwins/wrong-notebook
```

> 数据库使用外部 PostgreSQL（Supabase），无需再挂载 `/app/data` 卷。

**选项 B：使用 Docker Compose (推荐)**

使用本仓库的 `docker-compose.yml` 文件进行管理。

1.  **下载配置文件**：
    ```bash
    curl -o docker-compose.yml https://raw.githubusercontent.com/alexzhm2010/ai-wrong-question-review/main/docker-compose.yml
    ```
2.  **启动服务**：
    ```bash
    docker-compose up -d
    ```
3.  **查看日志**：
    ```bash
    docker-compose logs -f
    ```
4.  **停止服务**：
    ```bash
    docker-compose down
    ```

### 方式四：本地源码运行

#### 1. 克隆仓库

```bash
git clone https://github.com/alexzhm2010/ai-wrong-question-review.git
cd ai-wrong-question-review
```

#### 2. 环境准备

确保已安装 Node.js (v18+) 和 npm。

#### 3. 安装依赖

```bash
npm install
```

#### 4. 配置环境变量

复制 `.env.example` 为 `.env` 并填入必要的配置：

```bash
cp .env.example .env
```

**基础配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `DATABASE_URL` | 数据库连接地址 | 无 | Supabase 连接池连接串（端口 6543，带 `pgbouncer=true&connection_limit=1`） |
| `DIRECT_URL` | 迁移直连地址 | 无 | Supabase 直连串（端口 5432），仅 `prisma migrate` 使用 |
| `NEXTAUTH_SECRET` | Auth 密钥 | 无 | 用于加密 Session，生产环境建议设置,可以使用 openssl rand -base64 32 生成一个随机字符串作为密钥 |
| `NEXTAUTH_URL` | 访问地址 | `http://your-domain-name:3000` | 部署后的访问地址 |
| `AUTH_TRUST_HOST` | 信任主机头 | `true` | 设置为 `true` 时自动推断 URL，适合 Docker/PaaS |
| `LOG_LEVEL` | 日志级别 | `debug` (开发) / `info` (生产) | 可选值：`trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `HTTP_PROXY` | HTTP 代理 | 无 | 设置 HTTP 代理 |
| `HTTPS_PROXY` | HTTPS 代理 | 无 | 设置 HTTPS 代理 |

**AI 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `AI_PROVIDER` | AI 提供商 | `openai` | 可选 `openai`（兼容通义千问/智谱/豆包等）、`gemini` 或 `azure` |

**Gemini 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `GOOGLE_API_KEY` | Gemini API Key | 无 | 使用 Gemini 时必填，从 [Google AI Studio](https://aistudio.google.com/apikey) 获取 |
| `GEMINI_BASE_URL` | Gemini API 地址 | 无 | 可选，默认 `https://generativelanguage.googleapis.com`，通常无需修改 |
| `GEMINI_MODEL` | Gemini 模型 | `gemini-2.5-flash` | 可选，如 `gemini-2.5-pro`、`gemini-3.0-flash` 等 |

**OpenAI 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `OPENAI_API_KEY` | OpenAI API Key | 无 | 使用 OpenAI 时必填，从 [OpenAI Platform](https://platform.openai.com/api-keys) 获取 |
| `OPENAI_BASE_URL` | OpenAI API 地址 | 无 | 可选，默认 `https://api.openai.com/v1`；使用第三方兼容服务时填写对应地址 |
| `OPENAI_MODEL` | OpenAI 模型 | `gpt-4o` | 可选，如 `gpt-4-turbo`、`o3`、`o4-mini` 等 |

**Azure OpenAI 配置**

| 环境变量 | 描述 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `AZURE_OPENAI_API_KEY` | Azure API Key | 无 | 使用 Azure OpenAI 时必填，从 Azure 门户获取 |
| `AZURE_OPENAI_ENDPOINT` | Azure Endpoint | 无 | Azure 资源端点，如 `https://xxx.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | 部署名称 | 无 | Azure 中配置的部署名称，如 `gpt-4o` |
| `AZURE_OPENAI_API_VERSION` | API 版本 | `2024-02-15-preview` | 可选，Azure API 版本 |
| `AZURE_OPENAI_MODEL` | Azure 模型 | `gpt-4o` | 可选，显示用的模型名称 |

#### 5. 初始化数据库

```bash
npx prisma migrate dev
npx prisma db seed
```

#### 6. 管理员账户

默认管理员账户：
- **邮箱**: `admin@localhost`
- **密码**: `123456`

> 管理员登录后，可在“设置” -> “用户管理”中管理系统用户。

#### 7. 启动开发服务器

```bash
npm run dev
```

访问 [http://your-domain-name:3000](http://your-domain-name:3000) 开始使用。

## ⚙️ AI 模型配置

本项目支持动态配置 AI 模型，无需重启服务器。

1.  **进入设置**：点击首页右上角的设置图标。
2.  **选择提供商**：支持 **OpenAI 兼容接口**（内置通义千问 VL、智谱 GLM-4V、豆包、硅基流动、Kimi 等预设，一键填充）、Google Gemini 和 **Azure OpenAI**。
3.  **填写参数**：
    *   **通用参数**: API Key、Base URL（或 Endpoint）、Model Name（或 Deployment Name）。
    *   **Azure 特有**: Deployment Name（部署名称）、API Version（API 版本）。
4.  **保存生效**：点击保存后即刻生效，配置保存在 Supabase 的 `AppSetting` 表中，多设备访问时保持一致。

> **注意**：网页保存的配置写入数据库，优先级高于 `.env` 环境变量；数据库中没有记录时才回退到环境变量默认值。
> **拍照识题必须使用支持视觉的模型**（如 `qwen3-vl-plus`、`glm-4.6v`）。DeepSeek 等纯文本模型只能做文字解析。

### 配置样例

选择提供商后，填写对应参数即可。各服务商获取方式如下：

#### Google Gemini

| 参数 | 获取方式 |
| :--- | :--- |
| API Key | [Google AI Studio](https://aistudio.google.com/apikey) → 创建 API Key |
| Base URL | 默认 `https://generativelanguage.googleapis.com`，通常无需修改 |
| 模型 | `gemini-2.5-flash`（推荐）、`gemini-2.5-pro`、`gemini-3.0-flash` 等 |

#### OpenAI

| 参数 | 获取方式 |
| :--- | :--- |
| API Key | [OpenAI Platform](https://platform.openai.com/api-keys) → Create new secret key |
| Base URL | 默认 `https://api.openai.com/v1` |
| 模型 | `gpt-4o`（推荐）、`gpt-4-turbo`、`o3`、`o4-mini` 等 |

> **兼容模式**：OpenAI 提供商兼容所有支持 OpenAI API 格式的第三方服务。只需将 Base URL 改为对应服务地址，即可使用硅基流动、智谱 GLM、月之暗面 Kimi、通义千问 DashScope 等平台的模型。模型名称需填写对应平台的完整模型 ID。

#### 通义千问 VL（推荐，中文题目识别）

| 参数 | 值 |
| :--- | :--- |
| API Key | [阿里云百炼](https://bailian.console.aliyun.com/) → API-KEY 管理 |
| Base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 模型 | `qwen3-vl-plus`（推荐）、`qwen-vl-max`、`qwen2.5-vl-72b-instruct` |

> 在设置页「快速选择供应商预设」中选择「通义千问 VL」会自动填入以上参数。

#### Azure OpenAI

| 参数 | 获取方式 |
| :--- | :--- |
| API Key | Azure 门户 → 你的 OpenAI 资源 → 密钥和终结点 |
| Endpoint | Azure 门户 → 你的 OpenAI 资源 → 终结点，如 `https://xxx.openai.azure.com` |
| 部署名称 | Azure 中配置的模型部署名称，如 `gpt-4o` |
| API 版本 | 默认 `2024-02-15-preview` |
| 模型 | 显示用的模型名称，如 `gpt-4o` |

## 🛠️ 实用脚本

在 `scripts/` 目录下提供了一些实用脚本，用于维护和调试：

- **重置密码**:
  ```bash
  node scripts/reset-password.js <邮箱> <新密码>
  ```
  示例:  
  ```bash
  node scripts/reset-password.js user@example.com 123456 
  ```

## 🙏 致谢

- 原始项目：[wttwins/wrong-notebook](https://github.com/wttwins/wrong-notebook)，作者 Wttwins
- 本项目在其基础上进行移植与二次开发，保留原有提交历史

## 📄 许可证

MIT License（见 [LICENSE](LICENSE)）。

- 原始代码 Copyright (c) 2025 Wttwins
- 移植与修改 Copyright (c) 2026 alexzhm2010
