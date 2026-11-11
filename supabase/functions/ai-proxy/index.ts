/**
 * Supabase Edge Function：AI 统一代理（参考实现 / 新环境用）
 *
 * ⚠️ 线上现有 Supabase 项目已部署完整版 ai-proxy（昨天的改造包含它），
 *    重建后的前端直接调用即可，AI 分析、重新解题、练习生成等功能保持不变。
 *    本文件用于把项目迁移到全新 Supabase 项目时重新部署。
 *
 * 密钥只保存在 Supabase Edge Function Secrets 中，前端拿不到：
 *   AI_API_KEY / AI_BASE_URL / AI_MODEL（也兼容 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）
 *
 * 旧版前端 src/lib/stream-analyze.ts 消费 SSE：
 *   data: {"type":"delta","content":"..."}\n\n
 *   data: {"type":"done","result":{...}}\n\n
 * 因此 analyze 用 text/event-stream 返回，最小实现只发一条 done（结果完整，
 * 没有逐段打字动画）；如需流式，可把上游 SSE chunk 逐段转发为 delta。
 */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const API_KEY = Deno.env.get("AI_API_KEY") || Deno.env.get("OPENAI_API_KEY") || "";
const BASE_URL =
  Deno.env.get("AI_BASE_URL") ||
  Deno.env.get("OPENAI_BASE_URL") ||
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL =
  Deno.env.get("AI_MODEL") || Deno.env.get("OPENAI_MODEL") || "qwen3-vl-plus";

const JSON_HEADERS = { ...cors, "Content-Type": "application/json" };
const SSE_HEADERS = { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" };

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function callAI(messages: any[], signal?: AbortSignal): Promise<string> {
  if (!API_KEY) throw new Error("AI_API_KEY 未配置（Supabase Edge Function Secrets）");
  const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 8192 }),
    signal,
  });
  if (!res.ok) throw new Error(`上游 AI 返回 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/** 尽量从模型输出里取出 JSON 对象 */
function extractJson(text: string): any {
  const cleaned = text.replace(/^```(?:json)?/gim, "").replace(/```$/gim, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
    return { analysis: cleaned };
  }
}

function visionMessage(imageBase64?: string, instruction?: string): any[] {
  const content: any[] = [{ type: "text", text: instruction || "" }];
  if (imageBase64) {
    const dataUrl = imageBase64.startsWith("data:")
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;
    content.push({ type: "image_url", image_url: { url: dataUrl } });
  }
  return [{ role: "user", content }];
}

const ANALYZE_PROMPT = `你是错题分析助手。识别题目图片或文字，输出且只输出一个 JSON 对象，字段：
questionText(题干), answerText(正确答案与完整解析), analysis(解题思路), wrongAnswerText(学生错误作答，看不到则空),
mistakeAnalysis(错误原因), mistakeStatus(not_attempted|wrong_attempt|unknown),
knowledgePoints(知识点字符串数组), subject(学科)。用中文回答。`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: JSON_HEADERS });
  }

  let action = "";
  let payload: any = {};
  try {
    ({ action, payload } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: JSON_HEADERS });
  }

  try {
    if (action === "test") {
      const text = await callAI([{ role: "user", content: "回复 OK 两个字母" }]);
      return new Response(JSON.stringify({ ok: true, model: MODEL, reply: text.slice(0, 50) }), { headers: JSON_HEADERS });
    }

    if (action === "analyze") {
      const result = extractJson(
        await callAI(visionMessage(payload?.imageBase64, `${ANALYZE_PROMPT}\n补充要求：${payload?.language === "en" ? "Answer in English" : "用中文"}`), req.signal),
      );
      const body = sse({ type: "delta", content: "" }) + sse({ type: "done", result }) + sse({ type: "[DONE]" });
      return new Response(body, { headers: SSE_HEADERS });
    }

    if (action === "reanswer") {
      const result = extractJson(
        await callAI([
          { role: "system", content: ANALYZE_PROMPT },
          { role: "user", content: `请重新解答并核对下面的错题：\n${payload?.questionText || ""}\n学生上次作答：${payload?.wrongAnswerText || ""}` },
        ], req.signal),
      );
      return new Response(JSON.stringify({ success: true, ...result }), { headers: JSON_HEADERS });
    }

    if (action === "geogebra_analyze" || action === "geogebra-analyze") {
      const text = await callAI([
        { role: "system", content: "只输出 GeoGebra 命令列表（每行一条），不适用则输出空字符串。" },
        { role: "user", content: `题目：${payload?.questionText || payload?.previousErrors || ""}` },
      ], req.signal);
      const commands = text.trim();
      return new Response(JSON.stringify({ commands, suitable: commands.length > 0 }), { headers: JSON_HEADERS });
    }

    if (action === "practice_generate") {
      const result = extractJson(
        await callAI([
          { role: "system", content: "根据错题生成同类练习题，输出 JSON：{questions:[{questionText,answerText,analysis,difficulty}]}。" },
          { role: "user", content: JSON.stringify(payload || {}) },
        ], req.signal),
      );
      return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers: JSON_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const body = sse({ type: "error", message });
    return new Response(action === "analyze" ? body : JSON.stringify({ error: message }), {
      status: 200,
      headers: action === "analyze" ? SSE_HEADERS : JSON_HEADERS,
    });
  }
});
