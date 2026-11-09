import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import manifest from '@/app/manifest';
import { awaitInstallChoice, getInstallSteps, getOccludedBottom } from '@/lib/pwa-install';

const projectRoot = process.cwd();
const readSource = (relative: string) =>
    fs.readFileSync(path.join(projectRoot, relative), 'utf8');

describe('PWA 可安装配置', () => {
    it('声明 standalone 全屏启动并带完整标识', () => {
        const m = manifest();
        expect(m.display).toBe('standalone');
        expect(m.display_override).toContain('standalone');
        expect(m.id).toBe('/');
        expect(m.scope).toBe('/');
        expect(m.start_url).toBe('/');
    });

    it('提供 192 与 512 两档图标且文件真实存在', () => {
        const icons = manifest().icons || [];
        expect(icons.map(i => i.sizes)).toContain('192x192');
        expect(icons.map(i => i.sizes)).toContain('512x512');
        for (const icon of icons) {
            expect(fs.existsSync(path.join(projectRoot, 'public', icon.src.replace(/^\//, '')))).toBe(true);
        }
    });

    it('service worker 有 fetch handler，页面与 API 全部网络直通', () => {
        const sw = readSource('public/sw.js');
        expect(sw).toContain("addEventListener('fetch'");
        expect(sw).toContain('event.respondWith(fetch(request))');
        expect(sw).toContain('caches.keys()');
    });

    it('middleware 公开放行 manifest、图标与 sw.js', () => {
        const mw = readSource('src/middleware.ts');
        expect(mw).toContain('/manifest.webmanifest');
        expect(mw).toContain('/sw.js');
        expect(mw).toContain("path.startsWith('/icons/')");
    });
});

describe('所属卷等级已从界面移除', () => {
    const uiFiles = [
        'src/components/correction-editor.tsx',
        'src/components/direct-text-editor.tsx',
        'src/components/error-list.tsx',
        'src/app/error-items/[id]/page.tsx',
        'src/app/print-preview/page.tsx',
        'src/app/page.tsx',
        'src/lib/translations.ts',
    ];

    it('所有前端界面文件都不再引用 paperLevel', () => {
        for (const file of uiFiles) {
            expect(readSource(file)).not.toMatch(/paperLevel/);
        }
    });

    it('后端字段与 API 参数保留以兼容存量数据和导入导出', () => {
        expect(readSource('src/app/api/error-items/route.ts')).toMatch(/paperLevel/);
        expect(readSource('src/app/api/import/route.ts')).toMatch(/paperLevel/);
        expect(readSource('prisma/schema.prisma')).toMatch(/paperLevel/);
    });
});

describe('安装弹窗无响应时的降级', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('系统弹窗永不返回 userChoice 时按超时降级为 unknown', async () => {
        vi.useFakeTimers();
        const never = new Promise<{ outcome?: string }>(() => {});
        const pending = awaitInstallChoice(never, 6000);
        await vi.advanceTimersByTimeAsync(6000);
        expect(await pending).toBe('unknown');
    });

    it('正常返回 accepted / dismissed 时原样分类', async () => {
        expect(await awaitInstallChoice(Promise.resolve({ outcome: 'accepted' }))).toBe('accepted');
        expect(await awaitInstallChoice(Promise.resolve({ outcome: 'dismissed' }))).toBe('dismissed');
    });

    it('弹窗拒绝、事件缺失或结果异常时都不会卡住', async () => {
        expect(await awaitInstallChoice(undefined)).toBe('unknown');
        expect(await awaitInstallChoice(Promise.reject(new Error('denied')))).toBe('unknown');
        expect(await awaitInstallChoice(Promise.resolve({ outcome: 'weird' }))).toBe('unknown');
    });

    it('计算被浏览器底部工具栏遮住的高度', () => {
        expect(getOccludedBottom(800, 700, 0)).toBe(100);
        expect(getOccludedBottom(800, 700, 60)).toBe(40);
        expect(getOccludedBottom(800, 800, 0)).toBe(0);
        expect(getOccludedBottom(Number.NaN, 700, 0)).toBe(0);
    });

    it('手动步骤包含桌面快捷方式权限与同名图标排查', () => {
        const zh = getInstallSteps(true, false).join(' ');
        expect(zh).toContain('创建桌面快捷方式');
        expect(zh).toContain('同名图标');
        expect(getInstallSteps(true, true).join(' ')).toContain('Safari');
        expect(getInstallSteps(false, false).join(' ')).toContain('Permissions');
    });

    it('组件不再 await prompt()，并接入超时降级、视口避让与重新打开入口', () => {
        const src = readSource('src/components/pwa-installer.tsx');
        expect(src).toContain('awaitInstallChoice');
        expect(src).not.toMatch(/await\s+\w+\.prompt\(\)/);
        expect(src).toContain('getOccludedBottom');
        expect(src).toContain('PWA_OPEN_EVENT');
        expect(src).toContain('改用手动添加');
    });

    it('设置页提供重新打开安装引导的常驻入口', () => {
        const src = readSource('src/components/settings-dialog.tsx');
        expect(src).toContain('PWA_OPEN_EVENT');
        expect(src).toContain('查看安装引导');
        expect(src).toContain('setOpen(false)');
    });
});
