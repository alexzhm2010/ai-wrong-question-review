import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROVIDER_PRESETS,
  DEFAULT_PRESET_ID,
  defaultPreset,
  findPresetByBaseUrl,
} from "@/lib/ai/presets";

const root = process.cwd();
const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DOUBAO_MODEL = "doubao-seed-2-1-lite-260915";

describe("AI 供应商配置：默认端点与线上保持一致", () => {
  it("默认预设是火山方舟，且与 ai-proxy 的默认端点一致", () => {
    expect(DEFAULT_PRESET_ID).toBe("doubao");
    const preset = defaultPreset();
    expect(preset.baseUrl).toBe(ARK_BASE);
    expect(preset.model).toBe(DOUBAO_MODEL);
    expect(preset.vision).toBe(true);
  });

  it("火山方舟排在预设首位，且可由 Base URL 反查", () => {
    expect(PROVIDER_PRESETS[0].id).toBe("doubao");
    expect(findPresetByBaseUrl(ARK_BASE)?.id).toBe("doubao");
  });

  it("模型列表端点不再把通义千问写成默认值", () => {
    const src = readFileSync(resolve(root, "src/lib/supabase/routes/ai.ts"), "utf8");
    expect(src).not.toContain('defaultModel: "qwen3-vl-plus"');
    expect(src).not.toContain('name: "通义千问 3 VL Plus"');
    expect(src).toContain(DOUBAO_MODEL);
  });

  it("公共配置的回落实例使用火山方舟端点", () => {
    const src = readFileSync(resolve(root, "src/lib/supabase/routes/shared.ts"), "utf8");
    expect(src).toContain(ARK_BASE);
    expect(src).toContain(DOUBAO_MODEL);
  });

  it("设置页明确告知用户密钥由服务端管理、本页配置不生效", () => {
    const src = readFileSync(resolve(root, "src/components/settings-dialog.tsx"), "utf8");
    expect(src).toContain("当前实际生效的 AI 供应商");
    expect(src).toContain("密钥不落前端");
    expect(src).toContain("/api/ai/test");
  });
});
