import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 今日复习卷的科目多选回归：
 * 用户勾选的科目必须真正过滤出题列表，且清空时给出提示而不是崩溃。
 */
const m = vi.hoisted(() => ({
    push: vi.fn(),
    apiGet: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@/lib/api-client", () => ({ apiClient: { get: m.apiGet } }));
vi.mock("@/lib/storage", () => ({ imageSrc: (v: string) => v }));
vi.mock("@/components/auto-crop-image", () => ({
    AutoCropImage: (props: { src: string; className?: string }) => <img src={props.src} className={props.className} alt="" />,
}));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => <span>返回</span> }));

import ReviewPage from "@/app/review/page";

function item(id: string, subjectId: string, subjectName: string, kp: string) {
    return {
        id,
        userId: "u1",
        subjectId,
        subject: { id: subjectId, name: subjectName, userId: "u1", createdAt: "", updatedAt: "" },
        questionText: `题目 ${id}`,
        knowledgePoints: JSON.stringify([kp]),
        masteryLevel: 0,
        wrongCount: 1,
        correctCount: 0,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
    };
}

const ITEMS = [
    item("m1", "math", "数学", "函数"),
    item("m2", "math", "数学", "导数"),
    item("m3", "math", "数学", "数列"),
    item("p1", "physics", "物理", "牛顿定律"),
    item("p2", "physics", "物理", "动量"),
];

async function flush() {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
}

function cardIds(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll('a[href^="/item/"]')).map((a) =>
        a.getAttribute("href")!.replace("/item/", ""),
    );
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
    const btn = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
    if (!btn) throw new Error(`button not found: ${text}`);
    return btn as HTMLButtonElement;
}

async function click(root: HTMLElement, text: string) {
    await act(async () => {
        findButton(root, text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

describe("今日复习卷 · 科目多选", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        localStorage.clear();
        m.apiGet.mockImplementation((url: string) => {
            if (url.includes("/images")) return Promise.resolve({ images: [] });
            return Promise.resolve({ items: ITEMS, total: ITEMS.length, page: 1, pageSize: 1000, totalPages: 1 });
        });
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.clearAllMocks();
    });

    it("默认全选：两个学科的题目都在列表里", async () => {
        await act(async () => { root.render(<ReviewPage />); });
        await flush();

        expect(cardIds(container).sort()).toEqual(["m1", "m2", "m3", "p1", "p2"]);
        expect(findButton(container, "数学").getAttribute("aria-pressed")).toBe("true");
        expect(findButton(container, "物理").getAttribute("aria-pressed")).toBe("true");
    });

    it("取消勾选物理后，列表只剩数学题", async () => {
        await act(async () => { root.render(<ReviewPage />); });
        await flush();

        await click(container, "物理");
        await flush();

        expect(cardIds(container).sort()).toEqual(["m1", "m2", "m3"]);
        expect(findButton(container, "物理").getAttribute("aria-pressed")).toBe("false");
        // 选择要记住
        expect(JSON.parse(localStorage.getItem("wq:review-subjects") || "[]")).toEqual(["math"]);
    });

    it("清空后给出选择提示，全选可恢复", async () => {
        await act(async () => { root.render(<ReviewPage />); });
        await flush();

        await click(container, "清空");
        await flush();
        expect(container.textContent).toContain("请先在上方选择要复习的科目");
        expect(cardIds(container)).toHaveLength(0);

        await click(container, "全选");
        await flush();
        expect(cardIds(container)).toHaveLength(5);
        expect(container.textContent).not.toContain("请先在上方选择要复习的科目");
    });
});
