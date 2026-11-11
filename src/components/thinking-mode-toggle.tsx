"use client";

import { useSyncExternalStore } from "react";
import { Brain, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

/**
 * 每题独立的「思考深度」选择。
 *
 * 为什么放在题上而不是设置里：思考长度影响的是「这道题等多久 / 值不值得为它多花钱」，
 * 是逐题的取舍（选择题想快、大题想稳），不是一次性偏好。所以选择保存在本机、
 * 记住上次选择，但每次提交前都能就地改。
 */
export type ThinkingMode = "deep" | "fast";

const STORAGE_KEY = "aqr.thinkingMode";

// 模块级单例：同一页面里多个开关实例保持同步，避免出现两处取值不一致
let cached: ThinkingMode = "deep";
let hydrated = false;
const listeners = new Set<() => void>();

function readStored(): ThinkingMode {
    if (typeof window === "undefined") return "deep";
    try {
        return window.localStorage.getItem(STORAGE_KEY) === "fast" ? "fast" : "deep";
    } catch {
        return "deep";
    }
}

function hydrate() {
    if (hydrated || typeof window === "undefined") return;
    hydrated = true;
    cached = readStored();
}

function subscribe(onChange: () => void) {
    listeners.add(onChange);
    return () => {
        listeners.delete(onChange);
    };
}

export function setThinkingMode(mode: ThinkingMode) {
    hydrated = true;
    cached = mode;
    if (typeof window !== "undefined") {
        try {
            window.localStorage.setItem(STORAGE_KEY, mode);
        } catch {
            /* 隐私模式下写入失败，忽略即可 */
        }
    }
    listeners.forEach((fn) => fn());
}

/** 读取并订阅当前的思考模式（默认深度思考，选择记在本机） */
export function useThinkingMode(): [ThinkingMode, (mode: ThinkingMode) => void] {
    const mode = useSyncExternalStore(
        subscribe,
        () => {
            hydrate();
            return cached;
        },
        () => "deep" as ThinkingMode,
    );
    return [mode, setThinkingMode];
}

interface ThinkingModeToggleProps {
    value: ThinkingMode;
    onChange: (mode: ThinkingMode) => void;
    disabled?: boolean;
    className?: string;
}

export function ThinkingModeToggle({ value, onChange, disabled, className }: ThinkingModeToggleProps) {
    const { language } = useLanguage();
    const isZh = language === "zh";

    const options: { id: ThinkingMode; icon: typeof Zap; label: string; hint: string }[] = [
        {
            id: "fast",
            icon: Zap,
            label: isZh ? "快速" : "Fast",
            hint: isZh ? "关闭思考，约 10 秒；复杂题更容易算错" : "No thinking, ~10s, riskier on hard questions",
        },
        {
            id: "deep",
            icon: Brain,
            label: isZh ? "深度" : "Deep",
            hint: isZh ? "深度思考，约 40–80 秒；正确率更高" : "Deep thinking, ~40-80s, best accuracy",
        },
    ];

    return (
        <div
            role="radiogroup"
            aria-label={isZh ? "思考深度" : "Thinking depth"}
            className={cn(
                "inline-flex shrink-0 items-center rounded-full border bg-background p-0.5",
                disabled && "opacity-60",
                className,
            )}
        >
            {options.map((opt) => {
                const active = value === opt.id;
                const Icon = opt.icon;
                return (
                    <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={opt.hint}
                        disabled={disabled}
                        onClick={() => onChange(opt.id)}
                        className={cn(
                            "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                            active
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                            disabled && "cursor-not-allowed",
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
