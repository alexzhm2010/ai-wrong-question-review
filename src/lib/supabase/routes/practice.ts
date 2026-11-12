/** 练习记录 / 统计 / 生成练习题 / 数据导入导出 */
import { APP_VERSION } from "../config";
import { aiEdge, byId, cuid, nowIso, requireUser, restJson } from "../core";
import { json, type RouteContext, type RouteHandler } from "../http";

async function handlePracticeStats(ctx: RouteContext): Promise<Response | null> {
  const [root, sub, action] = ctx.parts;
  if (root !== "stats" || sub !== "practice") return null;

  if (action === "clear" && ctx.method === "DELETE") {
    const rows = await restJson<any[]>("/PracticeRecord?select=id").catch(() => []);
    // 一次 DELETE ... id=in.(...) 取代 N 次串行往返（旧实现每条一次请求）
    let deleted = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const inList = chunk.map((r) => `"${String(r.id).replace(/"/g, "")}"`).join(",");
      const ok = await restJson(`/PracticeRecord?id=in.(${inList})`, { method: "DELETE" })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        deleted += chunk.length;
      } else {
        // 批量被拒时退回逐条，保证功能可用
        await Promise.all(
          chunk.map((r) =>
            restJson(byId("PracticeRecord", r.id), { method: "DELETE" })
              .then(() => { deleted++; })
              .catch(() => {}),
          ),
        );
      }
    }
    return json({ success: true, deleted });
  }
  if (!action && ctx.method === "GET") {
    // 只统计用得到 4 列；旧实现 select=* 把每条记录全字段拉回
    const rows = await restJson<any[]>(
      "/PracticeRecord?select=subject,difficulty,isCorrect,createdAt",
    ).catch(() => []);
    const bySubject: Record<string, number> = {};
    const byDifficulty: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    for (const row of rows) {
      const s = row.subject || "Unknown";
      const d = row.difficulty || "Unknown";
      bySubject[s] = (bySubject[s] || 0) + 1;
      byDifficulty[d] = (byDifficulty[d] || 0) + 1;
      const day = String(row.createdAt || "").slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    const total = rows.length;
    const correct = rows.filter((r) => r.isCorrect).length;
    return json({
      subjectStats: Object.entries(bySubject).map(([name, value]) => ({ name, value })),
      activityStats: Object.entries(byDay).sort().map(([date, count]) => ({ date, count })),
      difficultyStats: Object.entries(byDifficulty).map(([name, value]) => ({ name, value })),
      overallStats: {
        total,
        correct,
        rate: total ? Number(((correct / total) * 100).toFixed(1)) : 0,
      },
    });
  }
  return null;
}

async function handlePractice(ctx: RouteContext): Promise<Response | null> {
  const [root, sub] = ctx.parts;
  if (root !== "practice") return null;

  if (sub === "record" && ctx.method === "POST") {
    const user = await requireUser();
    const row = {
      id: cuid(),
      userId: user.id,
      subject: ctx.body?.subject ?? null,
      difficulty: ctx.body?.difficulty ?? null,
      isCorrect: ctx.body?.isCorrect ?? null,
      createdAt: nowIso(),
    };
    const created = await restJson<any[]>("/PracticeRecord", {
      method: "POST",
      body: JSON.stringify(row),
    });
    return json(created?.[0] || row, 201);
  }
  if (sub === "generate") {
    return aiEdge("practice_generate", ctx.body, ctx.signal);
  }
  return null;
}

async function handleExport(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "export" || ctx.method !== "GET") return null;
  /**
   * 导出要全量数据（含原图），但一条 7.6MB 的响应在跨境链路上极易超时。
   * 改为按 100 条分页并发取，单次响应控制在 1MB 级，最后在内存里拼装。
   */
  const PAGE = 100;
  const first = await restJson<any[]>(
    `/ErrorItem?select=*&order=createdAt.desc&limit=${PAGE}&offset=0`,
  ).catch(() => []);
  const items: any[] = Array.isArray(first) ? [...first] : [];
  if (items.length === PAGE) {
    const tailPages = await Promise.all(
      [1, 2, 3, 4, 5].map((p) =>
        restJson<any[]>(
          `/ErrorItem?select=*&order=createdAt.desc&limit=${PAGE}&offset=${p * PAGE}`,
        ).catch(() => [] as any[]),
      ),
    );
    for (const page of tailPages) {
      if (!Array.isArray(page) || !page.length) break;
      items.push(...page);
      if (page.length < PAGE) break;
    }
  }
  const notebooks = await restJson<any[]>("/Subject?select=*").catch(() => []);
  return json({ version: APP_VERSION, exportedAt: nowIso(), notebooks, errorItems: items });
}

async function handleImport(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "import" || ctx.method !== "POST") return null;
  const user = await requireUser();
  const items: any[] = ctx.body?.errorItems || ctx.body?.items || [];
  if (!items.length) return json({ success: true, imported: 0, total: 0 });

  const rows = items.map((item) => ({
    id: cuid(),
    userId: user.id,
    subjectId: item.subjectId || null,
    originalImageUrl: item.originalImageUrl || "",
    ocrText: item.ocrText ?? null,
    questionText: item.questionText ?? null,
    answerText: item.answerText ?? null,
    analysis: item.analysis ?? null,
    wrongAnswerText: item.wrongAnswerText ?? null,
    mistakeAnalysis: item.mistakeAnalysis ?? null,
    mistakeStatus: item.mistakeStatus ?? null,
    userNotes: item.userNotes ?? null,
    masteryLevel: item.masteryLevel ?? 0,
    gradeSemester: item.gradeSemester ?? null,
    paperLevel: item.paperLevel ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }));

  /**
   * 旧实现每条一次 POST，导入 100 条要串行 100 个往返（跨境链路 20 秒以上）。
   * 改为每 50 条一次数组插入；整批失败时仅对该批回退逐条，避免一条脏数据毁掉全部导入。
   */
  let imported = 0;
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ok = await restJson("/ErrorItem", {
      method: "POST",
      body: JSON.stringify(chunk),
      headers: { Prefer: "return=minimal" },
    }).then(() => true).catch(() => false);
    if (ok) {
      imported += chunk.length;
      continue;
    }
    const settled = await Promise.allSettled(
      chunk.map((row) => restJson("/ErrorItem", { method: "POST", body: JSON.stringify(row) })),
    );
    imported += settled.filter((r) => r.status === "fulfilled").length;
  }
  return json({ success: true, imported, total: items.length });
}

export const PRACTICE_HANDLERS: RouteHandler[] = [
  handlePracticeStats,
  handlePractice,
  handleExport,
  handleImport,
];
