import { prisma } from './prisma';
import { createLogger } from './logger';

const logger = createLogger('config');

// 配置在数据库中的存储键
const CONFIG_KEY = 'app_config';

// OpenAI 实例配置
export interface OpenAIInstance {
    id: string;           // 唯一标识 (UUID)
    name: string;         // 用户自定义名称
    apiKey: string;
    baseUrl: string;
    model: string;
}

export interface AppConfig {
    aiProvider: 'gemini' | 'openai' | 'azure';
    allowRegistration?: boolean;
    openai?: {
        instances?: OpenAIInstance[];
        activeInstanceId?: string;
    };
    gemini?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
    };
    azure?: {
        apiKey?: string;
        endpoint?: string;       // Azure 资源端点 (https://xxx.openai.azure.com)
        deploymentName?: string; // 部署名称
        apiVersion?: string;     // API 版本
        model?: string;          // 显示用模型名
    };
    prompts?: {
        analyze?: string;
        similar?: string;
    };
    timeouts?: {
        analyze?: number; // 毫秒
    };
    aiOptions?: {
        enableThinking?: boolean; // AI 思考/推理模式，默认 false（关闭以提速）
        mathThinking?: boolean;   // 数学题是否自动开启深度思考，默认 true（更准但更慢）
        maxTokens?: number;      // 单次分析最大输出 token，默认 4096
    };
}

// 旧版 OpenAI 配置格式（用于迁移检测）
interface LegacyOpenAIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
}

// 检测是否为旧版配置格式
function isLegacyOpenAIConfig(config: unknown): config is LegacyOpenAIConfig {
    if (!config || typeof config !== 'object') return false;
    // 旧版配置包含 apiKey 直接字段，而新版包含 instances 数组
    return 'apiKey' in config && !('instances' in config);
}

// 生成唯一 ID
function generateId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 迁移旧版 OpenAI 配置到新版多实例格式
function migrateOpenAIConfig(legacy: LegacyOpenAIConfig): AppConfig['openai'] {
    if (!legacy.apiKey) {
        // 没有有效配置，返回空实例数组
        return { instances: [], activeInstanceId: undefined };
    }

    const defaultInstance: OpenAIInstance = {
        id: generateId(),
        name: 'Default',
        apiKey: legacy.apiKey,
        baseUrl: legacy.baseUrl || 'https://api.openai.com/v1',
        model: legacy.model || 'gpt-4o',
    };

    return {
        instances: [defaultInstance],
        activeInstanceId: defaultInstance.id,
    };
}

