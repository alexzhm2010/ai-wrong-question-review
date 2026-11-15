/**
 * 「结束批次 / 单条舍弃 / skip 自动终态」回归测试。
 *
 * 用一个带状态的 REST mock 跑完整 BATCH_HANDLERS，PATCH 会真的改状态，
 * 因此能验证 finish 内部递归调 save 之后，第二次统计看到的是更新过的条目，
 * 而不是把刚入库的题又标成 discarded。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ restJson: vi.fn() }));
const restJsonMock = mocks.restJson;

vi.mock("@/lib/supabase/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/supabase/core")>();
    return {
        ...actual,
        restJson: mocks.restJson,
        requireUser: async () => ({ id: "u1", role: "user" }),
        appUser: async () => ({ id: "u1", role: "user" }),
        nowIso: () => "2026-11-15T00:00:00.000Z",
        cuid: () => `new-${Math.random().toString(36).slice(2, 10)}`,
        accessToken: async () => "token",
    };
});

import { BATCH_HANDLERS } from "@/lib/supabase/routes/batch";
import type { RouteContext } from "@/lib/supabase/http";

interface Row {
    id: string;
    idx: number;
    status: string;
    questionText?: string | null;
}

interface Caps {
    inserts: any[];
    itemPatches: { id: string; body: any }[];
    jobPatches: any[];
    deletes: string[];
    state: Map<string, Row>;
}

function harness(rows: Row[], opts: { jobStatus?: string; existing?: any[] } = {}): Caps {
    const state = new Map<string, Row>(rows.map((r) => [r.id, { ...r }]));
    const cap: Caps = { inserts: [], itemPatches: [], jobPatches: [], deletes: [], state };
    let jobStatus = opts.jobStatus ?? "confirming";

    restJsonMock.mockImplementation(async (path: string, init?: any) => {
        const method = init?.method || "GET";

        /* ---- BatchJob ---- */
        if (path.startsWith("/BatchJob?select=*") && method === "GET") {
            return [{ id: "job-1", userId: "u1", status: jobStatus, reasoningMode: "fast" }];
        }
        if (path.startsWith("/BatchJob?id=eq") && method === "PATCH") {
            const body = JSON.parse(init.body);
            cap.jobPatches.push(body);
            if (body.status) jobStatus = body.status;
            return [];
        }
        if (path.startsWith("/BatchJob") && method === "DELETE") {
            cap.deletes.push(path);
            return [];
        }
        if (path.startsWith("/BatchJob")) return []; // queued 查询等

        /* ---- BatchItem 查询 ---- */
        // finish 的条目查询：含 idx + questionText、不含 answerText
        if (path.startsWith("/BatchItem?select=id,idx,status,questionText&") && method === "GET") {
            return [...state.values()].map((r) => ({
                id: r.id, idx: r.idx, status: r.status, questionText: r.questionText,
            }));
        }
        // finish-preview 的条目查询：没有 idx
        if (path.startsWith("/BatchItem?select=id,status,questionText") && method === "GET") {
            return [...state.values()].map((r) => ({
                id: r.id, status: r.status, questionText: r.questionText,
            }));
        }
        // save 第一轮判定查询：带 thumbBase64 / answerText，按 id=in.(...) 过滤
        if (path.startsWith("/BatchItem?select=id,idx")
            && (path.includes("answerText") || path.includes("thumbBase64")) && method === "GET") {
            const m = path.match(/id=in\.\(([^)]*)\)/);
            const ids = m ? m[1].split(",").map((s) => s.replace(/^"|"$/g, "")) : [];
            return [...state.values()]
                .filter((r) => ids.includes(r.id))
                .map((r) => ({
                    id: r.id, idx: r.idx, status: r.status, questionText: r.questionText,
                    answerText: "答", analysis: "解析", subjectId: null, subjectName: "数学",
                    gradeSemester: null, knowledgePoints: "[]", userGuidance: null,
                    thumbBase64: null,
                }));
        }
        // finalizeJob / finish 的 latest / discard 的单条查询
        if (path.startsWith("/BatchItem?select=") && method === "GET") {
            const one = path.match(/[?&]id=eq\.([^&]+)/);
            const rows = [...state.values()];
            if (one) {
                const id = decodeURIComponent(one[1]);
                return rows.filter((r) => r.id === id).map((r) => ({
                    id: r.id, idx: r.idx, status: r.status, questionText: r.questionText,
                }));
            }
            return rows.map((r) => ({ id: r.id, idx: r.idx, status: r.status }));
        }
        // 补原图（两条路径）
        if (path.startsWith("/BatchItem?select=id,imageBase64")) return [];
        if (path.startsWith("/BatchItem?select=imageBase64&id=eq")) return [];

        /* ---- BatchItem 写入 ---- */
        if (path.startsWith("/BatchItem?id=eq") && method === "PATCH") {
            const id = decodeURIComponent(path.slice("/BatchItem?id=eq.".length));
            const body = JSON.parse(init.body);
            cap.itemPatches.push({ id, body });
            const cur = state.get(id);
            if (cur && body.status) cur.status = body.status;
            return [];
        }
        if (path.startsWith("/BatchItem") && method === "DELETE") {
            cap.deletes.push(path);
            return [];
        }
        if (path.startsWith("/BatchItem")) return [];

        /* ---- ErrorItem / 标签 ---- */
        if (path.startsWith("/ErrorItem?select=questionText,gradeSemester")) {
            return opts.existing ?? [];
        }
        if (path === "/ErrorItem" && method === "POST") {
            const body = JSON.parse(init.body);
            cap.inserts.push(...(Array.isArray(body) ? body : [body]));
            return [];
        }
        if (path.startsWith("/ErrorItem") && method === "DELETE") {
            cap.deletes.push(path);
            return [];
        }
        if (path.startsWith("/KnowledgeTag")) return [];
        if (path.startsWith("/_ErrorItemToKnowledgeTag")) return [];
        return [];
    });
    return cap;
}

