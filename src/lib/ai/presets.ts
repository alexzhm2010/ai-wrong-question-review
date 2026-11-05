/**
 * 国内及常见 OpenAI 兼容供应商预设。
 * 所有这些厂商都通过 OpenAI 兼容协议接入，无需为每家单独实现 Provider。
 * 注意：核心功能是拍照识题，请选择支持视觉（Vision）的模型。
 */
export interface ProviderPreset {
    id: string;
    label: string;
    baseUrl: string;
    model: string;
    /** 是否支持图片输入（拍照识题必需） */
    vision: boolean;
    note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        id: 'qwen',
        label: '通义千问 VL（阿里云百炼）',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-vl-plus',
        vision: true,
        note: '中文题目识别效果好，推荐',
    },
    {
        id: 'zhipu',
        label: '智谱 GLM-4V',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4.6v',
        vision: true,
        note: '注册即送额度',
    },
    {
        id: 'doubao',
        label: '豆包（火山方舟）',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        model: 'doubao-1.5-vision-pro-32k',
        vision: true,
        note: '国内访问稳定，模型名请按方舟控制台填写',
    },
    {
        id: 'siliconflow',
        label: '硅基流动',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'Qwen/Qwen2.5-VL-72B-Instruct',
        vision: true,
        note: '聚合平台，可切换多个视觉模型',
    },
    {
        id: 'kimi',
        label: '月之暗面 Kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-8k-vision-preview',
        vision: true,
    },
    {
        id: 'deepseek',
        label: 'DeepSeek（仅文本）',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        vision: false,
        note: '不支持图片输入，无法用于拍照识题',
    },
    {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        vision: true,
    },
];

export function findPresetByBaseUrl(baseUrl?: string): ProviderPreset | undefined {
    if (!baseUrl) return undefined;
    return PROVIDER_PRESETS.find(p => p.baseUrl === baseUrl);
}
