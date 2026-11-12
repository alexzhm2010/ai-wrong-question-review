/** 知识点标签（层级树 / 统计 / 联想）与学习分析 */
import { appUser, cuid, nowIso, requireUser, restJson } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";

/**
 * 按学科读取标签。系统标签共 1800+ 行，旧实现每次请求都 `select=*` 拉全表，
 * 标签管理页一进来就要重复十几次，既慢又可能被 PostgREST 默认行数截断。
 * 这里按 subject 下推；扁平列表/计数用裁剪字段并显式放宽 limit。
 */
async function loadTags(subject?: string | null, lean = false): Promise<any[]> {
  const select = lean ? "id,name,subject,isSystem,parentId" : "*";
  const filter = subject ? `&subject=eq.${encodeURIComponent(subject)}` : "";
  // Supabase PostgREST 有服务端 max_rows=1000：就算客户端写 limit=5000 也会被截断，
  // 实测 1809 条标签只返回 1000 条，会丢掉 5 个自定义标签。必须按 id 稳定分页取全。
  const pageSize = 1000;
  const rows: any[] = [];
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const page = await restJson<any[]>(
      `/KnowledgeTag?select=${select}${filter}&order=id.asc&limit=${pageSize}&offset=${offset}`,
    ).catch(() => []);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/** 解析 ErrorItem.knowledgePoints（JSON 文本或数组） */
function parseKnowledgePoints(raw: any): string[] {
  let points: any = raw;
  if (typeof points === "string") {
    try {
      points = JSON.parse(points);
    } catch {
      points = [];
    }
  }
  if (!Array.isArray(points)) return [];
  return points
    .map((p) => (typeof p === "string" ? p : p && typeof p === "object" ? String(p.name || "") : ""))
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handleTags(ctx: RouteContext): Promise<Response | null> {
  const [root, sub] = ctx.parts;
  if (root !== "tags") return null;

  if (!sub) {
    if (ctx.method === "GET") {
      const subject = ctx.query.get("subject");
      const flat = ctx.query.get("flat") === "true";
      const allSubjects = ctx.query.get("all") === "true";
      if (!subject && !(flat && allSubjects)) return apiError(400, "Subject is required");
      const tags = await loadTags(allSubjects ? null : subject, flat);

      if (flat) {
        // 旧实现只返回「没有子标签」的节点，挂了子标签的自定义标签会凭空消失。
        // 前端会自行过滤 isSystem，这里返回完整扁平列表并带上学科与父节点名。
        const byId = new Map(tags.map((t) => [t.id, t]));
        return json({
          tags: tags.map((t) => ({
            id: t.id,
            name: t.name,
            subject: t.subject,
            isSystem: t.isSystem,
            parentId: t.parentId,
            parentName: byId.get(t.parentId)?.name || null,
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
    // 前端 TagStatsResponse 期望 { stats: [{ tag, count }] }，旧实现只返回
    // { total, system, custom }，导致 setStats(undefined) 后读 stats.length 整页崩溃。
    // 使用频次来自错题的 knowledgePoints（比关联表更全），按当前用户隔离。
    const user = await appUser().catch(() => null);
    const userFilter = user?.id ? `&userId=eq.${encodeURIComponent(user.id)}` : "";
    const [tagRows, itemRows] = await Promise.all([
      loadTags(null, true),
      restJson<any[]>(`/ErrorItem?select=knowledgePoints${userFilter}&limit=5000`).catch(() => []),
    ]);

    const counts = new Map<string, number>();
    for (const row of itemRows) {
      for (const name of parseKnowledgePoints(row?.knowledgePoints)) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    const stats = [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"))
      .slice(0, 20);

    return json({
      total: tagRows.length,
      system: tagRows.filter((t) => t.isSystem).length,
      custom: tagRows.filter((t) => !t.isSystem).length,
      stats,
    });
  }
  if (sub === "suggestions") {
    // tag-input.tsx 的 TagSuggestionsResponse 是 string[]，旧实现返回对象数组，
    // 渲染时会把对象当 React 子节点而报错。
    const q = (ctx.query.get("q") || ctx.query.get("query") || "").toLowerCase();
    const subject = ctx.query.get("subject");
    const all = await loadTags(subject, true);
    const names = [...new Set(all.map((t) => String(t.name || "").trim()).filter(Boolean))];
    return json({
      suggestions: names.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 20),
    });
  }
  return null;
}

async function handleAnalytics(ctx: RouteContext): Promise<Response | null> {
  if (ctx.parts[0] !== "analytics") return null;
  // 只要三个统计字段，绝不把含原图的全表拉回浏览器。
  const items = await restJson<any[]>(
    "/ErrorItem?select=masteryLevel,gradeSemester,createdAt&limit=5000",
  ).catch(() => []);
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