function makeCtx(action: string, body: any, method = "POST", query = new URLSearchParams()): RouteContext {
    return {
        method,
        path: `/api/batch/${action}`,
        parts: ["batch", action],
        query,
        body,
        signal: undefined,
    } as RouteContext;
}

async function run(action: string, body: any = {}, method = "POST", query = new URLSearchParams()) {
    for (const h of BATCH_HANDLERS) {
        const res = await h(makeCtx(action, body, method, query));
        if (res) return res;
    }
    return null;
}

const baseRows: Row[] = [
    { id: "a", idx: 0, status: "done", questionText: "题干A" },
    { id: "b", idx: 1, status: "done", questionText: "题干B" },
    { id: "c", idx: 2, status: "failed", questionText: null },
    { id: "d", idx: 3, status: "pending", questionText: null },
    { id: "e", idx: 4, status: "saved", questionText: "已入库题" },
];

describe("结束批次：解析成功自动入库、未成功自动舍弃", () => {
    beforeEach(() => { restJsonMock.mockReset(); });

    it("2 条 done 入库、failed/pending 舍弃并清原图，批次归档为 done", async () => {
        const cap = harness(baseRows);
        const res = await run("finish", { jobId: "job-1" });
        expect(res?.status).toBe(200);
        const data: any = await res!.json();
        expect(data.saved).toBe(2);
        expect(data.discarded).toBe(2);
        expect(cap.inserts).toHaveLength(2);
        // 舍弃的条目都清了原图、写了原因
        for (const id of ["c", "d"]) {
            const p = cap.itemPatches.find((x) => x.id === id && x.body.status === "discarded");
            expect(p?.body.imageBase64).toBe("");
            expect(p?.body.failureReason).toBeTruthy();
        }
        // 已入库的条目完全没被动过
        expect(cap.itemPatches.some((x) => x.id === "e")).toBe(false);
        expect(cap.state.get("e")?.status).toBe("saved");
        // 最终归档
        expect(cap.jobPatches.at(-1)?.status).toBe("done");
        expect(cap.jobPatches.at(-1)?.finishedAt).toBeTruthy();
    });

    it("processing 中点结束：第一笔 Job 写入就是 done，先拦住后台再干活", async () => {
        const cap = harness(baseRows, { jobStatus: "processing" });
        const res = await run("finish", { jobId: "job-1" });
        expect(res?.status).toBe(200);
        expect(cap.jobPatches[0]?.status).toBe("done");
        expect(cap.inserts).toHaveLength(2);
    });

    it("任何情况下都不删除已入库的错题", async () => {
        const cap = harness(baseRows);
        await run("finish", { jobId: "job-1" });
        expect(cap.deletes).toHaveLength(0);
        expect(cap.inserts.every((r) => r.questionText)).toBe(true);
    });

    it("已结束的批次重复点结束是幂等的，不会再入库", async () => {
        const cap = harness(baseRows, { jobStatus: "done" });
        const res = await run("finish", { jobId: "job-1" });
        const data: any = await res!.json();
        expect(data.already).toBe(true);
        expect(cap.inserts).toHaveLength(0);
        expect(cap.itemPatches).toHaveLength(0);
    });

    it("预览数字与执行口径一致", async () => {
        harness(baseRows);
        const res = await run("finish-preview", {}, "GET", new URLSearchParams({ id: "job-1" }));
        const data: any = await res!.json();
        expect(data).toMatchObject({ toSave: 2, toDiscard: 2, saved: 1, total: 5 });
    });
});

