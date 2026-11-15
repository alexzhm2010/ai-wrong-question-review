/**
 * 常见 OpenAI 兼容端点的展示预设。
 *
 * 静态版（GitHub Pages + Supabase）里，真实的题目解析由 Edge Function
 * ai-proxy 的 OPENAI_* 环境变量承担；本文件只用于设置页填充展示值，
 * 在界面里切换预设不会改变线上实际调用的模型与密钥。
 * 需要更换线上模型时，应更新 Edge Function 的环境变量并重新部署。
 */

export interface ProviderPreset {
    id: string;
    label: string;
    baseUrl: string;
    model: string;
    /** 是否支持图片输入（拍照识题需要视觉能力） */
    vision: boolean;
    note?: string;
}

/** 与 ai-proxy 默认端点保持一致，作为设置页与空配置的回落值 */
export const DEFAULT_PRESET_ID = "doubao";

export const PROVIDER_PRESETS: ProviderPreset[] = [
    { id: "doubao", label: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-1-lite-260915", vision: true, note: "当前线上生效的端点；本页修改不会改变服务端调用" },
    { id: "qwen", label: "通义千问 VL", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-plus", vision: true, note: "中文题目识别表现稳定" },
    { id: "zhipu", label: "智谱 GLM-4V", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6v", vision: true },
    { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-VL-72B-Instruct", vision: true },
    { id: "kimi", label: "月之暗面 Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview", vision: true },
    { id: "deepseek", label: "DeepSeek（仅文本）", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", vision: false, note: "不支持图片输入" },
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", vision: true },
];

export function findPresetByBaseUrl(baseUrl?: string): ProviderPreset | undefined {
    if (!baseUrl) return undefined;
    return PROVIDER_PRESETS.find((item) => item.baseUrl === baseUrl);
}

export function defaultPreset(): ProviderPreset {
    return PROVIDER_PRESETS.find((item) => item.id === DEFAULT_PRESET_ID) ?? PROVIDER_PRESETS[0];
}
