/**
 * 试卷路由：出卷 / 读卷 / 提交 / 列表 / 删除。
 *
 * 对应 SECURITY DEFINER RPC：
 *  - POST /api/paper/create  登录用户出卷，把题目快照写库，返回凭证 code
 *  - GET  /api/paper/read?c=  匿名凭 code 读卷（扫码免登录）
 *  - POST /api/paper/submit  匿名凭 code 提交批改（幂等覆盖 + 熟练度差分）
 *  - GET  /api/paper/list      登录用户列出自己的试卷（全量，兼容旧调用）
 *  - GET  /api/paper/list-page 登录用户分页列出自己的试卷（练习试卷归档）
 *  - POST /api/paper/delete    登录用户批量删除自己的试卷（练习试卷归档）
 *
 * 安全模型：原表无 policy，匿名拿不到；唯一入口是已授权的 RPC，读卷/提交靠强随机
 * code 作凭证，出卷/列表/删除在 RPC 内部校验 current_app_user_id() 要求登录且只碰本人数据。
 */
import { rpc } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";

type Created = { code?: string; paperNo?: string; error?: string };
type PaperData = { code?: string; items?: any[]; error?: string };
type SubmitResult = { ok?: boolean; score?: number; correctCount?: number; total?: number; error?: string };
type DeleteResult = { deleted?: number; error?: string };
/** 分页列表返回：rows 当前页 + total 全量条数 */
export type PaperPage = { rows: PaperListRow[]; total: number };
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
        verdict: ["correct", "wrong", "blank", "mastered"].includes(r?.verdict) ? r.verdict : "wrong",
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
 * 列出当前用户生成过的试卷（全量）。
 * 走 paper_list RPC（SECURITY DEFINER，内部按 current_app_user_id 过滤），
 * 需登录；未登录时 RPC 抛 NOT_LOGGED_IN，转成 401。
 * 现主要供兼容调用；练习试卷归档页用的是分页版 /api/paper/list-page。
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

/**
 * 练习试卷归档：批量删除本人试卷。
 * 入参 codes 为 code 数组；paper_delete RPC 内部按 current_app_user_id 过滤，
 * 前端传谁的 code 都删不到别人的卷（越权的 code 直接不匹配、影响行数为 0）。
 */
async function handleDelete(ctx: RouteContext): Promise<Response | null> {
    if (ctx.parts[0] !== "paper" || ctx.parts[1] !== "delete") return null;
    if (ctx.method !== "POST") return apiError(405, "Method not allowed");

    const raw = Array.isArray(ctx.body?.codes) ? ctx.body.codes : [];
    const codes = raw.slice(0, 200).map((c: any) => String(c || "").trim()).filter(Boolean);
    if (!codes.length) return apiError(400, "请选择要删除的试卷");

    try {
        const res = await rpc<DeleteResult>("paper_delete", { p_codes: codes });
        if (res?.error) return apiError(400, res.error);
        return json({ deleted: res?.deleted ?? 0 });
    } catch (e: any) {
        const msg = String(e?.message || e || "");
        if (msg.includes("NOT_LOGGED_IN")) return apiError(401, "请先登录");
        return apiError(500, "删除失败");
    }
}

/**
 * 练习试卷归档：服务端分页列表。
 * GET /api/paper/list-page?page=1&pageSize=20
 * page 从 1 起；RPC 内部把 pageSize 限制在 1~100，offset = (page-1)*pageSize。
 */
async function handleListPage(ctx: RouteContext): Promise<Response | null> {
    if (ctx.parts[0] !== "paper" || ctx.parts[1] !== "list-page") return null;
    if (ctx.method !== "GET") return apiError(405, "Method not allowed");

    const rawPage = Number(ctx.query.get("page") || "1");
    const rawSize = Number(ctx.query.get("pageSize") || "20");
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const pageSize = Number.isFinite(rawSize) && rawSize >= 1 ? Math.floor(rawSize) : 20;
    const offset = (page - 1) * pageSize;

    try {
        const res = await rpc<{ rows?: PaperListRow[]; total?: number; error?: string }>(
            "paper_list_page",
            { p_limit: pageSize, p_offset: offset },
        );
        if (res?.error) return apiError(400, res.error);
        return json({
            rows: Array.isArray(res?.rows) ? res.rows : [],
            total: Number.isFinite(res?.total) ? res.total! : 0,
        });
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
    handleListPage,
    handleDelete,
];