describe("静默跳过不再让批次卡在 confirming", () => {
    beforeEach(() => { restJsonMock.mockReset(); });

    it("空题干 / 与已有错题重复的条目自动标 discarded 并清图，批次收尾", async () => {
        const rows: Row[] = [
            { id: "x", idx: 0, status: "done", questionText: "" },
            { id: "y", idx: 1, status: "done", questionText: "已有题" },
            { id: "z", idx: 2, status: "saved", questionText: "旧题" },
        ];
        const cap = harness(rows, { existing: [{ questionText: "已有题", gradeSemester: "高一上" }] });
        const res = await run("save", { jobId: "job-1", itemIds: ["x", "y"], final: true });
        expect(res?.status).toBe(200);
        expect(cap.inserts).toHaveLength(0);
        for (const id of ["x", "y"]) {
            const p = cap.itemPatches.find((v) => v.id === id);
            expect(p?.body.status).toBe("discarded");
            expect(p?.body.imageBase64).toBe("");
            expect(p?.body.failureReason).toBeTruthy();
        }
        // 旧判定要求所有 done 归零；现在 discarded 也算终态，批次能正常结束
        expect(cap.jobPatches.at(-1)?.status).toBe("done");
    });
});

describe("单条舍弃", () => {
    beforeEach(() => { restJsonMock.mockReset(); });

    it("舍弃后不入库、清原图；若已是最后一条未处理条目则自动归档", async () => {
        const rows: Row[] = [
            { id: "a", idx: 0, status: "done", questionText: "题干A" },
            { id: "e", idx: 1, status: "saved", questionText: "已入库题" },
        ];
        const cap = harness(rows);
        const res = await run("discard", { jobId: "job-1", itemId: "a" });
        expect(res?.status).toBe(200);
        const p = cap.itemPatches.find((x) => x.id === "a");
        expect(p?.body.status).toBe("discarded");
        expect(p?.body.imageBase64).toBe("");
        expect(cap.inserts).toHaveLength(0);
        expect(cap.state.get("e")?.status).toBe("saved");
        expect(cap.jobPatches.at(-1)?.status).toBe("done");
    });

    it("已入库的条目不允许舍弃", async () => {
        const cap = harness(baseRows);
        const res = await run("discard", { jobId: "job-1", itemId: "e" });
        expect(res?.status).toBe(400);
        expect(cap.itemPatches).toHaveLength(0);
    });
});
