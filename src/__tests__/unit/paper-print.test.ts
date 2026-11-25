import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("paper-print：出卷→打印统一入口", () => {
    const lib = read("src/lib/paper-print.ts");

    it("公共函数先出卷拿凭证，再整页导航到打印页", () => {
        expect(lib).toContain('"/api/paper/create"');
        expect(lib).toContain("hardNavigate(printPreviewHref(ids, code, paperNo))");
    });

    it("出卷失败降级为无凭证打印，不阻断", () => {
        expect(lib).toContain("return { code: \"\", paperNo: \"\" }");
    });
});

describe("错题本导出打印：复用今日复习的打印链路", () => {
    const list = read("src/components/error-list.tsx");

    it("导出打印走 createPaperAndPrint，不再直接 router.push 到 src=list", () => {
        expect(list).toContain("createPaperAndPrint(ids, chosen, subjects)");
        expect(list).not.toContain('router.push("/print-preview?src=list")');
        expect(list).not.toContain("useRouter");
    });

    it("用选中题的学科名拼科目，传给出卷接口", () => {
        expect(list).toContain("it.subject?.name || \"\"");
        expect(list).toContain('names.join("、")');
    });

    it("出卷中有加载态，按钮防重复点", () => {
        expect(list).toContain("const [printing, setPrinting] = useState(false)");
        expect(list).toContain("正在出卷…");
        expect(list).toContain("disabled={selectedIds.size === 0 || printing}");
    });
});
