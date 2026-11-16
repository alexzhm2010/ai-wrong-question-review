/**
 * 批改中心列表的展示逻辑（纯函数，便于回归测试）。
 * 只负责把试卷摘要翻译成状态文案/配色，以及拼进入批改页的地址。
 */
import type { PaperListRow } from "@/lib/supabase/routes/paper";

export type PaperStatus = {
    label: string;
    /** 供卡片配色用的语义档位 */
    tone: "done" | "pending";
    detail: string;
};

/**
 * 一张试卷的状态：
 *  - 已提交（score 非 null）→ 显示分数与答对数
 *  - 未提交 → 显示待批改
 * score 为 0 是合法分数（全错），必须按「已批改」处理，不能用真值判断。
 */
export function paperStatus(row: Pick<PaperListRow, "score" | "correctCount" | "itemCount">): PaperStatus {
    const submitted = row.score !== null && row.score !== undefined;
    if (submitted) {
        return {
            label: `${row.score} 分`,
            tone: "done",
            detail: `答对 ${row.correctCount ?? 0}/${row.itemCount} 题`,
        };
    }
    return { label: "待批改", tone: "pending", detail: `${row.itemCount} 题 · 做完扫码批改` };
}

/** 进入某份试卷批改页的地址（带凭证 code） */
export function markHref(code: string): string {
    return `/mark?c=${encodeURIComponent(code)}`;
}

/** createdAt 转成「MM-DD HH:mm」，固定用 Asia/Shanghai 墙上时间，避免随运行环境时区漂移 */
export function formatPaperTime(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        hourCycle: "h23",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
