/**
 * Supabase Edge Function：OpenClaw 批量导入（参考实现 / 新环境用）
 *
 * 线上现有项目已部署同名函数。这里给出等价骨架：接收前端传来的批量 payload，
 * 用 service_role 写入 ErrorItem。service_role key 只存在于 Edge Function Secrets，
 * 绝不能放到前端的 NEXT_PUBLIC_* 变量里。
 */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { ...cors, "Content-Type": "application/json" };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: JSON_HEADERS });
  }

  const items: any[] = payload?.errorItems || payload?.items || [];
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return new Response(JSON.stringify({ error: "SUPABASE_SERVICE_ROLE_KEY 未配置" }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }

  let imported = 0;
  for (const item of items) {
    const row = {
      id: payload?.id || ("c" + crypto.randomUUID().replace(/-/g, "")),
      userId: item.userId,
      subjectId: item.subjectId || null,
      originalImageUrl: item.originalImageUrl || "",
      questionText: item.questionText ?? null,
      answerText: item.answerText ?? null,
      analysis: item.analysis ?? null,
      masteryLevel: item.masteryLevel ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ErrorItem`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (res.ok) imported++;
  }

  return new Response(JSON.stringify({ success: true, imported, total: items.length }), {
    headers: JSON_HEADERS,
  });
});
