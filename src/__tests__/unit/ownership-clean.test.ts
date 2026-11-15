import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = process.cwd();
const banned = ["wttwins", "wrong-notebook", "Wttwins", "移植自", "All rights reserved"];

/** 收集可能进入用户界面的源码与静态资源（排除测试自身与第三方声明文件） */
function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === ".next") continue;
      collect(full, acc);
    } else if (/\.(ts|tsx|js|mjs|html|json|txt)$/.test(name)) {
      if (name === "THIRD-PARTY-NOTICES.txt") continue; // 法律声明按 MIT 要求保留，不属于界面文案
      acc.push(full);
    }
  }
  return acc;
}

describe("产权护栏：界面与产品代码不包含历史来源字样", () => {
  it("src 与 public 下的界面文件均无原作者标识", () => {
    const files = [
      ...collect(resolve(root, "src")),
      ...collect(resolve(root, "public")),
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const kw of banned) {
        if (text.includes(kw)) hits.push(`${file.replace(root + "/", "")} → ${kw}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("主版权文件只保留单一权利人", () => {
    const license = readFileSync(resolve(root, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 alexzhm2010");
    expect(license).not.toContain("Wttwins");
  });

  it("第三方声明按 MIT 要求随源码与静态产物分发", () => {
    const notice = readFileSync(resolve(root, "THIRD-PARTY-NOTICES.md"), "utf8");
    expect(notice).toContain("Copyright (c) 2025 Wttwins");
    expect(notice).toContain("Permission is hereby granted");
    expect(readFileSync(resolve(root, "public/THIRD-PARTY-NOTICES.txt"), "utf8")).toBe(notice);
  });
});
