import { ParsedQuestion } from "@/lib/ai/types";

// 通用分页响应类型
export interface PaginatedResponse<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface Tag {
    id: string;
    name: string;
    category: string;
    subject: string;
    subcategory?: string | null;
    createdAt: string;
    updatedAt: string;
    _count?: {
        errorItems: number;
    };
}

// AI Model types
export interface AIModel {
    id: string;
    name: string;
    owned_by?: string;
}

export interface ModelsResponse {
    models: AIModel[];
    error?: string;
}

export interface Notebook {
    id: string;
    name: string;
    userId: string;
    createdAt: string;
    updatedAt: string;
    _count?: {
        errorItems: number;
    };
}

export interface ErrorItem {
    id: string;
    userId: string;
    subjectId?: string | null;
    subject?: Notebook | null;
    originalImageUrl?: string;
    ocrText?: string | null;
    questionText?: string | null;
    answerText?: string | null;
    analysis?: string | null;
    wrongAnswerText?: string | null;
    mistakeAnalysis?: string | null;
    mistakeStatus?: 'not_attempted' | 'wrong_attempt' | 'unknown' | string | null;
    knowledgePoints?: string | null;

    source?: string | null;
    errorType?: string | null;
    userNotes?: string | null;
    tags?: Tag[];

    masteryLevel: number;
    gradeSemester?: string | null;
    paperLevel?: string | null;

    /** 试卷上印的短编号：YYMMDD + 当日三位序号 + 一位校验，共 10 位 */
    shortCode?: string | null;
    wrongCount?: number;
    correctCount?: number;
    /** 连续答对次数：错一次归零，是「是否真掌握」的主信号 */
    correctStreak?: number;
    lastResult?: 'correct' | 'wrong' | 'skip' | null;
    lastAttemptAt?: string | null;

    createdAt: string;
    updatedAt: string;
}

/** 一次作答的判定结果；skip = 空白未作答，不计错也不计对 */
export type AttemptResult = 'correct' | 'wrong' | 'skip';

// For creation/updates
export interface CreateErrorItemRequest extends ParsedQuestion {
    originalImageUrl: string;
    subjectId?: string;
    gradeSemester?: string;
    paperLevel?: string;
}

export type AnalyzeResponse = ParsedQuestion;

export interface UserProfile {
    id: string;
    email: string;
    username?: string | null;
    name?: string | null;
    educationStage?: string | null;
    enrollmentYear?: number | null;
    role: string;
    isActive: boolean;
}

export interface UpdateUserProfileRequest {
    name?: string;
    email?: string;
    educationStage?: string;
    enrollmentYear?: number;
    password?: string;
}

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
    /** 解析思考强度：deep=深度思考（默认），fast=关闭思考（快但难题正确率下降） */
    reasoningMode?: 'deep' | 'fast';
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
        apiVersion?: string;     // API 版本 (如 2024-02-15-preview)
        model?: string;          // 显示用模型名 (如 gpt-4o)
    };
    prompts?: {
        analyze?: string;
        similar?: string;
    };
    timeouts?: {
        analyze?: number; // 毫秒
    };
    aiOptions?: {
        enableThinking?: boolean;
        mathThinking?: boolean;
        maxTokens?: number;
        thinkingBudget?: number;
        enableMistakeAnalysis?: boolean;
    };
    quota?: {
        warnThreshold?: number;
        freeQuotaExpireAt?: string;
        stopWhenFreeExpired?: boolean;
    };
}

/** GET /api/ai-quota 的响应（仅管理员可读，不含任何 AccessKey）。 */
export interface AiQuotaResponse {
    configured: boolean;
    status: 'ok' | 'unconfigured' | 'error';
    balance?: {
        currency: string;
        availableAmount: number;
        availableCashAmount: number;
        creditAmount: number;
    };
    monthSpend?: {
        billingCycle: string;
        amount: number;
        currency: string;
        itemCount: number;
    };
    fetchedAt?: string;
    message?: string;
    settings?: {
        warnThreshold: number;
        freeQuotaExpireAt: string;
        stopWhenFreeExpired: boolean;
    };
    /** 防欠费拦截的实时可用性：前端据此展示「AI 已停用」等预警。不含任何密钥或精确余额。 */
    availability?: {
        allowed: boolean;
        code?: string;
        freeQuotaExpired?: boolean;
        daysLeft?: number | null;
    };
    provider?: {
        name: string;
        model: string;
    };
}


export interface AnalyticsData {
    totalErrors: number;
    masteredCount: number;
    masteryRate: number;
    subjectStats: { name: string; value: number }[];
    activityData: { date: string; count: number }[];
}

export interface PracticeStatsData {
    subjectStats: { name: string; value: number }[];
    activityStats: { date: string; total: number; correct: number;[key: string]: number | string }[];
    difficultyStats: { name: string; value: number }[];
    overallStats: { total: number; correct: number; rate: string };
}

export interface TagStats {
    tag: string;
    count: number;
}

export interface TagStatsResponse {
    stats: TagStats[];
}

export interface TagSuggestionsResponse {
    suggestions: string[];
}

export interface AdminUser extends UserProfile {
    createdAt: string;
    _count: {
        errorItems: number;
        practiceRecords: number;
    };
}

export interface AdminDashboardData {
    overview: {
        totalUsers: number;
        totalErrorItems: number;
        totalPracticeRecords: number;
        totalSubjects: number;
    };
    userStats: AdminUserStats[];
    subjectDistribution: { name: string; count: number }[];
    dailyTrend: { date: string; count: number }[];
    masteryDistribution: {
        new: number;
        reviewing: number;
        mastered: number;
    };
}

export interface AdminUserStats {
    id: string;
    name: string | null;
    email: string;
    username?: string | null;
    role: string;
    isActive: boolean;
    createdAt: string;
    educationStage: string | null;
    enrollmentYear: number | null;
    errorCount: number;
    practiceCount: number;
    notebookCount: number;
}

export interface AdminUserDetail {
    user: {
        id: string;
        name: string | null;
        email: string;
        username?: string | null;
        role: string;
        isActive: boolean;
        createdAt: string;
        educationStage: string | null;
        enrollmentYear: number | null;
    };
    notebooks: { id: string; name: string; errorCount: number }[];
    errorCount: number;
    practiceCount: number;
    notebookCount: number;
    recent7DaysCount: number;
    masteryDistribution: {
        new: number;
        reviewing: number;
        mastered: number;
    };
    subjectDistribution: { name: string; count: number }[];
    recentErrorItems: {
        id: string;
        questionText: string | null;
        ocrText: string | null;
        masteryLevel: number;
        createdAt: string;
        subject: { name: string } | null;
    }[];
}

export interface RegisterRequest {
    name: string;
    username: string;
    email: string;
    password: string;
    educationStage: string;
    enrollmentYear: number;
}
