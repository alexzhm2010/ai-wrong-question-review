/** 知识点标签（层级树 / 统计 / 联想）与学习分析 */
import { cuid, nowIso, requireUser, restJson } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";

async function handleTags(ctx: RouteContext): Promise<Response | null> {
  const [root, sub] = ctx.parts;
  if (root !== "tags") return null;

  const all = await restJson<any[]>("/KnowledgeTag?select=*").catch(() => []);

  if (!sub) {
    if (ctx.method === "GET") {
      const subject = ctx.query.get("subject");
      if (!subject) return apiError(400, "Subject is required");
      const tags = all.filter((t) => t.subject === subject);
      if (ctx.query.get("flat") === "true") {
        return json({
          tags: tags
            .filter((t) => !tags.some((x) => x.parentId === t.id))
            .map((t) => ({
              id: t.id,
              name: t.name,
              isSystem: t.isSystem,
              parentId: t.parentId,
              parentName: tags.find((x) => x.id === t.parentId)?.name || null,
            })),
        });
      }
      const buildTree = (parentId: string | null): any[] =>
        tags
          .filter((t) => (t.parentId || null) === parentId)
          .sort(
            (a, b) =>
              (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)),
          )
          .map((t) => ({
            id: t.id,
            name: t.name,
            isSystem: t.isSystem,
            parentId: t.parentId,
            children: buildTree(t.id),
          }));
      return json({ tags: buildTree(null) });
    }
    if (ctx.method === "POST") {
      const user = await requireUser();
      const row = {
        id: cuid(),
        name: ctx.body?.name,
        subject: ctx.body?.subject,
        parentId: ctx.body?.parentId || null,
        order: ctx.body?.order ?? 0,
        code: ctx.body?.code || null,
        isSystem: false,
        userId: user.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const created = await restJson<any[]>("/KnowledgeTag", {
        method: "POST",
        body: JSON.stringify(row),
      });
      return json(created?.[0] || row, 201);
    }
    return null;
  }

  if (sub === "stats") {
    return json({
      total: all.length,
      system: all.filter((t) => t.isSystem).length,
      custom: all.filter((t) => !t.isSystem).length,
    });
  }
  if (sub === "suggestions") {
    const q = (ctx.query.get("q") || ctx.query.get("query") || "").toLowerCase();
    return json({
      suggestions: all
        .filter((t) => !q || String(t.name).toLowerCase().includes(q))
        .slice(0, 20)
        .map((t) => ({ id: t.id, name: t.name })),
    });
  }
  return null;
}

async function handleAnalytics(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "analytics") return null;
  const items = await restJson<any[]>("/ErrorItem?select=*").catch(() => []);
  const mastered = items.filter((i) => i.masteryLevel >= 2).length;
  const byGrade: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const item of items) {
    const grade = item.gradeSemester || "未分类";
    byGrade[grade] = (byGrade[grade] || 0) + 1;
    const day = String(item.createdAt || "").slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return json({
    totalErrors: items.length,
    masteredCount: mastered,
    masteryRate: items.length ? Number(((mastered / items.length) * 100).toFixed(1)) : 0,
    subjectStats: Object.entries(byGrade).map(([name, value]) => ({ name, value })),
    activityData: Object.entries(byDay).sort().map(([date, count]) => ({ date, count })),
  });
}

export const TAG_HANDLERS: RouteHandler[] = [handleTags, handleAnalytics];
