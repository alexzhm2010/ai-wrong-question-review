"use client";
import { BASE_PATH } from "@/lib/supabase/config";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { CheckCircle2, Download, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import {
    awaitInstallChoice,
    getInstallSteps,
    getOccludedBottom,
    PWA_DISMISS_KEY,
    PWA_LATER_KEY,
    PWA_OPEN_EVENT,
} from "@/lib/pwa-install";

type PromptEvent = Event & {
    prompt: () => Promise<void> | void;
    userChoice?: Promise<{ outcome?: string }>;
};

type Mode = "hidden" | "install" | "hint" | "manual" | "done";

function isStandalone(): boolean {
    return (
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
}

function wasDismissed(): boolean {
    try {
        return (
            localStorage.getItem(PWA_DISMISS_KEY) === "1" ||
            sessionStorage.getItem(PWA_LATER_KEY) === "1"
        );
    } catch {
        return false;
    }
}

function markDismissed() {
    try {
        localStorage.setItem(PWA_DISMISS_KEY, "1");
        sessionStorage.removeItem(PWA_LATER_KEY);
    } catch {
        // 隐私模式下存储不可写，忽略
    }
}

function closeForSession() {
    try {
        sessionStorage.setItem(PWA_LATER_KEY, "1");
    } catch {
        // ignore
    }
}

export function PwaInstaller() {
    const { language } = useLanguage();
    const pathname = usePathname();
    const isZh = language === "zh";

    const [mode, setMode] = useState<Mode>("hidden");
    const [hasPrompt, setHasPrompt] = useState(false);
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [isIOS, setIsIOS] = useState(false);
    const [bottomOffset, setBottomOffset] = useState(12);

    // 事件对象放 ref：避免 state 更新带来的渲染时机问题，也保证 prompt() 可在用户手势内同步调用
    const promptRef = useRef<PromptEvent | null>(null);
    const promptUsedRef = useRef(false);
    const installedRef = useRef(false);

    const dismissForever = useCallback(() => {
        markDismissed();
        setMode("hidden");
    }, []);

    const later = useCallback(() => {
        closeForSession();
        setMode("hidden");
    }, []);

    useEffect(() => {
        if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
            navigator.serviceWorker.register(`${BASE_PATH}/sw.js`).catch(() => {
                // 注册失败不影响使用，退化为浏览器内访问
            });
        }
    }, []);

    // 按 visualViewport 计算被浏览器底部工具栏 / 软键盘遮住的高度，避免底部按钮点不到
    useEffect(() => {
        const vv = window.visualViewport;
        const update = () => {
            const occluded = vv
                ? getOccludedBottom(window.innerHeight, vv.height, vv.offsetTop)
                : 0;
            const min = window.matchMedia("(max-width: 640px)").matches ? 24 : 12;
            setBottomOffset(Math.max(min, occluded + 12));
        };
        update();
        vv?.addEventListener("resize", update);
        vv?.addEventListener("scroll", update);
        window.addEventListener("resize", update);
        return () => {
            vv?.removeEventListener("resize", update);
            vv?.removeEventListener("scroll", update);
            window.removeEventListener("resize", update);
        };
    }, []);

    useEffect(() => {
        const ios =
            /iPad|iPhone|iPod/.test(navigator.userAgent) &&
            !(window as Window & { MSStream?: unknown }).MSStream;
        setIsIOS(ios);

        const onBeforeInstall = (event: Event) => {
            event.preventDefault();
            promptRef.current = event as PromptEvent;
            promptUsedRef.current = false;
            setHasPrompt(true);
            if (!isStandalone() && !wasDismissed() && !pathname?.startsWith("/login") && !pathname?.startsWith("/register")) {
                setMode("install");
            }
        };

        const onInstalled = () => {
            installedRef.current = true;
            markDismissed();
            setBusy(false);
            setMode("done");
            setFeedback(
                isZh
                    ? "安装成功。之后请从桌面图标打开，就不会再显示地址栏和底部工具栏。"
                    : "Installed. Open from the home screen icon for a full-screen view."
            );
        };

        // 设置页里的「添加到主屏幕」入口：清掉忽略标记并重新展示引导
        const onOpen = () => {
            try {
                localStorage.removeItem(PWA_DISMISS_KEY);
                sessionStorage.removeItem(PWA_LATER_KEY);
            } catch {
                // ignore
            }
            setBusy(false);
            if (isStandalone()) {
                setMode("done");
                setFeedback(
                    isZh
                        ? "当前已经是从桌面图标打开的全屏模式，无需再安装。"
                        : "Already running full screen from the home screen icon."
                );
                return;
            }
            setFeedback("");
            setMode(promptRef.current && !promptUsedRef.current ? "install" : "manual");
        };

        const onVisibility = () => {
            if (document.visibilityState === "visible" && isStandalone()) {
                markDismissed();
                setMode("hidden");
            }
        };

        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        window.addEventListener("appinstalled", onInstalled);
        window.addEventListener(PWA_OPEN_EVENT, onOpen);
        document.addEventListener("visibilitychange", onVisibility);

        let timer: number | undefined;
        const skipAuto =
            isStandalone() ||
            wasDismissed() ||
            pathname?.startsWith("/login") ||
            pathname?.startsWith("/register");
        if (!skipAuto) {
            // 不派发安装事件的浏览器（iOS、部分国产浏览器）给一次菜单引导
            timer = window.setTimeout(() => {
                setMode((current) => (current === "hidden" && !wasDismissed() ? "hint" : current));
            }, 1500);
        }

        return () => {
            if (timer) window.clearTimeout(timer);
            window.removeEventListener("beforeinstallprompt", onBeforeInstall);
            window.removeEventListener("appinstalled", onInstalled);
            window.removeEventListener(PWA_OPEN_EVENT, onOpen);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [pathname, language]);

    const handleInstall = () => {
        const evt = promptRef.current;
        if (!evt || typeof evt.prompt !== "function" || promptUsedRef.current) {
            setMode("manual");
            setFeedback(
                isZh
                    ? "系统安装弹窗已不可用，请按下面步骤在浏览器菜单里手动添加。"
                    : "The system install dialog is unavailable. Follow the steps below."
            );
            return;
        }
        promptUsedRef.current = true;

        // Chrome 要求 prompt() 在用户手势的同步调用栈内调用，前面不能有任何 await；
        // 且不少实现的返回值是永不 resolve 的 Promise，所以绝不 await 它。
        try {
            const returned = evt.prompt();
            void Promise.resolve(returned).catch(() => undefined);
        } catch {
            setMode("manual");
            setFeedback(
                isZh
                    ? "浏览器拒绝了安装弹窗，请按下面步骤手动添加。"
                    : "The browser rejected the install dialog. Follow the steps below."
            );
            return;
        }

        setBusy(true);
        setFeedback(
            isZh
                ? "已请求安装，请在弹出的系统窗口点「保存 / 添加」。如果没有反应，几秒后会自动显示手动步骤。"
                : "Install requested. Confirm in the system dialog; if nothing happens, manual steps will appear shortly."
        );

        void awaitInstallChoice(evt.userChoice).then((outcome) => {
            if (installedRef.current) return;
            if (outcome === "accepted") {
                // appinstalled 可能稍晚到达，等一下再判断是否真的建好了快捷方式，避免闪一下错误提示
                window.setTimeout(() => {
                    if (installedRef.current) return;
                    setBusy(false);
                    setMode("manual");
                    setFeedback(
                        isZh
                            ? "已确认安装，但浏览器没有完成创建。若桌面没出现图标，多半是没给「创建桌面快捷方式」权限或已有同名图标，请按下面步骤检查。"
                            : "Confirmed, but the browser did not finish creating the shortcut. Check the permission steps below."
                    );
                }, 1200);
                return;
            }
            setBusy(false);
            setMode("manual");
            if (outcome === "dismissed") {
                setFeedback(
                    isZh
                        ? "你取消了安装。也可以按下面步骤在浏览器菜单里手动添加。"
                        : "Install dismissed. You can still add it manually using the steps below."
                );
            } else {
                setFeedback(
                    isZh
                        ? "浏览器没有返回安装结果（点「保存」没反应通常是这个原因）。这个系统弹窗由浏览器控制，网页无法代劳，请按下面步骤手动添加。"
                        : "The browser never returned an install result. That system dialog is browser-controlled; please follow the manual steps below."
                );
            }
        });
    };

    if (mode === "hidden") return null;

    const showSteps = mode === "hint" || mode === "manual";
    const steps = getInstallSteps(isZh, isIOS);

    const title =
        mode === "done"
            ? isZh ? "已经在全屏模式" : "Already full screen"
            : mode === "manual"
                ? isZh ? "手动添加到主屏幕" : "Add to Home Screen manually"
                : mode === "hint"
                    ? isZh ? "添加到主屏幕，像 App 一样打开" : "Add to Home Screen for full screen"
                    : isZh ? "安装到桌面，全屏使用" : "Install for a full-screen view";

    const description =
        mode === "hint" || mode === "manual" || mode === "done"
            ? isZh
                ? "从桌面图标打开后，不再显示地址栏和底部工具栏。"
                : "Open from the home screen icon — no address bar or bottom toolbar."
            : isZh
                ? "装好后从桌面图标打开，不再显示地址栏和底部工具栏。"
                : "Open from the home screen icon — no address bar or bottom toolbar.";

    return (
        <div
            role="dialog"
            aria-label={title}
            className="fixed inset-x-3 z-[90] mx-auto max-w-md rounded-xl border bg-background p-4 text-foreground shadow-lg print:hidden sm:inset-x-auto sm:right-6 sm:w-[380px]"
            style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${bottomOffset}px)` }}
        >
            <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    {mode === "done" ? <CheckCircle2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
                </div>
                <button
                    type="button"
                    onClick={dismissForever}
                    aria-label={isZh ? "关闭且不再提示" : "Close and don't show again"}
                    title={isZh ? "关闭且不再提示" : "Close and don't show again"}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {feedback && (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    {feedback}
                </div>
            )}

            {showSteps && (
                <ol className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                    {steps.map((step, index) => (
                        <li key={index} className="flex gap-2">
                            <span className="shrink-0 font-medium text-foreground">{index + 1}.</span>
                            <span>{step}</span>
                        </li>
                    ))}
                </ol>
            )}

            {mode === "install" && (
                <button
                    type="button"
                    onClick={() => { setMode("manual"); setFeedback(""); }}
                    className="mt-3 text-xs text-primary underline underline-offset-2"
                >
                    {isZh ? "系统弹窗点保存没反应？改用手动添加 →" : "System dialog not responding? Add manually →"}
                </button>
            )}

            <div className="mt-3 flex flex-wrap justify-end gap-2">
                {mode === "install" && (
                    <>
                        <Button variant="ghost" size="sm" className="min-h-[40px]" onClick={later}>
                            {isZh ? "以后再说" : "Later"}
                        </Button>
                        <Button size="sm" className="min-h-[40px]" onClick={handleInstall} disabled={busy}>
                            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                            {busy
                                ? isZh ? "等待系统弹窗…" : "Waiting for dialog…"
                                : isZh ? "立即安装" : "Install"}
                        </Button>
                    </>
                )}
                {mode === "manual" && hasPrompt && !promptUsedRef.current && (
                    <Button variant="ghost" size="sm" className="min-h-[40px]" onClick={() => { setMode("install"); setFeedback(""); }}>
                        {isZh ? "返回安装" : "Back to install"}
                    </Button>
                )}
                {showSteps && (
                    <Button variant="outline" size="sm" className="min-h-[40px]" onClick={later}>
                        {isZh ? "知道了" : "Got it"}
                    </Button>
                )}
                {mode === "done" && (
                    <Button variant="outline" size="sm" className="min-h-[40px]" onClick={dismissForever}>
                        {isZh ? "关闭" : "Close"}
                    </Button>
                )}
            </div>
        </div>
    );
}
