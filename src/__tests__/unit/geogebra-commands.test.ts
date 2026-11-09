import { describe, it, expect, vi } from 'vitest';
import {
    normalizeCommand,
    parseCommands,
    isApiCall,
    toApiMethodName,
    parseApiArgs,
    runCommands,
    buildErrorFeedback,
} from '../../lib/geogebra-commands';
import { DEFAULT_GEOGEBRA_PROMPT, generateGeogebraPrompt } from '../../lib/ai/prompts';

describe('normalizeCommand', () => {
    it('去掉 AI 常带的行尾逗号与分号', () => {
        expect(normalizeCommand('SetCaption("a", "参数 a"),')).toBe('SetCaption("a", "参数 a")');
        expect(normalizeCommand('f(x) = x^2;  ')).toBe('f(x) = x^2');
        expect(normalizeCommand('  A = (1, 2) ,,')).toBe('A = (1, 2)');
    });

    it('保留命令内部的逗号', () => {
        expect(normalizeCommand('Point(k, 2)')).toBe('Point(k, 2)');
        expect(normalizeCommand('setCoordSystem(-1, 5, -2, 3)')).toBe('setCoordSystem(-1, 5, -2, 3)');
    });
});

describe('parseCommands', () => {
    it('支持 JSON 数组字符串并清理数组元素里的尾逗号', () => {
        expect(parseCommands('["f(x) = x^2", "A = (1, 2)"]'))
            .toEqual(['f(x) = x^2', 'A = (1, 2)']);
        expect(parseCommands('["SetCaption(\\"a\\", \\"参数 a\\"),"]'))
            .toEqual(['SetCaption("a", "参数 a")']);
    });

    it('支持换行分隔并过滤注释', () => {
        expect(parseCommands('// comment\nf(x) = x^2\n\nSetColor("f", 0, 0, 255),\n'))
            .toEqual(['f(x) = x^2', 'SetColor("f", 0, 0, 255)']);
    });

    it('空值返回空数组', () => {
        expect(parseCommands('')).toEqual([]);
        expect(parseCommands('   ')).toEqual([]);
    });
});

describe('API 方法名归一化', () => {
    it('大写开头的 SetColor 映射到真实的 setColor', () => {
        expect(toApiMethodName('SetColor')).toBe('setColor');
        expect(toApiMethodName('SetLineThickness')).toBe('setLineThickness');
        expect(toApiMethodName('setColor')).toBe('setColor');
        expect(toApiMethodName('unknownMethod')).toBe('unknownMethod');
    });

    it('识别 API 调用', () => {
        expect(isApiCall('SetColor("f", 0, 0, 255)')).toBe(true);
        expect(isApiCall('setAxesVisible(true, true)')).toBe(true);
        expect(isApiCall('f(x) = x^2')).toBe(false);
        expect(isApiCall('Text("说明", (1, 2))')).toBe(false);
    });

    it('解析多类型参数', () => {
        expect(parseApiArgs('setColor("f", 0, 128, 255)'))
            .toEqual({ m: 'setColor', a: ['f', 0, 128, 255] });
        expect(parseApiArgs('setGridVisible(true)'))
            .toEqual({ m: 'setGridVisible', a: [true] });
    });
});

