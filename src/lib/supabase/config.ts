/**
 * 静态版运行配置（GitHub Pages + Supabase）
 *
 * GitHub Pages 是纯静态托管，没有服务端环境变量。Supabase URL 与 publishable key
 * 必须在构建时内联进前端产物——这两个值本来就是公开的（线上旧产物里也是内联的），
 * 真正的数据安全由 Postgres RLS 策略和 Edge Function 中的服务端密钥保证。
 *
 * 换成自己的 Supabase 项目时，设置 NEXT_PUBLIC_SUPABASE_URL /
 * NEXT_PUBLIC_SUPABASE_ANON_KEY 即可，无需改代码。
 */

const DEFAULT_SUPABASE_URL = "https://sheoajxitvznnjlfyugq.supabase.co";
const DEFAULT_ANON_KEY = "sb_publishable_RryxOXFa2Z9ob6FGaDFMqw_OdaI68vb";

export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;

/** 与 GitHub Pages 仓库名一致；Next.js basePath 也使用这个值 */
export const BASE_PATH =
  process.env.NEXT_PUBLIC_BASE_PATH || "/ai-wrong-question-review";

export const AI_EDGE = `${SUPABASE_URL}/functions/v1/ai-proxy`;
export const UPLOAD_EDGE = `${SUPABASE_URL}/functions/v1/openclaw-upload`;

export const APP_VERSION = "1.18.43";
export const APP_CHANNEL = "github-pages";
