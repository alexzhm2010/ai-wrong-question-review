/** 管理员后台：仪表盘、用户管理、系统重置 */
import { byId, requireAdmin, restJson, rpc } from "../core";
import { apiError, json, type RouteContext, type RouteHandler } from "../http";

/** 统计只需要这几列；原图 originalImageUrl 是 base64，绝不出现在统计查询里 */
const ITEM_STAT_FIELDS = "id,userId,subjectId,masteryLevel,createdAt";
const ITEM_LIST_FIELDS = "id,userId,subjectId,questionText,ocrText,masteryLevel,createdAt";

type Distribution = { new: number; reviewing: number; mastered: number };

function masteryDistribution(items: any[]): Distribution {
  const out: Distribution = { new: 0, reviewing: 0, mastered: 0 };
  for (const i of items) {
    const level = Number(i?.masteryLevel ?? 0);
    if (level >= 2) out.mastered++;
    else if (level === 1) out.reviewing++;
    else out.new++;
  }
  return out;
}

function last7Days(): { date: string; count: number }[] {
  const days: { date: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date: d, count: 0 });
  }
  return days;
}

function trendOf(items: any[]): { date: string; count: number }[] {
  const days = last7Days();
  const index = new Map(days.map((d) => [d.date, d]));
  for (const i of items) {
    const key = String(i?.createdAt || "").slice(0, 10);
    const hit = index.get(key);
    if (hit) hit.count++;
  }
  return days;
}

/** 用户管理页的 User 行 → 前端 AdminUserStats / user 对象 */
function toUserShape(u: any) {
  return {
    id: u.id,
    name: u.name ?? null,
    email: u.email ?? "",
    username: u.username ?? null,
    role: u.role ?? "user",
    isActive: u.isActive ?? true,
    createdAt: u.createdAt ?? null,
    educationStage: u.educationStage ?? null,
    enrollmentYear: u.enrollmentYear ?? null,
  };
}

