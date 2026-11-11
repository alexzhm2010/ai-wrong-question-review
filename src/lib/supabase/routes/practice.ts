/** 练习记录 / 统计 / 生成练习题 / 数据导入导出 */
import { APP_VERSION } from "../config";
import { aiEdge, byId, cuid, nowIso, requireUser, restJson } from "../core";
import { json, type RouteContext, type RouteHandler } from "../http";

async function handlePracticeStats(ctx: RouteContext): Promise<Response | null> {
  const [root, sub, action] = ctx.parts;
  if (root !== "stats" || sub !== "practice") return null;

  if (action === "clear" && ctx.method === "DELETE") {
    const rows = await restJson<any[]>("/PracticeRecord?select=id").catch(() => []);
    for (const row of rows) {
      await restJson(byId("PracticeRecord", row.id), { method: "DELETE" }).catch(() => {});
    }
    return json({ success: true, deleted: rows.length });
  }
  if (!action && ctx.method === "GET") {
    const rows = await restJson<any[]>("/PracticeRecord?select=*").catch(() => []);
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
  const items = await restJson<any[]>("/ErrorItem?select=*&order=createdAt.desc").catch(() => []);
  const notebooks = await restJson<any[]>("/Subject?select=*").catch(() => []);
  return json({ version: APP_VERSION, exportedAt: nowIso(), notebooks, errorItems: items });
}

async function handleImport(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "import" || ctx.method !== "POST") return null;
  const user = await requireUser();
  const items: any[] = ctx.body?.errorItems || ctx.body?.items || [];
  let imported = 0;
  for (const item of items) {
    const row = {
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
    };
    await restJson("/ErrorItem", { method: "POST", body: JSON.stringify(row) })
      .then(() => imported++)
      .catch(() => {});
  }
  return json({ success: true, imported, total: items.length });
}

export const PRACTICE_HANDLERS: RouteHandler[] = [
  handlePracticeStats,
  handlePractice,
  handleExport,
  handleImport,
];
