/** 知识点标签（层级树 / 统计 / 联想 / 一次性初始化）与学习分析 */
import { appUser, cuid, nowIso, requireUser, restJson, restJsonPage } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";
import { getTagIndex, invalidateTagIndex } from "./shared";

/** 树/扁平列表只需要这 6 列；旧实现 select=* 连 code、时间戳一起拉，单学科 179KB */
const TAG_FIELDS = "id,name,subject,isSystem,parentId,order";

/**
 * 按学科读取标签。PostgREST 服务端 max_rows=1000，必须按 id 稳定分页取全。
 * systemOnly=true 用于「标准标签库」树：前端只渲染系统标签，自定义标签
 * 有自己的 Tab，没必要把 15 条自定义也混进来。
 */
async function loadTags(subject?: string | null, systemOnly = false): Promise<any[]> {
  const filter = subject ? `&subject=eq.${encodeURIComponent(subject)}` : "";
  const sys = systemOnly ? "&isSystem=eq.true" : "";
  const pageSize = 1000;
  const rows: any[] = [];
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const page = await restJson<any[]>(
      `/KnowledgeTag?select=${TAG_FIELDS}${filter}${sys}&order=id.asc&limit=${pageSize}&offset=${offset}`,
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

function buildTree(tags: any[], parentId: string | null): any[] {
  return tags
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
      children: buildTree(tags, t.id),
    }));
}

/** 使用频次 Top20：只取 knowledgePoints 一列，按当前用户隔离 */
async function tagUsageStats(): Promise<{ tag: string; count: number }[]> {
  const user = await appUser().catch(() => null);
  const userFilter = user?.id ? `&userId=eq.${encodeURIComponent(user.id)}` : "";
  const itemRows = await restJson<any[]>(
    `/ErrorItem?select=knowledgePoints${userFilter}&limit=5000`,
  ).catch(() => []);
  const counts = new Map<string, number>();
  for (const row of itemRows || []) {
    for (const name of parseKnowledgePoints(row?.knowledgePoints)) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"))
    .slice(0, 20);
}

/** 三个计数用 head-style count 查询，不再为数 3 个数字拉 1809 行全表 */
async function tagCounts(): Promise<{ total: number; system: number; custom: number }> {
  const count = async (filter: string) => {
    const r = await restJsonPage<any[]>(
      `/KnowledgeTag?select=id&limit=1${filter}`,
    ).catch(() => ({ data: [], total: 0 }));
    return r.total || 0;
  };
  const [total, system] = await Promise.all([count(""), count("&isSystem=eq.true")]);
  return { total, system, custom: Math.max(0, total - system) };
}

async function handleTags(ctx: RouteContext): Promise<Response | null> {
  const [root, sub] = ctx.parts;
  if (root !== "tags") return null;

  /**
   * 标签管理页一次性初始化：树 / 年级下拉 / 自定义标签 / 统计合并成一次调用。
   * 旧版前端发 3 个请求（stats、flat&all、subject=math），后端内部又各自分页
   * 拉全表 4 次，总计 8 个接口 850KB；现在前端 1 个请求，后端 5 个精简查询并行。
   */
  if (sub === "bootstrap" && ctx.method === "GET") {
    // 不预拉学科树：页面 9 个学科卡片默认全是折叠的，用户点开哪个再取哪个，
    // 首屏没必要为 math 单科背 105KB 树数据。
    const [gradeRows, customRows, stats, totals] = await Promise.all([
      restJson<any[]>(
        "/KnowledgeTag?select=id,name,subject&parentId=is.null&isSystem=eq.true&limit=500",
      ).catch(() => []),
      restJson<any[]>(
        "/KnowledgeTag?select=id,name,subject,parentId&isSystem=eq.false&limit=1000",
      ).catch(() => []),
      tagUsageStats(),
      tagCounts(),
    ]);

    // 自定义标签的父节点名：只按这十几个 parentId 精确查，不拉全表
    const parentIds = [...new Set((customRows || []).map((t) => t.parentId).filter(Boolean))];
    let parentNames = new Map<string, string>();
    if (parentIds.length) {
      const inList = parentIds.map((id) => `"${String(id).replace(/"/g, "")}"`).join(",");
      const parents = await restJson<any[]>(
        `/KnowledgeTag?select=id,name&id=in.(${inList})`,
      ).catch(() => []);
      parentNames = new Map((parents || []).map((p) => [p.id, p.name]));
    }

    const grades: Record<string, { id: string; name: string }[]> = {};
    for (const g of gradeRows || []) {
      const key = String(g.subject || "math");
      if (!grades[key]) grades[key] = [];
      grades[key].push({ id: g.id, name: g.name });
    }

    return json({
      subject: ctx.query.get("subject") || "math",
      grades,
      customTags: (customRows || []).map((t) => ({
        id: t.id,
        name: t.name,
        subject: t.subject || "math",
        parentName: t.parentId ? parentNames.get(t.parentId) || null : null,
      })),
      stats,
      ...totals,
    });
  }

  if (!sub) {
    if (ctx.method === "GET") {
      const subject = ctx.query.get("subject");
      const flat = ctx.query.get("flat") === "true";
      const allSubjects = ctx.query.get("all") === "true";
      if (!subject && !(flat && allSubjects)) return apiError(400, "Subject is required");
      const tags = allSubjects ? await getTagIndex() : await loadTags(subject, !flat);

      if (flat) {
        const byId = new Map((tags as any[]).map((t) => [t.id, t]));
        return json({
          tags: (tags as any[]).map((t) => ({
            id: t.id,
            name: t.name,
            subject: t.subject,
            isSystem: t.isSystem,
            parentId: t.parentId,
            parentName: byId.get(t.parentId)?.name || null,
          })),
        });
      }
      return json({ tags: buildTree(tags as any[], null) });
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
      invalidateTagIndex();
      return json(created?.[0] || row, 201);
    }
    if (ctx.method === "DELETE") {
      const id = ctx.query.get("id");
      if (id) {
        await requireUser();
        // 只允许删自定义标签；系统标签是共享题库基础设施
        await restJson(`/KnowledgeTag?id=eq.${encodeURIComponent(id)}&isSystem=eq.false`, {
          method: "DELETE",
        }).catch(() => {});
        invalidateTagIndex();
      }
      return json({ success: true });
    }
    return null;
  }

  if (sub === "stats") {
    // 前端 TagStatsResponse 期望 { stats: [{ tag, count }] }，旧实现只返回
    // { total, system, custom }，导致 setStats(undefined) 后读 stats.length 整页崩溃。
    const [stats, totals] = await Promise.all([tagUsageStats(), tagCounts()]);
    return json({ ...totals, stats });
  }
  if (sub === "suggestions") {
    // 只按输入模糊查前 20 个标签名，不再拉整学科几百行到浏览器再过滤
    const q = (ctx.query.get("q") || ctx.query.get("query") || "").replace(/[\\*,()%"']/g, " ").trim();
    const subject = ctx.query.get("subject");
    const params = new URLSearchParams();
    params.set("select", "name");
    params.set("limit", "60");
    if (subject) params.append("subject", `eq.${subject}`);
    if (q) params.append("name", `ilike.*${q}*`);
    const rows = await restJson<any[]>(`/KnowledgeTag?${params.toString()}`).catch(() => []);
    const names = [...new Set((rows || []).map((t) => String(t.name || "").trim()).filter(Boolean))];
    return json({ suggestions: names.slice(0, 20) });
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
