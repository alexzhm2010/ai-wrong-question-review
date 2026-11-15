# 第三方组件与许可声明

本产品由 alexzhm2010 独立开发与维护，主版权见 [LICENSE](LICENSE)。
以下列出随本产品分发的第三方组件及其许可声明，按各自许可证要求予以保留。

---

## 1. 早期通用组件基础（MIT）

产品早期曾以开源项目 [wttwins/wrong-notebook](https://github.com/wttwins/wrong-notebook)
的通用界面组件为基础。其版权声明与许可全文如下，按 MIT 条款要求保留：

> Copyright (c) 2025 Wttwins (https://github.com/wttwins/wrong-notebook)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

> 说明：当前版本的 Supabase 数据层、AI 代理、批量导入、图片编辑、
> 任务调度、界面外壳与视觉主题均为独立实现；上列声明仅针对仍沿用的通用控件部分。

---

## 2. UI 组件库

- **shadcn/ui** 组件片段（`src/components/ui/`）—— MIT License
- **Radix UI Primitives** —— MIT License
- **Lucide React** 图标 —— ISC License
- **Tailwind CSS** —— MIT License
- **class-variance-authority / clsx / tailwind-merge** —— MIT / MIT / MIT

---

## 3. 运行时与工具依赖

Next.js、React、React DOM（MIT）；TypeScript（Apache-2.0）；
KaTeX（MIT）；Recharts（MIT）；date-fns（MIT）；zod（MIT）；
Prisma Client（Apache-2.0，仅历史脚本使用）；Vite / Vitest（MIT）。

完整的逐包许可清单以 `package-lock.json` 中每个包的 `license` 字段为准，
可通过 `npx license-checker --summary` 生成 SBOM。经审计，依赖中不含
GPL / AGPL / SSPL 等强 copyleft 许可；少量 LGPL 与 MPL 包仅用于构建期
（sharp 的 libvips 二进制），不随静态产物分发。

---

## 4. 自有素材

`public/icons/*` 与 `src/app/favicon.ico` 为本产品自行设计的图标，
不属于任何第三方素材。

