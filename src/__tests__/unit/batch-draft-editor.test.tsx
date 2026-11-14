import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 19 在 jsdom 下需要显式声明这是 act 环境，否则每次 render 都刷警告
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * v1.19.7 回归：批量检查队列曾被「活跃批次」10 秒轮询打回原形。
 *
 * 复现链路：父页面每轮 re-render 都传入新的内联 onClose/onStarted
 * → enterEdit 重新拉取 draft-detail → setItems 新数组 → 加载 effect 重跑
 * → setSrc("") → ImageEditor 卸载重挂载，用户刚做的裁剪/抹除全部丢失。
 * 这里用真实的 React 渲染 + 全新的内联回调反复重渲染，锁住这条链路。
 */

const m = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(() => Promise.resolve({})),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    refresh: vi.fn(),
    startDraft: vi.fn(() => Promise.resolve()),
    ingestImage: vi.fn(() => Promise.resolve({ ref: "ref-x", thumb: "thumb-x" })),
    mounts: [] as string[],
    lastProps: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/api-client", () => ({ apiClient: { get: m.get, post: m.post } }));
vi.mock("@/lib/toast", () => ({
    toast: { error: m.toastError, success: m.toastSuccess },
}));
vi.mock("@/lib/batch-store", () => ({ refreshActiveBatch: m.refresh }));
vi.mock("@/lib/batch-draft", () => ({
    startDraft: m.startDraft,
    uploadDraftImages: vi.fn(() => Promise.resolve({ failed: 0 })),
}));
vi.mock("@/lib/storage", () => ({
    imageSrc: (v: string) => v,
    ingestImage: m.ingestImage,
}));
vi.mock("@/components/image-editor", () => ({
    ImageEditor: (props: Record<string, unknown>) => {
        m.lastProps = props;
        // 函数体每次 render 都会跑，用 mount effect 才能数「重挂载」
        useEffect(() => { m.mounts.push(String(props.imageSrc)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
        return (
            <div data-testid="editor" data-src={String(props.imageSrc)}>
                <span data-testid="progress">{String(props.progressLabel)}</span>
                <span data-testid="done-label">{String(props.doneLabel)}</span>
                <button data-testid="finish" onClick={() => (props.onDone as (u: string, c: boolean) => void)("data:edited", false)} />
            </div>
        );
    },
}));

import { BatchDraftEditor } from "@/components/batch-draft-editor";

const ITEMS = [
    { id: "it1", idx: 0, status: "pending" },
    { id: "it2", idx: 1, status: "pending" },
    { id: "it3", idx: 2, status: "pending" },
];
const IMG = "data:image/png;base64,AAAA";

/** 故意每次 render 都生成新的内联回调，模拟父页面订阅轮询后的 re-render */
function Parent({ n }: { n: number }) {
    return (
        <BatchDraftEditor
            jobId="job1"
            onClose={() => { void n; }}
            onStarted={() => { void n; }}
        />
    );
}

let container: HTMLDivElement;
let root: Root;

async function flush(times = 6) {
    for (let i = 0; i < times; i++) {
        await act(async () => { await Promise.resolve(); });
    }
}

beforeEach(() => {
    m.mounts = [];
    m.lastProps = null;
    vi.clearAllMocks();
    m.get.mockImplementation((url: string) => {
        if (url === "/api/batch/draft-detail") return Promise.resolve({ job: {}, items: ITEMS });
        if (url === "/api/batch/item-image") return Promise.resolve({ imageBase64: IMG });
        return Promise.resolve({});
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe("BatchDraftEditor 抗父组件重渲染", () => {
    it("父组件反复 re-render 不重复拉数据、不重挂载编辑器、imageSrc 不变", async () => {
        await act(async () => { root.render(<Parent n={0} />); });
        await flush();

        const editor = container.querySelector('[data-testid="editor"]');
        expect(editor).not.toBeNull();
        expect(editor?.getAttribute("data-src")).toBe(IMG);
        expect(container.querySelector('[data-testid="progress"]')?.textContent).toBe("1/3");
        expect(m.mounts).toEqual([IMG]);

        const detailBefore = m.get.mock.calls.filter((c) => c[0] === "/api/batch/draft-detail").length;
        const imageBefore = m.get.mock.calls.filter((c) => c[0] === "/api/batch/item-image").length;
        expect(detailBefore).toBe(1);
        expect(imageBefore).toBe(1);

        // 模拟 5 轮全局轮询：每次都是全新的内联回调
        for (let n = 1; n <= 5; n++) {
            await act(async () => { root.render(<Parent n={n} />); });
            await flush(2);
        }

        expect(m.get.mock.calls.filter((c) => c[0] === "/api/batch/draft-detail")).toHaveLength(detailBefore);
        expect(m.get.mock.calls.filter((c) => c[0] === "/api/batch/item-image")).toHaveLength(imageBefore);
        expect(m.mounts).toEqual([IMG]);
        expect(container.querySelector('[data-testid="editor"]')?.getAttribute("data-src")).toBe(IMG);
        // 题号不能被重置回第一张
        expect(container.querySelector('[data-testid="progress"]')?.textContent).toBe("1/3");
    });

    it("点「保存并下一张」才切题，且只为新题拉一次图", async () => {
        await act(async () => { root.render(<Parent n={0} />); });
        await flush();
        expect(container.querySelector('[data-testid="done-label"]')?.textContent).toBe("保存并下一张");

        await act(async () => {
            (container.querySelector('[data-testid="finish"]') as HTMLButtonElement).click();
        });
        await flush();

        expect(container.querySelector('[data-testid="progress"]')?.textContent).toBe("2/3");
        expect(m.get.mock.calls.filter((c) => c[0] === "/api/batch/item-image")).toHaveLength(2);
        expect(m.mounts).toEqual([IMG, IMG]);
    });

    it("最后一张点完成只弹确认，点「开始解析」才真正启动", async () => {
        await act(async () => { root.render(<Parent n={0} />); });
        await flush();
        for (let i = 0; i < 2; i++) {
            await act(async () => {
                (container.querySelector('[data-testid="finish"]') as HTMLButtonElement).click();
            });
            await flush();
        }
        expect(container.querySelector('[data-testid="done-label"]')?.textContent).toBe("完成并解析");
        // 此时已经到最后一张，还没点完成，不应启动解析
        expect(m.startDraft).not.toHaveBeenCalled();

        await act(async () => {
            (container.querySelector('[data-testid="finish"]') as HTMLButtonElement).click();
        });
        await flush();
        expect(m.startDraft).not.toHaveBeenCalled();
        expect(container.textContent).toContain("这批 3 张都看完了");

        await act(async () => {
            const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "开始解析");
            (btn as HTMLButtonElement).click();
        });
        await flush();
        expect(m.startDraft).toHaveBeenCalledWith("job1");
    });
});
