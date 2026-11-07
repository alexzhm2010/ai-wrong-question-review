const { PrismaClient } = require('@prisma/client');
const { hash } = require('bcryptjs');
const crypto = require('crypto');

// 本地开发默认账号。生产环境请用 ADMIN_EMAIL / ADMIN_PASSWORD 覆盖；
// 若生产未设置 ADMIN_PASSWORD，会生成一次性随机密码并打印到启动日志，
// 避免把仓库里公开的默认密码直接带到公网。
const DEFAULT_ADMIN = {
    email: 'admin@localhost',
    password: '123456',
    name: 'Admin',
    role: 'admin',
    isActive: true,
    educationStage: 'junior_high',
    enrollmentYear: 2025,
};

/**
 * 解析首次管理员凭据：
 * - 显式设置 ADMIN_PASSWORD：直接使用（生产环境推荐，务必是强密码）
 * - 生产环境未设置：自动生成随机强密码，避免默认弱密码暴露在公网
 * - 本地开发未设置：保留 123456，维持原有开发体验
 */
function resolveAdminCredentials(env = process.env) {
    const email = env.ADMIN_EMAIL || DEFAULT_ADMIN.email;
    if (env.ADMIN_PASSWORD) {
        return { email, password: env.ADMIN_PASSWORD, generated: false };
    }
    if (env.NODE_ENV === 'production') {
        return {
            email,
            password: crypto.randomBytes(18).toString('base64url'),
            generated: true,
        };
    }
    return { email, password: DEFAULT_ADMIN.password, generated: false };
}

// admin 可注入，便于测试；默认仍是 DEFAULT_ADMIN，保持既有调用兼容。
async function seedAdmin({ prisma, hash: hashPassword, admin = DEFAULT_ADMIN }) {
    const existingUser = await prisma.user.findUnique({
        where: { email: admin.email },
    });

    if (existingUser) {
        await prisma.user.update({
            where: { email: admin.email },
            data: {
                role: admin.role,
                isActive: admin.isActive,
                educationStage: existingUser.educationStage ?? admin.educationStage,
                enrollmentYear: existingUser.enrollmentYear ?? admin.enrollmentYear,
            },
        });
        return { action: 'updated', email: admin.email };
    }

    const hashedPassword = await hashPassword(admin.password, 12);

    await prisma.user.create({
        data: {
            email: admin.email,
            password: hashedPassword,
            name: admin.name,
            role: admin.role,
            isActive: admin.isActive,
            educationStage: admin.educationStage,
            enrollmentYear: admin.enrollmentYear,
        },
    });

    return { action: 'created', email: admin.email };
}

async function main() {
    const prisma = new PrismaClient();
    const credentials = resolveAdminCredentials();
    const admin = { ...DEFAULT_ADMIN, ...credentials };

    try {
        const result = await seedAdmin({ prisma, hash, admin });
        if (result.action === 'created') {
            console.log('Success! Admin user created.');
            console.log(`Email: ${result.email}`);
            if (credentials.generated) {
                console.log(`Generated ADMIN_PASSWORD (shown once, save it now): ${credentials.password}`);
                console.log('Set ADMIN_PASSWORD explicitly to choose your own password.');
            } else if (credentials.password === DEFAULT_ADMIN.password) {
                console.log(`Password: ${DEFAULT_ADMIN.password} (development default - CHANGE IT before exposing to the internet)`);
            } else {
                console.log('Password: taken from ADMIN_PASSWORD environment variable.');
            }
        } else {
            console.log('Admin user already exists. Updated defaults.');
        }
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { seedAdmin, resolveAdminCredentials, DEFAULT_ADMIN };
