"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOAST_EVENT, type ToastPayload, type ToastType } from "@/lib/toast";

const MAX_TOASTS = 4;
const DURATION = 3500;
const EXIT_DURATION = 200;

type ToastItem = ToastPayload & { visible: boolean };

const STYLES: Record<ToastType, string> = {
    success: "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
    info: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200",
    warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
};

const ICONS: Record<ToastType, React.ComponentType<{ className?: string }>> = {
    success: CheckCircle2,
    error: XCircle,
    info: Info,
    warning: AlertTriangle,
};

export function Toaster() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    const schedule = useCallback((fn: () => void, delay: number) => {
        const timer = setTimeout(() => {
            timers.current.delete(timer);
            fn();
        }, delay);
        timers.current.add(timer);
        return timer;
    }, []);

    const dismiss = useCallback(
        (id: number) => {
            setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, visible: false } : t)));
            schedule(() => {
                setToasts((prev) => prev.filter((t) => t.id !== id));
            }, EXIT_DURATION);
        },
        [schedule]
    );

    useEffect(() => {
        const handleToast = (event: Event) => {
            const detail = (event as CustomEvent<ToastPayload>).detail;
            if (!detail) return;
            const item: ToastItem = { ...detail, visible: false };
            setToasts((prev) => [...prev, item].slice(-MAX_TOASTS));
            schedule(() => {
                setToasts((prev) => prev.map((t) => (t.id === detail.id ? { ...t, visible: true } : t)));
            }, 20);
            schedule(() => dismiss(detail.id), DURATION);
        };

        window.addEventListener(TOAST_EVENT, handleToast);

        const activeTimers = timers.current;
        return () => {
            window.removeEventListener(TOAST_EVENT, handleToast);
            activeTimers.forEach((timer) => clearTimeout(timer));
            activeTimers.clear();
        };
    }, [dismiss, schedule]);

    if (toasts.length === 0) return null;

    return (
        <div
            aria-live="polite"
            className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))]"
        >
            {toasts.map((item) => {
                const Icon = ICONS[item.type];
                return (
                    <div
                        key={item.id}
                        role="status"
                        className={cn(
                            "pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg transition-all duration-200 ease-out",
                            STYLES[item.type],
                            item.visible ? "translate-y-0 scale-100 opacity-100" : "-translate-y-2 scale-95 opacity-0"
                        )}
                    >
                        <Icon className="mt-0.5 size-4 shrink-0" />
                        <p className="flex-1 leading-snug break-words">{item.message}</p>
                        <button
                            type="button"
                            onClick={() => dismiss(item.id)}
                            aria-label="关闭提示"
                            className="-mr-1 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
                        >
                            <X className="size-4" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
