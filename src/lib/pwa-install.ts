/**
 * PWA 安装引导的纯逻辑层（无 DOM 依赖，便于单测）。
 *
 * 背景：部分安卓 WebView / 国产浏览器虽然会派发 beforeinstallprompt，用户在
 * 系统弹窗里点了「保存 / 添加」后却既不真正安装、也不 resolve userChoice。
 * 旧实现 `await prompt(); await userChoice;` 会永远卡住，按钮点了毫无反应，
 * 只剩右上角的关闭按钮可用。这里统一做超时降级到手动步骤。
 */

export const PWA_DISMISS_KEY = "wr:pwa-install-dismissed";
export const PWA_LATER_KEY = "wr:pwa-install-later";
export const PWA_OPEN_EVENT = "wr:open-pwa-installer";

export type InstallChoiceOutcome = "accepted" | "dismissed" | "unknown";

/** 系统安装弹窗多久没回结果就判定为「不可用」，切到手动引导 */
export const INSTALL_CHOICE_TIMEOUT_MS = 6000;

/**
 * 等待用户安装选择，但绝不无限等待。
 * 传入 undefined / 非 Promise / reject / 超时，一律返回 unknown，
 * 由调用方降级为手动步骤，而不是静默卡住。
 */
export function awaitInstallChoice(
    userChoice: Promise<{ outcome?: string }> | undefined,
    timeoutMs: number = INSTALL_CHOICE_TIMEOUT_MS
): Promise<InstallChoiceOutcome> {
    if (!userChoice || typeof (userChoice as Promise<unknown>).then !== "function") {
        return Promise.resolve("unknown");
    }
    return new Promise<InstallChoiceOutcome>((resolve) => {
        let settled = false;
        const finish = (value: InstallChoiceOutcome) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const timer = setTimeout(() => finish("unknown"), timeoutMs);
        userChoice.then(
            (choice) => {
                clearTimeout(timer);
                const outcome = choice?.outcome;
                finish(outcome === "accepted" || outcome === "dismissed" ? outcome : "unknown");
            },
            () => {
                clearTimeout(timer);
                finish("unknown");
            }
        );
    });
}

/**
 * 计算被浏览器底部工具栏 / 软键盘遮住的高度。
 * `position: fixed; bottom` 相对的是 layout viewport，而手机浏览器的地址栏、
 * 底部工具栏会盖住可视区域底部；引导条若只留 12px，底部的「立即安装」按钮
 * 正好落在被遮挡区，右上角关闭按钮却露在外面 —— 表现为「只有 X 能点」。
 */
export function getOccludedBottom(
    layoutHeight: number,
    visualHeight: number,
    visualOffsetTop: number
): number {
    if (!Number.isFinite(layoutHeight) || !Number.isFinite(visualHeight)) return 0;
    const offset = Number.isFinite(visualOffsetTop) ? visualOffsetTop : 0;
    return Math.max(0, Math.round(layoutHeight - visualHeight - offset));
}

/** 系统弹窗不可用时的兜底步骤；按 iOS / 其它浏览器分别给可操作指引 */
export function getInstallSteps(isZh: boolean, isIOS: boolean): string[] {
    if (!isZh) {
        return isIOS
            ? [
                "Open this site in Safari.",
                "Tap Share at the bottom, then Add to Home Screen, then Add.",
                "Open from the home screen icon to get a full-screen view.",
            ]
            : [
                "Grant permission first: Android Settings > Apps > your browser > Permissions > allow Home screen shortcuts.",
                "If an icon with the same name already exists, long-press and remove it, then retry.",
                "Open the browser menu > Install app / Add to Home screen / Add to desktop.",
                "Launch from the new icon: the address bar and bottom toolbar are gone.",
                "Still nothing? The system dialog is browser-side — try Chrome or Edge.",
            ];
    }
    return isIOS
        ? [
            "用 Safari 打开本站。",
            "点底部「分享」→「添加到主屏幕」→ 右上角「添加」。",
            "之后从桌面图标打开，即为全屏。",
        ]
        : [
            "先给浏览器授权：系统设置 → 应用 → 你的浏览器 → 权限 → 允许「创建桌面快捷方式」。",
            "若桌面已有同名图标，先长按删除，再重试。",
            "浏览器右上角菜单 →「安装应用 / 添加到主屏幕 / 添加到桌面」。",
            "装好后从桌面图标打开，就不再显示地址栏与底部工具栏。",
            "仍无反应可换 Chrome / Edge 打开本站再安装。",
        ];
}
