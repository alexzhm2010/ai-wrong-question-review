/**
 * 静态导出后的 GitHub Pages 适配。
 * next build 生成 out/ 后执行，处理四件事：
 *  1. .nojekyll —— 否则 Jekyll 会忽略下划线开头的 _next/ 目录，页面白屏
 *  2. 404.html —— 内容复制首页，让不带尾斜杠的深层路由也能进入 SPA
 *  3. sw.js —— 图标缓存路径补上 basePath
 *  4. 法定声明门禁 —— out/ 必须带 LICENSE.txt 与 THIRD-PARTY-NOTICES.txt。
 *     MIT 要求版权与许可声明随所有副本分发，静态产物也是副本，缺了就是违约，
 *     所以在发布前硬性拦住，别等上线后才发现 404。
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

// 法定声明门禁：静态产物属于 MIT 意义上的「副本」，必须随附两份声明。
// 放在发布前硬拦，避免上线后才发现声明文件 404 造成许可违约。
const requiredNotices = ["LICENSE.txt", "THIRD-PARTY-NOTICES.txt"];
const missingNotices = requiredNotices.filter((f) => !existsSync(join(outDir, f)));
if (missingNotices.length > 0) {
  console.error(`✗ out/ 缺少法定声明文件：${missingNotices.join("、")}`);
  console.error("  MIT 要求版权与许可声明随所有副本分发；请在 public/ 补齐后重新执行 npm run pages:build");
  process.exit(1);
}

console.log(`✓ out/ 已适配 GitHub Pages（basePath=${basePath}）：.nojekyll / 404.html / sw.js / 法定声明`);
