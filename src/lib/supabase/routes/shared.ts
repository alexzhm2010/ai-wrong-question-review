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
  return {
    ...item,
    tags: linked,
    subject: item.subjectId ? { id: item.subjectId } : null,
  };
}

/** 错题本列表：首次使用时自动建「数学 / 英语」两个默认本 */
export async function listNotebooks(): Promise<any[]> {
  const user = await appUser();
  let subjects = await restJson<any[]>("/Subject?select=*&order=createdAt.desc").catch(() => []);
  const items = await restJson<any[]>("/ErrorItem?select=id,subjectId").catch(() => []);

  if (subjects.length === 0 && user) {
    for (const name of ["数学", "英语"]) {
      await restJson("/Subject", {
        method: "POST",
        body: JSON.stringify({
          id: cuid(),
          name,
          userId: user.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }),
      }).catch(() => {});
    }
    subjects = await restJson<any[]>("/Subject?select=*&order=createdAt.desc").catch(() => []);
  }
  return subjects.map((s) => ({
    ...s,
    _count: { errorItems: items.filter((i) => i.subjectId === s.id).length },
  }));
}
