/**
 * 静态导出后的 GitHub Pages 适配。
 * next build 生成 out/ 后执行，处理三件 GitHub Pages 特有的事：
 *  1. .nojekyll —— 否则 Jekyll 会忽略下划线开头的 _next/ 目录，页面白屏
 *  2. 404.html —— 内容复制首页，让不带尾斜杠的深层路由也能进入 SPA
 *  3. sw.js —— 图标缓存路径补上 basePath
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "out");
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "/ai-wrong-question-review";

if (!existsSync(outDir)) {
  console.error("✗ out/ 不存在，请先执行 next build");
  process.exit(1);
}

writeFileSync(join(outDir, ".nojekyll"), "");

const indexHtml = join(outDir, "index.html");
if (existsSync(indexHtml)) {
  cpSync(indexHtml, join(outDir, "404.html"));
}

const swPath = join(outDir, "sw.js");
if (existsSync(swPath)) {
  const sw = readFileSync(swPath, "utf8")
    .replaceAll("'/icons/'", `'${basePath}/icons/'`)
    .replaceAll('"/icons/"', `"${basePath}/icons/"`);
  writeFileSync(swPath, sw);
}

const versionPath = join(outDir, "version.json");
if (existsSync(versionPath)) {
  try {
    const data = JSON.parse(readFileSync(versionPath, "utf8"));
    data.channel = "github-pages";
    writeFileSync(versionPath, JSON.stringify(data, null, 2));
  } catch {
    /* version.json 非标准 JSON 时跳过 */
  }
}

console.log(`✓ out/ 已适配 GitHub Pages（basePath=${basePath}）：.nojekyll / 404.html / sw.js`);
