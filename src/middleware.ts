import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";

const logger = createLogger('middleware');

/**
 * 自带认证或必须匿名可达的 API。
 * - /api/auth/*：NextAuth 自身的登录/回调/会话端点，要求登录会形成死循环
 * - /api/register*：注册页需要匿名读取注册开关并提交注册
 * - /api/version：版本探测
 * - /api/openclaw/*：由 API Key 或用户名密码自行认证，没有 session cookie
 */
const PUBLIC_API_PREFIXES = [
    '/api/auth',
    '/api/register',
    '/api/version',
    '/api/openclaw/',
];

function isPublicApi(pathname: string): boolean {
    return PUBLIC_API_PREFIXES.some((prefix) => {
        const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
        return pathname === prefix || pathname.startsWith(withSlash);
    });
}

/**
 * 读取 session token。
 * authOptions（src/lib/auth.ts）显式把会话 cookie 固定为 "next-auth.session-token"，
 * 因此优先按该名字读取；再回退到 NextAuth 默认命名，兼容将来改回标准配置
 * （HTTPS 下带 __Secure- 前缀）的情况。token 本身是签名的，多试一次不降低安全性。
 */
async function readToken(req: NextRequest) {
    const secret = process.env.NEXTAUTH_SECRET;
    const configured = await getToken({ req, secret, cookieName: 'next-auth.session-token' });
    if (configured) return configured;
    return getToken({ req, secret, secureCookie: true });
}

export async function middleware(req: NextRequest) {
    const path = req.nextUrl.pathname;
    const isApi = path.startsWith('/api/');

    // 公开 API 直接放行，且不受下方鉴权异常 fail-closed 的影响
    if (isApi && isPublicApi(path)) {
        return NextResponse.next();
    }

    try {
        const token = await readToken(req);
        const isAuth = !!token;
        const isAuthPage = path.startsWith("/login") || path.startsWith("/register");
        const isAdminArea = path.startsWith("/admin") || path.startsWith("/api/admin/");

        logger.debug({
            path,
            isAuth,
            isAuthPage,
            isAdminArea,
            cookies: req.cookies.getAll().map(c => c.name)
        }, 'Auth status');

        if (isAuthPage) {
            if (isAuth) {
                logger.debug('Redirecting authenticated user to /');
                return NextResponse.redirect(new URL("/", req.url));
            }
            // 显式放行，不依赖框架对 null/undefined 返回值的隐式处理
            return NextResponse.next();
        }

        if (!isAuth) {
            // API 返回 JSON 401 而不是 302 到登录页，避免前端把 HTML 当 JSON 解析
            if (isApi) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            let from = path;
            if (req.nextUrl.search) from += req.nextUrl.search;
            logger.debug({ callbackUrl: from }, 'Redirecting unauthenticated user to login');
            return NextResponse.redirect(
                new URL(`/login?callbackUrl=${encodeURIComponent(from)}`, req.url)
            );
        }

        // 管理后台：页面与 /api/admin/* 统一在这里挡一层
        if (isAdminArea && token?.role !== "admin") {
            logger.warn({ userId: token?.id, path }, 'Non-admin user attempting to access admin area');
            if (isApi) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
            return NextResponse.redirect(new URL("/", req.url));
        }

        return NextResponse.next();
    } catch (e) {
        // M-02：鉴权异常时 fail-closed，不再静默放行
        logger.error({ error: e }, 'Error processing token');
        if (isApi) {
            return NextResponse.json({ error: 'Authentication unavailable' }, { status: 503 });
        }
        return NextResponse.redirect(new URL("/login?error=AuthUnavailable", req.url));
    }
}

export const config = {
    matcher: [
        /*
         * 匹配所有请求路径（含 /api），仅排除静态资源。
         * 原 matcher 把 /api 整体排除，导致 42 个路由必须各自重复鉴权，
         * 漏写一处即暴露（见 P0 审查报告根因）。公开端点由 PUBLIC_API_PREFIXES 放行。
         * 注意：中间件只能统一解决「是否登录」，路由内的 owner 判断仍是必要的。
         */
        "/((?!_next/static|_next/image|favicon.ico).*)",
    ],
};
