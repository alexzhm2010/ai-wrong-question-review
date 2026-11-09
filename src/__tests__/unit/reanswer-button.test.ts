import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { translations } from '@/lib/translations';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const readSource = (relative: string) =>
    fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('重新解题按钮只保留一个循环图标', () => {
    it('中英文按钮文案都不再内嵌 emoji 图标', () => {
        expect(translations.zh.editor.reanswer).not.toMatch(EMOJI);
        expect(translations.en.editor.reanswer).not.toMatch(EMOJI);
    });

    it('组件仍使用 lucide RefreshCw，加载态用 Loader2 平滑替换', () => {
        const source = readSource('src/components/correction-editor.tsx');
        expect(source).toContain('<RefreshCw className="mr-2 h-4 w-4" />');
        expect(source).toContain('<Loader2 className="mr-2 h-4 w-4 animate-spin" />');
    });
});
