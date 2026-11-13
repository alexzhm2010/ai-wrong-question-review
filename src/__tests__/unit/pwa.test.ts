import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import manifest from '@/app/manifest';
import { BASE_PATH } from '@/lib/supabase/config';
import { awaitInstallChoice, getInstallSteps, getOccludedBottom } from '@/lib/pwa-install';

const projectRoot = process.cwd();
const readSource = (relative: string) =>
    fs.readFileSync(path.join(projectRoot, relative), 'utf8');

describe('PWA 可安装配置', () => {
    it('声明 standalone 全屏启动并带完整标识', () => {
        const m = manifest();
        expect(m.display).toBe('standalone');
        expect(m.display_override).toContain('standalone');
        // 部署在 GitHub Pages 子路径下，id / scope / start_url 必须带 basePath，
        // 否则从桌面图标启动会跳到根路径 404。
        expect(m.id).toBe(`${BASE_PATH}/`);
        expect(m.scope).toBe(`${BASE_PATH}/`);
        expect(m.start_url).toBe(`${BASE_PATH}/`);
    });

    it('提供 192 与 512 两档图标且文件真实存在', () => {
        const icons = manifest().icons || [];
        expect(icons.map(i => i.sizes)).toContain('192x192');
        expect(icons.map(i => i.sizes)).toContain('512x512');
        for (const icon of icons) {
            // icon.src 带 basePath，校验磁盘路径时先剥掉
            const relative = icon.src!.replace(BASE_PATH, '').replace(/^\/+/, '');
            expect(fs.existsSync(path.join(projectRoot, 'public', relative))).toBe(true);
        }
    });

    it('service worker 只接管图标，其余请求不代理', () => {
        const sw = readSource('public/sw.js');
        expect(sw).toContain("addEventListener('fetch'");
        expect(sw).toContain('ICON_PREFIX');
        expect(sw).toContain('caches.keys()');
        // 整体代理（respondWith(fetch(request))）会吞掉 AbortSignal：
        // Next 的分片预取靠 abort 取消旧请求，经 SW 转一手后中断传不进去，
        // v1.18.47 线上表现为「偶发卡加载中」。锁住这个回归。
        expect(sw).not.toContain('event.respondWith(fetch(request))');
    });

    it('静态站点无 middleware 拦截：manifest 与 sw.js 作为普通静态文件直出', () => {
        // 静态导出后不再有 src/middleware.ts，PWA 资源由 GitHub Pages 直接返回。
        // 锁住真正的要求：sw.js 在 public 下、manifest 由 app/manifest.ts 静态生成。
        expect(fs.existsSync(path.join(projectRoot, 'public/sw.js'))).toBe(true);
        expect(fs.existsSync(path.join(projectRoot, 'src/app/manifest.ts'))).toBe(true);
        expect(manifest().start_url).toBe(`${BASE_PATH}/`);
    });
});

describe('所属卷等级已从界面移除', () => {
    const uiFiles = [
        'src/components/correction-editor.tsx',
        'src/components/direct-text-editor.tsx',
        'src/components/error-list.tsx',
        'src/app/item/page.tsx',
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
        // 静态迁移后接口实现在桥接层路由里，不再是 src/app/api/**/route.ts
        expect(readSource('src/lib/supabase/routes/error-items.ts')).toMatch(/paperLevel/);
        expect(readSource('src/lib/supabase/routes/practice.ts')).toMatch(/paperLevel/);
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
