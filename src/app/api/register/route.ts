import { NextResponse } from "next/server"
import { hash } from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { getAppConfig } from "@/lib/config"

const userSchema = z.object({
    // 支持标准邮箱和本地邮箱（如 user@localhost）
    email: z.string().regex(/^[^\s@]+@[^\s@]+$/, "Invalid email format"),
    password: z.string().min(6),
    name: z.string().min(1),
    educationStage: z.string().optional(),
    enrollmentYear: z.number().optional(),
})

// H-04：基础的进程内注册限流（按来源 IP，每小时 5 次）。
// 注意：serverless 多实例部署下各实例独立计数，只能挡住脚本批量注册；
// 公网环境请在网关层（Nginx limit_req / WAF）再叠加一层。
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_PER_WINDOW = 5;
const registerAttempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(key: string): boolean {
    const now = Date.now();
    const entry = registerAttempts.get(key);

    if (!entry || now > entry.resetAt) {
        registerAttempts.set(key, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
        if (registerAttempts.size > 5000) {
            for (const [k, v] of registerAttempts) {
                if (now > v.resetAt) registerAttempts.delete(k);
            }
        }
        return false;
    }

    entry.count += 1;
    return entry.count > REGISTER_MAX_PER_WINDOW;
}

/** 仅供单元测试在用例之间重置限流状态 */
export function resetRegisterRateLimit(): void {
    registerAttempts.clear();
}

function clientKey(req: Request): string {
    const forwarded = req.headers.get('x-forwarded-for');
    return forwarded?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
}

export async function POST(req: Request) {
    try {
        if (isRateLimited(clientKey(req))) {
            return NextResponse.json(
                { user: null, message: "Too many registration attempts, please try again later" },
                { status: 429 }
            );
        }

        // 检查是否允许注册
        const config = await getAppConfig();
        if (config.allowRegistration === false) {
            return NextResponse.json(
                { user: null, message: "Registration is currently disabled" },
                { status: 403 }
            );
        }

        const body = await req.json()
        const { email: rawEmail, password, name, educationStage, enrollmentYear } = userSchema.parse(body)
        // PostgreSQL 的 email 唯一索引区分大小写，统一转小写避免重复账号
        const email = rawEmail.trim().toLowerCase()

        const existingUser = await prisma.user.findUnique({
            where: { email }
        })

        if (existingUser) {
            return NextResponse.json(
                { user: null, message: "User with this email already exists" },
                { status: 409 }
            )
        }

        const hashedPassword = await hash(password, 10)
        const newUser = await prisma.user.create({
            data: {
                email,
                name,
                password: hashedPassword,
                educationStage,
                enrollmentYear
            }
        })

        const { password: newUserPassword, ...rest } = newUser

        return NextResponse.json(
            { user: rest, message: "User created successfully" },
            { status: 201 }
        )
    } catch (error) {
        return NextResponse.json(
            { user: null, message: "Something went wrong" },
            { status: 500 }
        )
    }
}
