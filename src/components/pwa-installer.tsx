"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

type PromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Mode = "hidden" | "install" | "hint";

/** 用户忽略过之后不再重复打扰；已安装的 standalone 模式也直接隐藏 */
const DISMISS_KEY = "wr:pwa-install-dismissed";

export function PwaInstaller() {
    const { language } = useLanguage();
    const pathname = usePathname();
    const [mode, setMode] = useState<Mode>("hidden");
    const [promptEvent, setPromptEvent] = useState<PromptEvent | null>(null);
    const [isIOS, setIsIOS] = useState(false);
    const isZh = language === "zh";

    const dismiss = useCallback(() => {
        try {
            localStorage.setItem(DISMISS_KEY, "1");
        } catch {
            // 隐私模式下 localStorage 不可写，忽略即可
        }
        setMode("hidden");
    }, []);

    useEffect(() => {
        // 仅生产环境注册，避免开发环境热更新被 Service Worker 干扰
        if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
            navigator.serviceWorker.register("/sw.js").catch(() => {
                // 注册失败不影响页面功能，退化为浏览器内访问
            });
        }

        if (pathname?.startsWith("/login") || pathname?.startsWith("/register")) {
            return;
        }

        const standalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            window.matchMedia("(display-mode: fullscreen)").matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone === true;
        if (standalone) return;

        try {
            if (localStorage.getItem(DISMISS_KEY) === "1") return;
        } catch {
            // 继续显示引导
        }

        const ios =
            /iPad|iPhone|iPod/.test(navigator.userAgent) &&
            !(window as Window & { MSStream?: unknown }).MSStream;
        setIsIOS(ios);

        const onBeforeInstall = (event: Event) => {
            event.preventDefault();
            setPromptEvent(event as PromptEvent);
            setMode("install");
        };
        const onInstalled = () => {
            setMode("hidden");
            try {
                localStorage.setItem(DISMISS_KEY, "1");
            } catch {
                // ignore
            }
        };
        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        window.addEventListener("appinstalled", onInstalled);

        // 不派发安装事件的浏览器（含 iOS、部分国产浏览器）给一次菜单引导
        const timer = window.setTimeout(() => {
            setMode((current) => (current === "hidden" ? "hint" : current));
        }, 1500);

        return () => {
            window.clearTimeout(timer);
            window.removeEventListener("beforeinstallprompt", onBeforeInstall);
            window.removeEventListener("appinstalled", onInstalled);
        };
    }, [pathname]);

    const handleInstall = async () => {
        if (!promptEvent) return;
        try {
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            if (choice.outcome === "accepted") {
                setMode("hidden");
                try {
                    localStorage.setItem(DISMISS_KEY, "1");
                } catch {
                    // ignore
                }
                return;
            }
            dismiss();
        } catch {
            dismiss();
        } finally {
            setPromptEvent(null);
        }
    };

    if (mode === "hidden") return null;

    const title =
        mode === "install"
            ? isZh
                ? "安装到桌面，全屏使用"
                : "Install for a full-screen view"
            : isZh
                ? "添加到主屏幕，像 App 一样打开"
                : "Add to Home Screen for full screen";

    const description =
        mode === "install"
            ? isZh
                ? "装好后从桌面图标打开，不再显示地址栏和底部工具栏。"
                : "Open from the home screen icon — no address bar or bottom toolbar."
            : isIOS
                ? isZh
                    ? "在 Safari 底部点「分享」→「添加到主屏幕」，之后每次打开都是全屏。"
                    : "In Safari tap Share → Add to Home Screen, then open from the icon."
                : isZh
                    ? "在浏览器菜单选「添加到主屏幕 / 安装应用」，之后从桌面图标打开即为全屏。"
                    : "Use your browser menu → Add to Home Screen, then open from the icon.";

    return (
        <div
            role="dialog"
            aria-label={title}
            className="fixed inset-x-3 z-[60] mx-auto max-w-md rounded-xl border bg-background p-4 shadow-lg sm:inset-x-auto sm:right-6 sm:w-[380px]"
            style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
        >
            <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Download className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
                </div>
                <button
                    type="button"
                    onClick={dismiss}
                    aria-label={isZh ? "关闭" : "Close"}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={dismiss}>
                    {isZh ? "以后再说" : "Later"}
                </Button>
                {mode === "install" && (
                    <Button size="sm" onClick={handleInstall}>
                        {isZh ? "立即安装" : "Install"}
                    </Button>
                )}
            </div>
        </div>
    );
}
