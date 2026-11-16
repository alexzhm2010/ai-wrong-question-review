/**
 * 扫码批改的试卷路由：出卷 / 读卷 / 提交。
 *
 * 三条链路对应三个 SECURITY DEFINER RPC（见 supabase/migrations/20261116_exam_paper.sql）：
 *  - POST /api/paper/create  登录用户出卷，把题目快照写库，返回凭证 code
 *  - GET  /api/paper/read?c=  匿名凭 code 读卷（扫码免登录）
 *  - POST /api/paper/submit  匿名凭 code 提交批改（幂等覆盖 + 熟练度差分）
 *
 * 安全模型：原表无 policy，匿名拿不到；唯一入口是已授权给 anon 的三个 RPC，
 * 靠强随机 code 作凭证。paper_create 额外要求登录（RPC 内部校验 auth.uid()）。
 */
import { rpc } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";

type Created = { code?: string; paperNo?: string; error?: string };
type PaperData = { code?: string; items?: any[]; error?: string };
type SubmitResult = { ok?: boolean; score?: number; correctCount?: number; total?: number; error?: string };
export type PaperListRow = {
    code: string;
    paperNo: string;
    subjectNames: string;
    itemCount: number;
    score: number | null;
    correctCount: number | null;
    submittedAt: string | null;
    createdAt: string;
};

async function handleCreate(ctx: RouteContext): Promise<Response | null> {
    if (ctx.parts[0] !== "paper" || ctx.parts[1] !== "create") return null;
    if (ctx.method !== "POST") return apiError(405, "Method not allowed");

    const items = Array.isArray(ctx.body?.items) ? ctx.body.items : [];
    if (!items.length) return apiError(400, "题目不能为空");
    // 归一化：只把必要字段送进 RPC，避免前端塞入多余数据
    const clean = items.slice(0, 200).map((it: any, i: number) => ({
        id: String(it?.id || ""),
        orderIndex: Number.isFinite(it?.orderIndex) ? it.orderIndex : i,
        shortCode: String(it?.shortCode || ""),
        answerSnapshot: String(it?.answerSnapshot ?? "").slice(0, 4000),
        imageUrl: String(it?.imageUrl || ""),
        questionText: String(it?.questionText || "").slice(0, 4000),
    })).filter((it: any) => it.id);
    if (!clean.length) return apiError(400, "题目不能为空");

    try {
        const res = await rpc<Created>("paper_create", {
            p_subject_names: String(ctx.body?.subjectNames || ""),
            p_items: clean,
        });
        if (res?.error) return apiError(400, res.error);
        if (!res?.code) return apiError(500, "出卷失败：未返回编号");
        return json({ code: res.code, paperNo: res.paperNo });
    } catch (e: any) {
        // RPC 内部抛 NOT_LOGGED_IN / EMPTY_ITEMS 等
        const msg = String(e?.message || e || "");
        if (msg.includes("NOT_LOGGED_IN")) return apiError(401, "请先登录再出卷");
        return apiError(500, "出卷失败");
    }
}

async function handleRead(ctx: RouteContext): Promise<Response | null> {
    if (ctx.parts[0] !== "paper" || ctx.parts[1] !== "read") return null;
    if (ctx.method !== "GET") return apiError(405, "Method not allowed");
    const code = String(ctx.query.get("c") || "").trim();
    if (!code) return apiError(400, "缺少试卷编号");

    try {
        const res = await rpc<PaperData>("paper_read", { p_code: code });
        if (res?.error) return apiError(404, res.error);
        return json(res);
    } catch {
        return apiError(500, "读取试卷失败");
    }
}

async function handleSubmit(ctx: RouteContext): Promise<Response | null> {
    if (ctx.parts[0] !== "paper" || ctx.parts[1] !== "submit") return null;
    if (ctx.method !== "POST") return apiError(405, "Method not allowed");
    const code = String(ctx.body?.code || "").trim();
    if (!code) return apiError(400, "缺少试卷编号");

    const raw = Array.isArray(ctx.body?.results) ? ctx.body.results : [];
    const results = raw.slice(0, 200).map((r: any) => ({
        errorItemId: String(r?.errorItemId || ""),
        verdict: ["correct", "wrong", "blank"].includes(r?.verdict) ? r.verdict : "wrong",
    })).filter((r: any) => r.errorItemId);
    if (!results.length) return apiError(400, "没有提交任何结果");

    try {
        const res = await rpc<SubmitResult>("paper_submit", {
            p_code: code,
            p_results: results,
        });
        if (res?.error) return apiError(404, res.error);
        return json(res);
    } catch {
        return apiError(500, "提交失败");
    }
}

/**
 * 批改中心：列出当前用户生成过的试卷。
 * 走 paper_list RPC（SECURITY DEFINER，内部按 current_app_user_id 过滤），
 * 需登录；未登录时 RPC 抛 NOT_LOGGED_IN，转成 401。
 */
async function handleList(ctx: RouteContext): Promise<Response | null> {
    if (ctx.parts[0] !== "paper" || ctx.parts[1] !== "list") return null;
    if (ctx.method !== "GET") return apiError(405, "Method not allowed");

    try {
        const res = await rpc<PaperListRow[]>("paper_list");
        if (!Array.isArray(res)) return apiError(500, "列表格式异常");
        return json(res);
    } catch (e: any) {
        const msg = String(e?.message || e || "");
        if (msg.includes("NOT_LOGGED_IN")) return apiError(401, "请先登录");
        return apiError(500, "加载试卷列表失败");
    }
}

export const PAPER_HANDLERS: RouteHandler[] = [
    handleCreate,
    handleRead,
    handleSubmit,
    handleList,
];