const DEFAULT_CONFIG: AppConfig = {
    aiProvider: (process.env.AI_PROVIDER as 'gemini' | 'openai' | 'azure') || 'openai',
    // H-04：出厂默认关闭注册（fail-closed）。首个管理员由 `npm run db:seed`
    // 创建的 admin@localhost 担任，后续账号由管理员在设置页显式开启注册或自行创建。
    // 开放式注册会把所有「需登录」漏洞的利用门槛降到「花几秒注册一个账号」。
    allowRegistration: false,
    openai: {
        instances: process.env.OPENAI_API_KEY ? [{
            id: 'env-default',
            name: 'Default (ENV)',
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            model: process.env.OPENAI_MODEL || 'qwen3-vl-plus',
        }] : [],
        activeInstanceId: process.env.OPENAI_API_KEY ? 'env-default' : undefined,
    },
    gemini: {
        apiKey: process.env.GOOGLE_API_KEY,
        baseUrl: process.env.GEMINI_BASE_URL,
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    azure: {
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',
        model: process.env.AZURE_OPENAI_MODEL || 'gpt-4o',
    },
    prompts: {
        analyze: '',
        similar: '',
    },
    timeouts: {
        analyze: 180000,
    },
    aiOptions: {
        enableThinking: false,
        mathThinking: true,
        maxTokens: 4096,
    },
};

// 合并数据库配置与默认值，保证字段完整
function mergeConfig(userConfig: Partial<AppConfig>): AppConfig {
    return {
        ...DEFAULT_CONFIG,
        ...userConfig,
        openai: {
            instances: userConfig.openai?.instances || DEFAULT_CONFIG.openai?.instances || [],
            activeInstanceId: userConfig.openai?.activeInstanceId || DEFAULT_CONFIG.openai?.activeInstanceId,
        },
        gemini: { ...DEFAULT_CONFIG.gemini, ...userConfig.gemini },
        azure: { ...DEFAULT_CONFIG.azure, ...userConfig.azure },
        prompts: { ...DEFAULT_CONFIG.prompts, ...userConfig.prompts },
        timeouts: { ...DEFAULT_CONFIG.timeouts, ...userConfig.timeouts },
        aiOptions: { ...DEFAULT_CONFIG.aiOptions, ...userConfig.aiOptions },
    };
}

/**
 * 读取应用配置。
 * 配置持久化在数据库 AppSetting 表中，因此在 Vercel 等 serverless 环境下也能跨实例共享。
 */
export async function getAppConfig(): Promise<AppConfig> {
    try {
        const row = await prisma.appSetting.findUnique({ where: { key: CONFIG_KEY } });
        if (!row) {
            return DEFAULT_CONFIG;
        }

        const userConfig = JSON.parse(row.value) as Partial<AppConfig>;

        // 检测并迁移旧版 OpenAI 配置
        if (isLegacyOpenAIConfig(userConfig.openai)) {
            logger.info('Detected legacy OpenAI config, migrating to multi-instance format...');
            const openaiConfig = migrateOpenAIConfig(userConfig.openai);
            const migrated = mergeConfig({ ...userConfig, openai: openaiConfig });
            await saveConfig(migrated);
            logger.info('Legacy OpenAI config migrated successfully');
            return migrated;
        }

        return mergeConfig(userConfig);
    } catch (error) {
        logger.error({ error }, 'Failed to read app config from database');
        return DEFAULT_CONFIG;
    }
}

// 直接写入完整配置
async function saveConfig(config: AppConfig): Promise<void> {
    await prisma.appSetting.upsert({
        where: { key: CONFIG_KEY },
        create: { key: CONFIG_KEY, value: JSON.stringify(config) },
        update: { value: JSON.stringify(config) },
    });
}

/**
 * 更新应用配置（局部合并后写库）。
 */
export async function updateAppConfig(newConfig: Partial<AppConfig>): Promise<AppConfig> {
    const currentConfig = await getAppConfig();
    const updatedConfig: AppConfig = {
        ...currentConfig,
        ...newConfig,
        openai: {
            instances: newConfig.openai?.instances ?? currentConfig.openai?.instances ?? [],
            activeInstanceId: newConfig.openai?.activeInstanceId ?? currentConfig.openai?.activeInstanceId,
        },
        gemini: { ...currentConfig.gemini, ...newConfig.gemini },
        azure: { ...currentConfig.azure, ...newConfig.azure },
        prompts: { ...currentConfig.prompts, ...newConfig.prompts },
        timeouts: { ...currentConfig.timeouts, ...newConfig.timeouts },
    };

    try {
        await saveConfig(updatedConfig);
        return updatedConfig;
    } catch (error) {
        logger.error({ error }, 'Failed to write app config');
        throw error;
    }
}

// 获取当前激活的 OpenAI 实例配置
export async function getActiveOpenAIConfig(): Promise<OpenAIInstance | undefined> {
    const config = await getAppConfig();
    const instances = config.openai?.instances || [];
    const activeId = config.openai?.activeInstanceId;

    if (!activeId || instances.length === 0) {
        return undefined;
    }

    return instances.find(i => i.id === activeId);
}

// 最大实例数限制
export const MAX_OPENAI_INSTANCES = 10;
