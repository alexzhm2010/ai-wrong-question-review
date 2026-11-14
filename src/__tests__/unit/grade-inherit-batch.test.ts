/**
 * 批量「一键全部入库」的年级兜底回归测试。
 *
 * 这是本次缺陷的根因入口：该路径不打开校对编辑器，历史实现直接把
 * gradeSemester: item.gradeSemester || null 写进 ErrorItem，整批年级为空。
 * 这里用按路径分派的 REST mock 跑完整 save handler，断言年级确实被写进
 * ErrorItem，并同步回 BatchItem 留档。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ restJson: vi.fn() }));
const restJsonMock = mocks.restJson;

vi.mock("@/lib/supabase/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/supabase/core")>();
    let seq = 0;
    return {
        ...actual,
        restJson: mocks.restJson,
        requireUser: async () => ({ id: "u1", role: "user" }),
        appUser: async () => ({ id: "u1", role: "user" }),
        nowIso: () => "2026-11-14T00:00:00.000Z",
        cuid: () => `new-${++seq}`,
        accessToken: async () => "token",
    };
});

import { BATCH_HANDLERS } from "@/lib/supabase/routes/batch";
import type { RouteContext } from "@/lib/supabase/http";

interface Captured {
    inserts: any[];
    itemPatches: { path: string; body: any }[];
}

function setup(opts: {
    existing: any[];
    itemGrade?: string | null;
    questionText?: string;
}) {
    const cap: Captured = { inserts: [], itemPatches: [] };
    const item = {
        id: "bi-1",
        idx: 0,
        status: "done",
        questionText: opts.questionText ?? "本题题干ABC",
        answerText: "答",
        analysis: "解析",
        subjectId: null,
        subjectName: "数学",
        gradeSemester: opts.itemGrade === undefined ? null : opts.itemGrade,
        knowledgePoints: "[]",
        thumbBase64: null,
    };

    restJsonMock.mockImplementation(async (path: string, init?: any) => {
        const method = init?.method || "GET";
        if (path.startsWith("/BatchJob?select=*")) {
            return [{ id: "job-1", userId: "u1", status: "confirming" }];
        }
        if (path.startsWith("/BatchItem?select=id,idx") && method === "GET") {
            return [item];
        }
        if (path.startsWith("/ErrorItem?select=questionText,gradeSemester")) {
            return opts.existing;
        }
        if (path.startsWith("/KnowledgeTag")) return [];
        if (path.startsWith("/BatchItem?select=id,imageBase64")) return [];
        if (path.startsWith("/BatchItem?select=imageBase64&id=eq")) return [];
        if (path === "/ErrorItem" && method === "POST") {
            const body = JSON.parse(init.body);
            cap.inserts.push(...(Array.isArray(body) ? body : [body]));
            return [];
        }
        if (path.startsWith("/BatchItem?id=eq") && method === "PATCH") {
            cap.itemPatches.push({ path, body: JSON.parse(init.body) });
            return [];
        }
        if (path.startsWith("/BatchJob?id=eq") && method === "PATCH") return [];
        return [];
    });
    return cap;
}

function ctx(): RouteContext {
    return {
        method: "POST",
        path: "/api/batch/save",
        parts: ["batch", "save"],
        query: new URLSearchParams(),
        body: { jobId: "job-1", itemIds: ["bi-1"], final: false },
        signal: undefined,
    } as RouteContext;
}

async function runSave() {
    for (const h of BATCH_HANDLERS) {
        const res = await h(ctx());
        if (res) return res;
    }
    return null;
}

describe("批量入库：年级沿用规则", () => {
    beforeEach(() => { restJsonMock.mockReset(); });

    it("条目无年级 → 写入 ErrorItem 的年级 = 最近一次保存的年级", async () => {
        const cap = setup({ existing: [{ questionText: "旧题", gradeSemester: "高一上" }] });
        const res = await runSave();
        expect(res?.status).toBe(200);
        expect(cap.inserts).toHaveLength(1);
        expect(cap.inserts[0].gradeSemester).toBe("高一上");
    });

    it("沿用值同步回 BatchItem 留档，批次页与详情页一致", async () => {
        const cap = setup({ existing: [{ questionText: "旧题", gradeSemester: "高一上" }] });
        await runSave();
        const saved = cap.itemPatches.find((p) => p.body.status === "saved");
        expect(saved?.body.gradeSemester).toBe("高一上");
    });

    it("条目自带有效年级时不覆盖（校对页手选优先）", async () => {
        const cap = setup({
            existing: [{ questionText: "旧题", gradeSemester: "高一上" }],
            itemGrade: "高二下",
        });
        await runSave();
        expect(cap.inserts[0].gradeSemester).toBe("高二下");
    });

    it("条目明确「未设置」时尊重用户，不强行沿用", async () => {
        const cap = setup({
            existing: [{ questionText: "旧题", gradeSemester: "高一上" }],
            itemGrade: "",
        });
        await runSave();
        expect(cap.inserts[0].gradeSemester).toBe("");
    });

    it("库里也没有历史年级 → 留空，不编造", async () => {
        const cap = setup({ existing: [{ questionText: "旧题", gradeSemester: null }] });
        await runSave();
        expect(cap.inserts[0].gradeSemester).toBeNull();
    });

    it("最近值是历史脏值时跳过，取再往前一个有效值", async () => {
        const cap = setup({
            existing: [
                { questionText: "旧题1", gradeSemester: "已毕业上" },
                { questionText: "旧题2", gradeSemester: "高一上" },
            ],
        });
        await runSave();
        expect(cap.inserts[0].gradeSemester).toBe("高一上");
    });

    it("同批所有条目共用同一个沿用值", async () => {
        const cap = setup({ existing: [{ questionText: "旧题", gradeSemester: "高一上" }] });
        // 造两条：一条无年级、一条自带有效值
        restJsonMock.mockImplementation(async (path: string, init?: any) => {
            const method = init?.method || "GET";
            if (path.startsWith("/BatchJob?select=*")) return [{ id: "job-1", userId: "u1", status: "confirming" }];
            if (path.startsWith("/BatchItem?select=id,idx") && method === "GET") {
                return [
                    { id: "bi-1", idx: 0, status: "done", questionText: "题干A", gradeSemester: null, knowledgePoints: "[]" },
                    { id: "bi-2", idx: 1, status: "done", questionText: "题干B", gradeSemester: null, knowledgePoints: "[]" },
                ];
            }
            if (path.startsWith("/ErrorItem?select=questionText,gradeSemester")) {
                return [{ questionText: "旧题", gradeSemester: "高一上" }];
            }
            if (path.startsWith("/KnowledgeTag")) return [];
            if (path.startsWith("/BatchItem?select=id,imageBase64")) return [];
            if (path.startsWith("/BatchItem?select=imageBase64&id=eq")) return [];
            if (path === "/ErrorItem" && method === "POST") {
                const body = JSON.parse(init.body);
                cap.inserts.push(...(Array.isArray(body) ? body : [body]));
                return [];
            }
            if (path.startsWith("/BatchItem?id=eq") && method === "PATCH") {
                cap.itemPatches.push({ path, body: JSON.parse(init.body) });
                return [];
            }
            return [];
        });
        await runSave();
        expect(cap.inserts).toHaveLength(2);
        expect(cap.inserts.map((r) => r.gradeSemester)).toEqual(["高一上", "高一上"]);
    });
});
