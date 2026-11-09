import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import manifest from '@/app/manifest';

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
