/**
 * 发布 out/ 到 GitHub Pages（gh-pages 分支），只上传内容变化的文件。
 *
 * 用法：
 *   npm run pages:build
 *   GH_TOKEN=xxx node scripts/deploy-gh-pages.mjs
 *
 * 为什么要单独一个脚本，而不是 git push：
 *   - GitHub Pages 的产物有 300+ 小文件，全量 blob 上传经常被限流/断连，
 *     这里先用 git blob hash 和线上树比对，通常只有几十个文件需要传；
 *   - **必须校验 out/.nojekyll**。少了这个空文件，Jekyll 会忽略 _next/ 下所有
 *     资源，线上表现为「页面停在加载中、控制台一堆 404」。这个坑踩过一次，
 *     所以在这里硬性拦住。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const TOKEN = process.env.GH_TOKEN;
const OWNER = process.env.GH_OWNER || "alexzhm2010";
const REPO = process.env.GH_REPO || "ai-wrong-question-review";
const BRANCH = "gh-pages";
const OUT = join(process.cwd(), "out");

if (!TOKEN) {
    console.error("✗ 缺少 GH_TOKEN");
    process.exit(1);
}
if (!existsSync(join(OUT, ".nojekyll"))) {
    console.error("✗ out/.nojekyll 不存在：GitHub Pages 会把 _next/ 当 Jekyll 目录忽略，线上将全部 404");
    console.error("  请改用 `npm run pages:build`（它会自动生成 .nojekyll / 404.html）后重试");
    process.exit(1);
}

const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "deploy-gh-pages",
};

async function call(url, method = "GET", body, tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
        try {
            const res = await fetch(url, {
                method,
                headers: { ...headers, "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text();
                if (res.status >= 500 || res.status === 403 || res.status === 429) {
                    last = `HTTP ${res.status} ${text.slice(0, 160)}`;
                    await new Promise((r) => setTimeout(r, 2000 + i * 3000));
                    continue;
                }
                throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
            }
            const text = await res.text();
            return text ? JSON.parse(text) : {};
        } catch (err) {
            last = String(err);
            await new Promise((r) => setTimeout(r, 2000 + i * 3000));
        }
    }
    throw new Error(`请求失败（重试 ${tries} 次）：${last}`);
}

function walk(dir, base = dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, base, acc);
        else acc.push({ path: relative(base, p).split(sep).join("/"), abs: p, size: st.size });
    }
    return acc;
}

function gitBlobSha(buf) {
    return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
}

const files = walk(OUT);
const ref = await call(`${API}/git/ref/heads/${BRANCH}`);
const parent = ref.object.sha;
const baseTree = (await call(`${API}/git/commits/${parent}`)).tree.sha;
const oldTree = await call(`${API}/git/trees/${baseTree}?recursive=1`);
const old = new Map(oldTree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

const changed = [];
for (const f of files) {
    const buf = readFileSync(f.abs);
    if (gitBlobSha(buf) !== old.get(f.path)) changed.push({ ...f, buf });
}
const removed = [...old.keys()].filter((p) => !files.some((f) => f.path === p));
console.log(`本地 ${files.length} 个文件 · 线上 ${old.size} 个 · 需上传 ${changed.length} · 删除 ${removed.length}`);

const entries = [];
let done = 0;
const queue = [...changed];
async function worker() {
    while (queue.length) {
        const f = queue.shift();
        const blob = await call(`${API}/git/blobs`, "POST", {
            content: f.buf.toString("base64"),
            encoding: "base64",
        });
        entries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
        done++;
        if (done % 25 === 0) console.log(`  上传 ${done}/${changed.length}`);
    }
}
await Promise.all([worker(), worker()]);
for (const p of removed) entries.push({ path: p, mode: "100644", type: "blob", sha: null });

// 完全没变化时不要建空 tree（GitHub 会回 422 Invalid tree info）
if (entries.length === 0) {
    console.log("✓ 线上已是最新，无需发布");
    process.exit(0);
}

const tree = await call(`${API}/git/trees`, "POST", { base_tree: baseTree, tree: entries });
const version = existsSync(join(OUT, "version.json")) ? JSON.parse(readFileSync(join(OUT, "version.json"), "utf8")).version : "unknown";
const commit = await call(`${API}/git/commits`, "POST", {
    message: `chore: publish static build v${version}`,
    tree: tree.sha,
    parents: [parent],
});
await call(`${API}/git/refs/heads/${BRANCH}`, "PATCH", { sha: commit.sha, force: true });
console.log(`✓ 已发布 v${version} → ${commit.sha.slice(0, 8)}`);
console.log(`  https://${OWNER.toLowerCase()}.github.io/${REPO}/`);
