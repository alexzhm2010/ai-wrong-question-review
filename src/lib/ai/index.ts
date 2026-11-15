/**
 * 类型层统一出口。
 * 静态导出版本不持有任何模型客户端；所有推理请求经 src/lib/supabase/routes/ai.ts
 * 转发到 Edge Function ai-proxy，这里只向页面与组件提供类型。
 */
export type {
    ParsedQuestion,
    SubjectName,
    DifficultyLevel,
    LanguageCode,
    GradeNumber,
    ReanswerQuestionResult,
    GeogebraAnalysisResult,
    AIConfig,
    AIService,
} from "./types";
export type { MistakeStatus } from "../mistake-status";
