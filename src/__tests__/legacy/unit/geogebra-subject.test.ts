import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { shouldShowGeogebra, isNonGeogebraSubject } from '@/lib/geogebra-subject';

const projectRoot = process.cwd();
const readSource = (relative: string) =>
    fs.readFileSync(path.join(projectRoot, relative), 'utf8');

describe('GeoGebra 学科门禁', () => {
    it('数学 / 物理展示入口', () => {
        expect(shouldShowGeogebra('高中数学')).toBe(true);
        expect(shouldShowGeogebra('物理')).toBe(true);
        expect(shouldShowGeogebra('Mathematics')).toBe(true);
        expect(shouldShowGeogebra('Physics')).toBe(true);
    });

    it('语文 / 英语 / 化学等非理科隐藏入口', () => {
        for (const name of ['语文', '英语', '化学', '生物', '历史', '地理', '政治']) {
            expect(shouldShowGeogebra(name), name).toBe(false);
        }
    });

    it('学科未知时仍展示折叠入口，避免误隐藏几何题', () => {
        expect(shouldShowGeogebra(null, null)).toBe(true);
        expect(shouldShowGeogebra('', '')).toBe(true);
        expect(shouldShowGeogebra('我的错题本')).toBe(true);
    });

    it('错题本名优先于 AI 学科名（文字录入会把 subject 硬编码成数学）', () => {
        expect(shouldShowGeogebra('高中语文', '数学')).toBe(false);
        expect(shouldShowGeogebra('物理错题', '语文')).toBe(true);
        expect(shouldShowGeogebra('我的错题本', '物理')).toBe(true);
        expect(shouldShowGeogebra('我的错题本', '英语')).toBe(false);
    });

    it('后端只在明确非理科时短路，学科未知时放行 AI 判断', () => {
        expect(isNonGeogebraSubject('语文')).toBe(true);
        expect(isNonGeogebraSubject('Chemistry')).toBe(true);
        expect(isNonGeogebraSubject('数学')).toBe(false);
        expect(isNonGeogebraSubject('物理')).toBe(false);
        expect(isNonGeogebraSubject(null)).toBe(false);
        expect(isNonGeogebraSubject('')).toBe(false);
        expect(isNonGeogebraSubject('未分类')).toBe(false);
    });
});

describe('GeoGebra 入口收敛为默认折叠的一行', () => {
    const entry = readSource('src/components/geogebra-entry.tsx');
    const editor = readSource('src/components/correction-editor.tsx');
    const detail = readSource('src/app/error-items/[id]/page.tsx');
    const apiGeneral = readSource('src/app/api/geogebra-analyze/route.ts');
    const apiDetail = readSource('src/app/api/error-items/[id]/geogebra/route.ts');

    it('两个页面都不再有原先的大块虚线卡片', () => {
        expect(editor).not.toContain('border-dashed p-4');
        expect(detail).not.toContain('border-dashed p-4');
        expect(editor).toContain('<GeogebraEntry');
        expect(detail).toContain('<GeogebraEntry');
    });

    it('折叠入口默认收起，展开后才显示生成按钮', () => {
        expect(entry).toContain('useState(false)');
        expect(entry).toContain('aria-expanded={expanded}');
        expect(entry).toContain('{expanded && (');
        expect(entry).toContain('GeoGebra 动态演示（可选）');
    });

    it('两个页面都按学科门禁决定是否渲染入口，已生成的演示仍照常展示', () => {
        expect(editor).toContain('shouldShowGeogebra(geogebraSubjectName, data.subject)');
        expect(editor).toContain('showGeogebraEntry && data.questionText.trim()');
        expect(detail).toContain('shouldShowGeogebra(item?.subject?.name ?? null)');
        expect(detail).toContain(') : showGeogebraEntry ?');
        expect(editor).toContain('<GeogebraDemo');
        expect(detail).toContain('<GeogebraDemo');
    });

    it('校对页提交学科名，后端在调 AI 之前短路非理科', () => {
        expect(editor).toContain('subjectName: geogebraSubjectName || data.subject || ""');
        expect(apiGeneral).toContain('isNonGeogebraSubject(subjectName)');
        expect(apiGeneral.indexOf('isNonGeogebraSubject(subjectName)'))
            .toBeLessThan(apiGeneral.indexOf('getAIService()'));
    });

    it('详情页接口改用同一套门禁，不再有内联的字符串匹配', () => {
        expect(apiDetail).toContain('isNonGeogebraSubject(subjectName)');
        expect(apiDetail).not.toContain('const isMathRelated');
    });
});
