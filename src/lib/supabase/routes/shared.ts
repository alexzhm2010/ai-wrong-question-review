/** 各业务路由共用的数据装配逻辑（对应旧版 Prisma 的 include / _count） */
import { appUser, cuid, nowIso, restJson } from "../core";

/** 读取公开配置并脱敏（AI 密钥只保存在 Edge Function 侧） */
export async function loadPublicConfig(): Promise<Record<string, any>> {
  const rows = await restJson<any[]>(
    "/AppSetting?key=eq.app_config_public&select=value",
  ).catch(() => []);
  let cfg: Record<string, any> = {};
  try {
    cfg = JSON.parse(rows?.[0]?.value || "{}");
  } catch {
    cfg = {};
  }
  return {
    ...cfg,
    timeouts: { analyze: 180_000, ...(cfg.timeouts || {}) },
    openai: {
      ...(cfg.openai || {}),
      instances: (cfg.openai?.instances || []).map((i: any) => ({ ...i, apiKey: "********" })),
    },
    gemini: cfg.gemini ? { ...cfg.gemini, apiKey: "********" } : cfg.gemini,
    azure: cfg.azure ? { ...cfg.azure, apiKey: "********" } : cfg.azure,
  };
}

/** 写回公开配置；密钥字段不落库 */
export async function savePublicConfig(next: Record<string, any>): Promise<void> {
  const payload = {
    ...next,
    gemini: next.gemini ? { ...next.gemini, apiKey: undefined } : undefined,
    azure: next.azure ? { ...next.azure, apiKey: undefined } : undefined,
    openai: next.openai
      ? {
          ...next.openai,
          instances: (next.openai.instances || []).map((i: any) => ({ ...i, apiKey: undefined })),
        }
      : undefined,
  };
  await restJson("/AppSetting", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      key: "app_config_public",
      value: JSON.stringify(payload),
      updatedAt: nowIso(),
    }),
  }).catch(() => {});
}

/** 错题列表：附带标签与学科（对应 Prisma include: { tags, subject }） */
export async function attachRelations(
  item: Record<string, any>,
  allTags?: any[],
  allSubjects?: { id: string; name: string }[],
): Promise<Record<string, any>> {
  const tags = allTags || (await restJson<any[]>("/KnowledgeTag?select=*").catch(() => []));
  let linked: any[] = [];
  try {
    const links = await restJson<any[]>(
      `/_ErrorItemToKnowledgeTag?select=*&A=eq.${encodeURIComponent(item.id)}`,
    ).catch(() => []);
    linked = links.map((l) => tags.find((t) => t.id === l.B)).filter(Boolean);
  } catch {
    /* 关联表不可读时降级为空标签 */
  }
  // subject 必须带 name：前端按 item.subject?.name 展示所属错题本，
  // 只回 id 会导致明明已归档却显示成「未设置/未分类」。
  let subject: { id: string; name?: string } | null = null;
  if (item.subjectId) {
    const pool = allSubjects
      || (await restJson<any[]>("/Subject?select=id,name").catch(() => []));
    const hit = pool.find((s) => s.id === item.subjectId);
    subject = hit ? { id: hit.id, name: hit.name } : { id: item.subjectId };
  }
  return {
    ...item,
    tags: linked,
    subject,
  };
}

/**
 * 错题本列表：只列当前用户自己的本。
 *
 * 两个必须守住的点：
 * 1. RLS 里 is_admin() 允许管理员读到所有用户的 Subject，所以这里必须显式
 *    按 userId 过滤；否则管理员会把别人名下的「数学 / 英语」一起列出来，
 *    看起来就像凭空多出了几个重复的错题本。
 * 2. 查询失败绝不能被当成「一个本都没有」。旧实现用 .catch(() => [])
 *    吞掉 401 / 网络错误后直接补建「数学 / 英语」，在 token 刷新窗口或
 *    网络抖动时会凭空插入两个空本。
 */
export async function listNotebooks(): Promise<any[]> {
  const user = await appUser();
  if (!user?.id) return [];

  const scope = `userId=eq.${encodeURIComponent(user.id)}`;
  // 查询失败直接冒泡（由上层返回错误），绝不降级成空数组
  let subjects = await restJson<any[]>(`/Subject?select=*&${scope}&order=createdAt.desc`);
  const items = await restJson<any[]>("/ErrorItem?select=id,subjectId");

  // 只有「查询成功且确实 0 条」才补默认本；插入失败（并发撞唯一约束）就跳过，
  // 不把没写进库的行显示出来。
  if (subjects.length === 0) {
    for (const name of ["数学", "英语"]) {
      const row = {
        id: cuid(),
        name,
        userId: user.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      const created = await restJson<any[]>("/Subject", {
        method: "POST",
        body: JSON.stringify(row),
      }).catch(() => null);
      if (created?.[0]) subjects.push(created[0]);
    }
  }

  return subjects.map((s) => ({
    ...s,
    _count: { errorItems: items.filter((i) => i.subjectId === s.id).length },
  }));
}
