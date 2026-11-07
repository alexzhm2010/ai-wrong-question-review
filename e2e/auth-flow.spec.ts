import { test, expect } from '@playwright/test';

test.describe('Authentication Flow', () => {

    // 注册默认关闭是安全默认值（避免任何人自助注册后接触需登录接口）。
    // 首个账号由 `prisma db seed` 创建，因此这里验证「注册被拒 + 管理员可登录」。
    test('Registration is disabled by default and the seeded admin can log in', async ({ page, request }) => {
        test.setTimeout(60000);

        // --- Registration is closed, no form is exposed ---
        await page.goto('/register');
        await expect(page.locator('body')).toContainText(/disabled|关闭/i, { timeout: 15000 });
        await expect(page.locator('input[name="name"]')).toHaveCount(0);

        // --- API also rejects registration (fail-closed) ---
        const response = await request.post('/api/register', {
            data: {
                name: 'jason',
                email: 'jason@qq.com',
                password: '123456',
                educationStage: 'junior_high',
                enrollmentYear: 2024,
            },
        });
        expect(response.status()).toBe(403);

        // --- Seeded admin can still sign in ---
        await page.goto('/login');
        await page.locator('input[name="email"]').fill('admin@localhost');
        await page.locator('input[name="password"]').fill('123456');
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/', { timeout: 15000 });

        // --- Admin can reach user management ---
        await page.getByRole('button').filter({ has: page.locator('svg.lucide-settings') }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
        const usersTab = page.getByRole('tab', { name: /User Management|用户管理/ });
        await usersTab.click();
        await expect(usersTab).toBeVisible();

        // --- Logout returns to login ---
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).not.toBeVisible();
        await page.locator('button[title*="Logout"], button[title*="退出"]').click();
        await page.waitForURL('**/login');
    });
});