describe('runCommands', () => {
    it('执行前关闭 GeoGebra 原生错误弹窗（不再弹出「描点」错误框）', () => {
        const api = {
            setErrorDialogsActive: vi.fn(),
            evalCommand: vi.fn(() => true),
        };
        runCommands(api, ['f(x) = x^2']);
        expect(api.setErrorDialogsActive).toHaveBeenCalledWith(false);
    });

    it('把 evalCommand 返回 false 的命令收进 failed，不中断后续命令', () => {
        const api = {
            setErrorDialogsActive: vi.fn(),
            evalCommand: vi.fn((c: string) => c !== 'Point(1, 2, 3)'),
        };
        const r = runCommands(api, ['f(x) = x^2', 'Point(1, 2, 3)', 'A = (1, 2)']);
        expect(r.executed).toEqual(['f(x) = x^2', 'A = (1, 2)']);
        expect(r.failed).toEqual(['Point(1, 2, 3)']);
        expect(api.evalCommand).toHaveBeenCalledTimes(3);
    });

    it('Text("...") 含引号的命令照常执行，不再被误杀', () => {
        const api = { setErrorDialogsActive: vi.fn(), evalCommand: vi.fn(() => true) };
        const r = runCommands(api, ['Text("M = (1, 3]", (0.5, 2.5), true)']);
        expect(r.executed).toHaveLength(1);
        expect(r.failed).toEqual([]);
        expect(api.evalCommand).toHaveBeenCalledWith('Text("M = (1, 3]", (0.5, 2.5), true)');
    });

    it('大写开头的 SetColor 会调用真实的 setColor 方法', () => {
        const api = {
            setErrorDialogsActive: vi.fn(),
            evalCommand: vi.fn(() => true),
            setColor: vi.fn(),
        };
        const r = runCommands(api, ['SetColor("f", 0, 0, 255)']);
        expect(api.setColor).toHaveBeenCalledWith('f', 0, 0, 255);
        expect(r.failed).toEqual([]);
        expect(api.evalCommand).not.toHaveBeenCalled();
    });

    it('API 方法不存在或抛异常时记为 failed', () => {
        const api = {
            setErrorDialogsActive: vi.fn(),
            evalCommand: vi.fn((c: string) => { if (c === 'boom') throw new Error('x'); return true; }),
        };
        const r = runCommands(api, ['SetColor("f", 1, 2, 3)', 'boom', 'A = (1, 2)']);
        expect(r.failed).toEqual(['SetColor("f", 1, 2, 3)', 'boom']);
        expect(r.executed).toEqual(['A = (1, 2)']);
    });
});

describe('buildErrorFeedback', () => {
    it('把失败命令整理成可回传给 AI 的纠错文本', () => {
        const text = buildErrorFeedback(['Point(1, 2, 3)', 'a = Slider(0, 1, 0.01)']);
        expect(text).toContain('Point(1, 2, 3)');
        expect(text).toContain('a = Slider(0, 1, 0.01)');
        expect(text).toContain('描点');
        expect(text).toContain('完整且可直接执行的命令列表');
    });

    it('没有失败命令时返回空串', () => {
        expect(buildErrorFeedback([])).toBe('');
    });
});

describe('GeoGebra 提示词护栏', () => {
    it('不再把不存在的 Slider() 当成合法示例', () => {
        expect(DEFAULT_GEOGEBRA_PROMPT).not.toContain('a = Slider(-5, 5, 0.1)');
        expect(DEFAULT_GEOGEBRA_PROMPT).toContain('没有 Slider() 命令');
        expect(DEFAULT_GEOGEBRA_PROMPT).toContain('a = 1');
    });

    it('明确禁止三参数 Point 与中文命令名，并要求 API 小写开头', () => {
        expect(DEFAULT_GEOGEBRA_PROMPT).toContain('Point 只接受 1 或 2 个参数');
        expect(DEFAULT_GEOGEBRA_PROMPT).toContain('命令里禁止写');
        expect(DEFAULT_GEOGEBRA_PROMPT).toContain('方法名必须小写开头');
        expect(DEFAULT_GEOGEBRA_PROMPT).toContain('不要写 ParallelLine');
    });

    it('previousErrors 会被注入纠错指令', () => {
        const p = generateGeogebraPrompt('题干', '答案', '解析', '1. Point(1, 2, 3)');
        expect(p).toContain('【上次执行错误 (PREVIOUS ERRORS)】');
        expect(p).toContain('Point(1, 2, 3)');
        expect(p).toContain('输出修正后的完整命令列表');
        expect(p).not.toContain('{{error_feedback}}');
    });

    it('不传 previousErrors 时模板占位符被清空', () => {
        const p = generateGeogebraPrompt('题干', '答案', '解析');
        expect(p).not.toContain('{{error_feedback}}');
        expect(p).toContain('题干');
    });
});
