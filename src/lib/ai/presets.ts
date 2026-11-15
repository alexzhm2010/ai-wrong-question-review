/**
 * 常见 OpenAI 兼容端点的展示预设。
 * 仅在设置界面用于填充示例值；实际模型与密钥由服务端环境变量决定。
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

export const PROVIDER_PRESETS: ProviderPreset[] = [
    { id: "qwen", label: "通义千问 VL", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-plus", vision: true, note: "中文题目识别表现稳定" },
    { id: "zhipu", label: "智谱 GLM-4V", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6v", vision: true },
    { id: "doubao", label: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-1-lite-260915", vision: true, note: "当前线上使用的端点" },
    { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-VL-72B-Instruct", vision: true },
    { id: "kimi", label: "月之暗面 Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k-vision-preview", vision: true },
    { id: "deepseek", label: "DeepSeek（仅文本）", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", vision: false, note: "不支持图片输入" },
    { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", vision: true },
];

export function findPresetByBaseUrl(baseUrl?: string): ProviderPreset | undefined {
    if (!baseUrl) return undefined;
    return PROVIDER_PRESETS.find((item) => item.baseUrl === baseUrl);
}
