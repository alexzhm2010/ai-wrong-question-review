/**
 * AI 解析结果的共享类型契约。
 *
 * 静态版里模型调用统一由 Supabase Edge Function 承担，浏览器侧只消费结构化结果，
 * 因此这里只保留数据形状，不含任何供应商 SDK 或数据库访问。
 */

import type { MistakeStatus } from "../mistake-status";

export type SubjectName =
    | "数学" | "物理" | "化学" | "生物"
    | "英语" | "语文" | "历史" | "地理"
    | "政治" | "其他";

/** 一道题目的结构化解析结果，字段与服务端返回的 JSON 一一对应。 */
export interface ParsedQuestion {
    questionText: string;
    answerText: string;
    analysis: string;
    wrongAnswerText?: string;
    mistakeAnalysis?: string;
    mistakeStatus?: MistakeStatus;
    subject: SubjectName;
    knowledgePoints: string[];
    requiresImage?: boolean;
}

export type DifficultyLevel = "easy" | "medium" | "hard" | "harder";
export type LanguageCode = "zh" | "en";
export type GradeNumber = 7 | 8 | 9 | 10 | 11 | 12;

/** 重新解题的返回体。 */
export interface ReanswerQuestionResult {
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
    /** 服务端实际采用的模式：deep 超时会降级为 fast */
    usedMode?: "deep" | "fast";
    /** true 表示深度思考超预算，已自动改用快速模式 */
    degraded?: boolean;
}

/** GeoGebra 作图分析结果。 */
export interface GeogebraAnalysisResult {
    suitable: boolean;
    commands: string[];
    description: string;
}

/** 供应商连接参数（仅描述形状，前端不保存密钥）。 */
export interface AIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    azureDeployment?: string;
    azureApiVersion?: string;
}

/** 预留的能力接口，便于将来替换实现而不改动调用方。 */
export interface AIService {
    analyzeImage(imageBase64: string, mimeType?: string, language?: LanguageCode, grade?: GradeNumber | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion>;
    analyzeImageStream(imageBase64: string, mimeType?: string, language?: LanguageCode, grade?: GradeNumber | null, subject?: string | null, gradeSemester?: string | null, onDelta?: (text: string) => void): Promise<ParsedQuestion>;
    generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language?: LanguageCode, difficulty?: DifficultyLevel, gradeSemester?: string | null): Promise<ParsedQuestion>;
    reanswerQuestion(questionText: string, language?: LanguageCode, subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult>;
    analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult>;
}
