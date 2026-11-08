import { apiClient } from "@/lib/api-client";
import { normalizeGradeSemester } from "@/lib/grade-options";

/**
 * 读取当前用户上次保存错题时用的年级，作为新题的默认值。
 * 失败时静默返回空串（＝未设置），不阻塞页面。
 */
export async function fetchLastGradeSemester(): Promise<string> {
    try {
        const result = await apiClient.get<{ gradeSemester: string | null }>("/api/user/last-grade");
        return normalizeGradeSemester(result?.gradeSemester);
    } catch {
        return "";
    }
}
