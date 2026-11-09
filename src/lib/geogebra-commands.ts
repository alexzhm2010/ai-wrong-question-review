/**
 * GeoGebra 命令执行层（纯逻辑，不依赖 React / 浏览器，便于单测）。
 *
 * 背景：AI 生成的命令里经常混入 GeoGebra 不认识的语法。旧实现直接把命令
 * 丢给 api.evalCommand() 且不检查返回值，GeoGebra 会弹出自己的原生错误
 * 对话框挡住整个页面（中文版把 Point 显示为「描点」）。
 *
 * 这里统一做四件事：
 * 1. 规范化命令（去掉 AI 常带的行尾逗号 / 分号）
 * 2. 执行前关闭 GeoGebra 的原生错误对话框
 * 3. 逐条检查执行结果，收集失败命令而不是让弹窗吓到用户
 * 4. 把失败命令整理成可回传给 AI 的纠错反馈
 */

export interface CommandRunResult {
    executed: string[];
    failed: string[];
}

/** GeoGebra Applet API 的真实方法名（camelCase，首字母小写） */
const API_METHODS = [
    "setCoordSystem", "setAxesVisible", "setGridVisible", "setColor",
    "setLineThickness", "setLineStyle", "setPointSize", "setPointStyle",
    "setLabelVisible", "setCaption", "setVisible", "setFilling",
    "setValue", "setFixed", "setBackgroundColor",
];

const API_PREFIXES = API_METHODS.map((m) => m.toLowerCase());

/** 去掉行尾多余逗号/分号；AI 常把 JSON 数组里的逗号带进命令字符串。 */
export function normalizeCommand(raw: string): string {
    let s = (raw || "").trim();
    while (/[,;]\s*$/.test(s)) {
        s = s.replace(/[,;]\s*$/, "").trim();
    }
    return s;
}

/** 支持 JSON 数组字符串或换行分隔的命令列表。 */
export function parseCommands(raw: string): string[] {
    if (!raw?.trim()) return [];
    const t = raw.trim();
    if (t.startsWith("[")) {
        try {
            const a = JSON.parse(t);
            if (Array.isArray(a)) {
                return a
                    .filter((c): c is string => typeof c === "string" && c.trim() !== "")
                    .map(normalizeCommand)
                    .filter((c) => c && !c.startsWith("//"));
            }
        } catch { /* fall through to newline-separated */ }
    }
    return t
        .split("\n")
        .map(normalizeCommand)
        .filter((c) => c && !c.startsWith("//"));
}

export function isApiCall(cmd: string): boolean {
    const l = cmd.toLowerCase().trim();
    return API_PREFIXES.some((p) => l.startsWith(p + "("));
}

/** `SetColor` → `setColor`；已是小写开头则原样返回。 */
export function toApiMethodName(name: string): string {
    const lower = (name || "").toLowerCase();
    return API_METHODS.find((m) => m.toLowerCase() === lower) || name;
}

export function parseApiArgs(cmd: string): { m: string; a: unknown[] } | null {
    const m = cmd.match(/^(\w+)\(([\s\S]+)\)$/);
    if (!m) return null;
    try {
        const argsStr = m[2].trim();
        if (argsStr.startsWith("[") && argsStr.endsWith("]")) {
            return { m: m[1], a: JSON.parse(argsStr) };
        }
        if (/^-?\d+(\.\d+)?$/.test(argsStr)) {
            return { m: m[1], a: [Number(argsStr)] };
        }
        if (argsStr === "true" || argsStr === "false") {
            return { m: m[1], a: [argsStr === "true"] };
        }
        if ((argsStr.startsWith('"') && argsStr.endsWith('"')) ||
            (argsStr.startsWith("'") && argsStr.endsWith("'"))) {
            return { m: m[1], a: [argsStr.slice(1, -1)] };
        }
        const parts = argsStr.split(",").map((s) => s.trim());
        const parsed: unknown[] = parts.map((p) => {
            if (/^-?\d+(\.\d+)?$/.test(p)) return Number(p);
            if (p === "true" || p === "false") return p === "true";
            if ((p.startsWith('"') && p.endsWith('"')) ||
                (p.startsWith("'") && p.endsWith("'"))) return p.slice(1, -1);
            return p; // object names, etc.
        });
        return { m: m[1], a: parsed };
    } catch {
        return null;
    }
}

/**
 * 逐条执行命令并返回成败清单。
 * 不再对引号做拦截：GeoGebra 的 Text("...") 本就需要引号，且 evalCommand
 * 不会把命令注入 DOM，旧实现的 `[<>'"]` 过滤反而误杀了所有文字标注。
 */
export function runCommands(api: any, cmds: string[]): CommandRunResult {
    const executed: string[] = [];
    const failed: string[] = [];

    // 关闭 GeoGebra 自带的错误对话框，非法命令只返回 false，不再弹窗遮挡页面
    try {
        if (typeof api?.setErrorDialogsActive === "function") {
            api.setErrorDialogsActive(false);
        }
    } catch { /* best effort */ }

    for (const cmd of cmds) {
        try {
            if (isApiCall(cmd)) {
                const p = parseApiArgs(cmd);
                const method = p ? toApiMethodName(p.m) : "";
                if (p && typeof api?.[method] === "function") {
                    api[method](...p.a);
                    executed.push(cmd);
                } else {
                    failed.push(cmd);
                }
            } else {
                if (typeof api?.evalCommand !== "function") {
                    failed.push(cmd);
                    continue;
                }
                const ok = api.evalCommand(cmd);
                if (ok === false) failed.push(cmd);
                else executed.push(cmd);
            }
        } catch {
            failed.push(cmd);
        }
    }

    return { executed, failed };
}

/** 把执行失败的命令整理成可以回传给 AI 的纠错反馈。 */
export function buildErrorFeedback(failed: string[]): string {
    if (!failed?.length) return "";
    return [
        "以下命令已在真实 GeoGebra 中执行并判定失败（evalCommand 返回 false 或方法不存在）：",
        ...failed.slice(0, 12).map((c, i) => `${i + 1}. ${c}`),
        "常见原因：命令不存在（如 Slider()、ParallelLine()）、参数个数不对（中文界面把 Point 显示为「描点」）、",
        "对象/参数未定义、命令顺序错误、命令末尾多余逗号、API 方法名大小写错误。",
        "请输出修正后完整且可直接执行的命令列表，不要再包含上述失败命令。",
    ].join("\n");
}