async function handleAdmin(ctx: RouteContext): Promise<Response | null> {
  const [root, sub, third] = ctx.parts;
  if (root !== "admin") return null;

  if (sub === "dashboard") {
    await requireAdmin();
    /**
     * 前端 AdminDashboardData 读的是 overview / userStats / dailyTrend /
     * masteryDistribution / subjectDistribution，旧桥接层只回扁平
     * { totalUsers, totalErrors, users }，导致两个管理页整页崩溃。
     * 这里按类型约定返回完整结构，并且所有查询都裁剪字段并行发起。
     */
    const [users, items, practice, subjects] = await Promise.all([
      restJson<any[]>("/User?select=id,email,username,name,role,isActive,createdAt&limit=1000").catch(() => []),
      restJson<any[]>(`/ErrorItem?select=${ITEM_STAT_FIELDS}&limit=5000`).catch(() => []),
      restJson<any[]>("/PracticeRecord?select=id,userId&limit=5000").catch(() => []),
      restJson<any[]>("/Subject?select=id,userId,name&limit=1000").catch(() => []),
    ]);
    const subjectName = new Map((subjects || []).map((s) => [s.id, s.name]));
    const subjectCounts = new Map<string, number>();
    for (const i of items || []) {
      const name = (i.subjectId && subjectName.get(i.subjectId)) || "未分类";
      subjectCounts.set(name, (subjectCounts.get(name) || 0) + 1);
    }
    const userStats = (users || []).map((u) => ({
      ...toUserShape(u),
      errorCount: (items || []).filter((i) => i.userId === u.id).length,
      practiceCount: (practice || []).filter((p) => p.userId === u.id).length,
      notebookCount: (subjects || []).filter((s) => s.userId === u.id).length,
    }));
    return json({
      overview: {
        totalUsers: (users || []).length,
        totalErrorItems: (items || []).length,
        totalPracticeRecords: (practice || []).length,
        totalSubjects: (subjects || []).length,
      },
      userStats,
      subjectDistribution: [...subjectCounts.entries()].map(([name, count]) => ({ name, count })),
      dailyTrend: trendOf(items || []),
      masteryDistribution: masteryDistribution(items || []),
    });
  }

  if (sub === "migrate-tags") return json({ success: true, migrated: 0 });

  if (sub === "system-reset") {
    await requireAdmin();
    if (ctx.body?.confirm !== "RESET") {
      return apiError(400, "Confirmation string 'RESET' is required for system reset");
    }
    const result = await rpc<any>("reset_user_data").catch((e) => ({
      success: false,
      error: e?.message || "重置失败",
    }));
    if (!result?.success) return apiError(400, result?.error || "重置失败");
    return json({ success: true, ...result });
  }

  if (sub === "users") {
    await requireAdmin();
    if (!third) {
      if (ctx.method === "GET") {
        return json(
          await restJson<any[]>(
            "/User?select=id,email,username,name,role,isActive,createdAt",
          ).catch(() => []),
        );
      }
      if (ctx.method === "POST") {
        const { email, password, name, role } = ctx.body || {};
        const result = await rpc<any>("admin_create_user", {
          p_email: email,
          p_password: password,
          p_name: name,
          p_role: role || "user",
        }).catch((e) => ({ success: false, error: e?.message || "创建失败" }));
        if (!result?.success) return apiError(400, result?.error || "创建失败");
        return json({ id: result.id, email: result.email, role: result.role }, 201);
      }
      return null;
    }

    // 用户详情（/api/admin/users/:id 或 /api/admin/users/:id/detail）
    if (ctx.method === "GET") {
      const target = encodeURIComponent(third);
      const [userRows, items, practice, notebooks] = await Promise.all([
        restJson<any[]>(byId("User", third)).catch(() => []),
        // 旧实现 /ErrorItem?select=* 把全库 7.66MB 原图拉回，只为统计一个用户。
        // 改为按目标用户下推 + 裁剪字段，响应从 7.66MB 变成几 KB。
        restJson<any[]>(
          `/ErrorItem?select=${ITEM_LIST_FIELDS}&userId=eq.${target}&order=createdAt.desc&limit=5000`,
        ).catch(() => []),
        restJson<any[]>(
          `/PracticeRecord?select=id&userId=eq.${target}&limit=5000`,
        ).catch(() => []),
        restJson<any[]>(
          `/Subject?select=id,name,userId&userId=eq.${target}&limit=1000`,
        ).catch(() => []),
      ]);
      const subjectName = new Map((notebooks || []).map((s) => [s.id, s.name]));
      const subjectCounts = new Map<string, number>();
      for (const i of items || []) {
        const name = (i.subjectId && subjectName.get(i.subjectId)) || "未分类";
        subjectCounts.set(name, (subjectCounts.get(name) || 0) + 1);
      }
      const weekAgo = Date.now() - 7 * 86_400_000;
      const recentErrorItems = (items || []).slice(0, 10).map((i) => ({
        id: i.id,
        questionText: i.questionText ?? null,
        ocrText: i.ocrText ?? null,
        masteryLevel: Number(i.masteryLevel ?? 0),
        createdAt: i.createdAt,
        subject: i.subjectId ? { name: subjectName.get(i.subjectId) || "未分类" } : null,
      }));
      return json({
        user: toUserShape(userRows?.[0] || {}),
        notebooks: (notebooks || []).map((s) => ({
          id: s.id,
          name: s.name,
          errorCount: (items || []).filter((i) => i.subjectId === s.id).length,
        })),
        errorCount: (items || []).length,
        practiceCount: (practice || []).length,
        notebookCount: (notebooks || []).length,
        recent7DaysCount: (items || []).filter(
          (i) => new Date(i.createdAt).getTime() >= weekAgo,
        ).length,
        masteryDistribution: masteryDistribution(items || []),
        subjectDistribution: [...subjectCounts.entries()].map(([name, count]) => ({ name, count })),
        recentErrorItems,
      });
    }
    if (ctx.method === "PATCH" || ctx.method === "PUT") {
      const rows = await restJson<any[]>(byId("User", third), {
        method: "PATCH",
        body: JSON.stringify(ctx.body || {}),
      });
      return json(rows?.[0] || { id: third, ...(ctx.body || {}) });
    }
    if (ctx.method === "DELETE") {
      const result = await rpc<any>("admin_delete_user", { p_target_user_id: third }).catch((e) => ({
        success: false,
        error: e?.message || "删除失败",
      }));
      if (!result?.success) return apiError(400, result?.error || "删除失败");
      return json({ success: true, deleted: third });
    }
    return null;
  }

  return null;
}

export const ADMIN_HANDLERS: RouteHandler[] = [handleAdmin];
