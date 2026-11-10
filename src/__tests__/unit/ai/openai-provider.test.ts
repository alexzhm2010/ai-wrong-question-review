/**
 * OpenAI Provider 单元测试
 *
 * 测试 OpenAI 服务初始化、响应解析和错误处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCompletionCreate = vi.hoisted(() => vi.fn());

// Mock OpenAI SDK
vi.mock('openai', () => {
    return {
        default: class MockOpenAI {
            chat = {
                completions: {
                    create: mockCompletionCreate,
                },
            };
        },
    };
});

// Mock logger
vi.mock('@/lib/logger', () => ({
    createLogger: vi.fn(() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        box: vi.fn(),
        divider: vi.fn(),
    })),
}));

// Mock config
vi.mock('@/lib/config', () => ({
    getAppConfig: vi.fn(() => ({
        aiProvider: 'openai',
        openai: {
            apiKey: 'test-key',
            model: 'gpt-4o',
        },
    })),
}));

// Mock tag service
vi.mock('@/lib/ai/tag-service', () => ({
    getMathTagsFromDB: vi.fn(() => Promise.resolve([])),
    getTagsFromDB: vi.fn(() => Promise.resolve([])),
}));

// Delayed import to ensure mocks are applied
import { OpenAIProvider } from '@/lib/ai/openai-provider';
import type { ParsedQuestion } from '@/lib/ai/types';

type PrivateOpenAIProvider = {
    parseResponse(text: string): ParsedQuestion;
    extractTag(text: string, tagName: string): string | null;
    handleError(error: unknown): never;
};

function asPrivateProvider(provider: OpenAIProvider): PrivateOpenAIProvider {
    return provider as unknown as PrivateOpenAIProvider;
}

describe('OpenAI Provider 响应解析', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'gpt-4o',
        });
    });

    describe('parseResponse', () => {
        it('应该正确解析包含所有必需标签的响应', () => {
            const mockResponse = `
<question_text>求函数 f(x) = x^2 的最小值</question_text>
<answer_text>最小值为 0</answer_text>
<analysis>这是一个二次函数,开口向上,顶点在原点,因此最小值为 0</analysis>
<subject>数学</subject>
<knowledge_points>二次函数, 函数最值</knowledge_points>
<requires_image>true</requires_image>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.questionText).toBe('求函数 f(x) = x^2 的最小值');
            expect(result.answerText).toBe('最小值为 0');
            expect(result.analysis).toContain('二次函数');
            expect(result.subject).toBe('数学');
            expect(result.knowledgePoints).toContain('二次函数');
            expect(result.knowledgePoints).toContain('函数最值');
            expect(result.requiresImage).toBe(true);
        });

        it('空白题省略三个判定标签时解析为 not_attempted 且无错因', () => {
            const blankResponse = `
<question_text>已知 g(x) 是定义在 [-2,2] 上的偶函数，求 m 的取值范围</question_text>
<answer_text>$m \\in [-1, \\frac{1}{2})$</answer_text>
<analysis>由偶函数性质得 |1-m| &gt; |m|，结合定义域解得区间</analysis>
<subject>数学</subject>
<knowledge_points>函数奇偶性</knowledge_points>
<requires_image>false</requires_image>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(blankResponse);

            expect(result.answerText).toContain('[-1');
            expect(result.mistakeStatus).toBe('not_attempted');
            expect(result.wrongAnswerText).toBe('');
            expect(result.mistakeAnalysis).toBe('');
        });

        it('应该解析错因分析相关可选标签', () => {
            const mockResponse = `
<question_text>求 2x + 3 = 7</question_text>
<answer_text>x = 2</answer_text>
<analysis>移项后计算。</analysis>
<wrong_answer_text>x = 4</wrong_answer_text>
<mistake_status>wrong_attempt</mistake_status>
<mistake_analysis>移项后没有正确处理常数项。</mistake_analysis>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.wrongAnswerText).toBe('x = 4');
            expect(result.mistakeStatus).toBe('wrong_attempt');
            expect(result.mistakeAnalysis).toContain('常数项');
        });

        it('判定段被整段省略（空白题）时标记为 not_attempted', () => {
            const mockResponse = `
<question_text>测试题目</question_text>
<answer_text>测试答案</answer_text>
<analysis>测试解析</analysis>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.wrongAnswerText).toBe('');
            expect(result.mistakeAnalysis).toBe('');
            // 新提示词要求空白题写完 </analysis> 即结束，不再输出三个判定标签
            expect(result.mistakeStatus).toBe('not_attempted');
        });

        it('未判断状态不应被错误解答文本强推为做错了', () => {
            const mockResponse = `
<question_text>测试题目</question_text>
<answer_text>测试答案</answer_text>
<analysis>测试解析</analysis>
<wrong_answer_text>错误解答</wrong_answer_text>
<mistake_status>unknown</mistake_status>
            `.trim();

            const result = asPrivateProvider(provider).parseResponse(mockResponse);

            expect(result.mistakeStatus).toBe('unknown');
            expect(result.wrongAnswerText).toBe('');
            expect(result.mistakeAnalysis).toBe('');
        });

        it('缺少必需标签时应该抛出错误', () => {
            const mockResponse = `
<question_text>测试题目</question_text>
<answer_text>测试答案</answer_text>
            `.trim();

            expect(() => asPrivateProvider(provider).parseResponse(mockResponse)).toThrow('Missing critical XML tags');
        });
    });
});

describe('OpenAI Provider 重新解题错因同步', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'gpt-4o',
        });
    });

    it('重新解题应该返回新的错因字段，供前端覆盖旧错因', async () => {
        mockCompletionCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: `
<answer_text>x = 2</answer_text>
<analysis>两边同时减 3，再除以 2。</analysis>
<knowledge_points>一元一次方程</knowledge_points>
<wrong_answer_text>x = 4</wrong_answer_text>
<mistake_status>wrong_attempt</mistake_status>
<mistake_analysis>把 7 - 3 算错了。</mistake_analysis>
                    `.trim(),
                },
            }],
        });

        const result = await provider.reanswerQuestion('求解 2x + 3 = 7', 'zh', '数学');

        expect(result.answerText).toBe('x = 2');
        expect(result.knowledgePoints).toEqual(['一元一次方程']);
        expect(result.wrongAnswerText).toBe('x = 4');
        expect(result.mistakeStatus).toBe('wrong_attempt');
        expect(result.mistakeAnalysis).toContain('算错');
    });

    it('重新解题缺少错因标签时应该返回默认值', async () => {
        mockCompletionCreate.mockResolvedValueOnce({
            choices: [{
                message: {
                    content: `
<answer_text>x = 2</answer_text>
<analysis>移项计算。</analysis>
<knowledge_points>一元一次方程</knowledge_points>
                    `.trim(),
                },
            }],
        });

        const result = await provider.reanswerQuestion('求解 2x + 3 = 7', 'zh', '数学');

        expect(result.answerText).toBe('x = 2');
        expect(result.wrongAnswerText).toBe('');
        expect(result.mistakeAnalysis).toBe('');
        // 判定段被整段省略（空白题）→ not_attempted
        expect(result.mistakeStatus).toBe('not_attempted');
    });
});

describe('token 经济性：流式请求参数与提前终止', () => {
    let streamProvider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        streamProvider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'qwen3-vl-plus',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        });
    });

    it('下发思考预算与用量统计，并在结论后自我怀疑时掐断生成', async () => {
        let wasteEmitted = false;
        function* fakeStream(): Generator<any> {
            const emit = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] });
            yield emit('<subject>数学</subject>\n');
            yield emit('<question_text>已知 g(x) 是定义在 [-2,2] 上的偶函数，求 m 的取值范围。</question_text>\n');
            yield emit('<answer_text>m∈[-1,1/2)</answer_text>\n');
            yield emit('<analysis>由平方得 m<1/2。\n');
            yield emit('结合定义域取交集得 m∈[-1,1/2)。\n');
            yield emit('然而，这与直觉矛盾——我们再仔细检查单调性方向！\n');
            wasteEmitted = true;
            yield emit('这里本该是无限重算的废话，不应被消费。</analysis>\n');
            yield { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000 } };
        }

        mockCompletionCreate.mockResolvedValueOnce(fakeStream());
        const result = await streamProvider.analyzeImageStream(
            'aW1hZ2U=', 'image/jpeg', 'zh', 10, '数学', null, () => {}
        );

        const body = mockCompletionCreate.mock.calls[0][0];
        expect(body.stream_options).toEqual({ include_usage: true });
        expect(body.extra_body).toMatchObject({ enable_thinking: true, thinking_budget: 4096 });

        // 后续整段重算没有被生成/消费，正确答案仍完整保留
        expect(wasteEmitted).toBe(false);
        expect(result.analysis).toContain('m∈[-1,1/2)');
        expect(result.analysis).not.toContain('与直觉矛盾');
    });
});

describe('OpenAI Provider 错误处理', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new OpenAIProvider({
            apiKey: 'test-key',
            model: 'gpt-4o',
        });
    });

    describe('handleError', () => {
        it('应该将网络错误转换为 AI_CONNECTION_FAILED', () => {
            const networkError = new Error('fetch failed');
            expect(() => asPrivateProvider(provider).handleError(networkError)).toThrow('AI_CONNECTION_FAILED');
        });

        it('应该将认证错误转换为 AI_AUTH_ERROR', () => {
            const authError = new Error('Unauthorized: Invalid API key');
            expect(() => asPrivateProvider(provider).handleError(authError)).toThrow('AI_AUTH_ERROR');
        });

        it('应该将 JSON 解析错误转换为 AI_RESPONSE_ERROR', () => {
            const parseError = new Error('Invalid JSON format');
            expect(() => asPrivateProvider(provider).handleError(parseError)).toThrow('AI_RESPONSE_ERROR');
        });

        it('未知错误应该转换为 AI_UNKNOWN_ERROR', () => {
            const unknownError = new Error('Something went wrong');
            expect(() => asPrivateProvider(provider).handleError(unknownError)).toThrow('AI_UNKNOWN_ERROR');
        });
    });
});
