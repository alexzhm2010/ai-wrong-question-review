"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import { formatMoney } from "@/lib/quota-status";
import {
    resolveQuotaWarning,
    subscribeQuotaWarning,
    type QuotaWarningDetail,
} from "@/lib/quota-guard";

const FALLBACK_CONSOLE = "https://console.volcengine.com/finance/fund/account-balance";

/**
 * 全局唯一的「导入前余额偏低」提醒弹窗，挂在 RootLayout。
 *
 * 各导入入口只调用 confirmQuotaBeforeImport()，通过模块级单例桥唤醒本组件，
 * 因此不需要每个页面各自维护一份弹窗状态。
 */
export function QuotaGuardDialog() {
    const { t } = useLanguage();
    const [detail, setDetail] = useState<QuotaWarningDetail | null>(null);
    const g = t.settings?.quota?.importGuard;

    useEffect(() => subscribeQuotaWarning(setDetail), []);

    useEffect(() => {
        if (!detail) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") resolveQuotaWarning(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [detail]);

    if (!detail) return null;

    const balance = formatMoney(detail.balance, detail.currency);
    const threshold = formatMoney(detail.threshold, detail.currency);
    const syncedAt = detail.fetchedAt
        ? new Date(detail.fetchedAt).toLocaleString()
        : "";
    const consoleUrl = detail.consoleUrl || FALLBACK_CONSOLE;

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/40 px-5 backdrop-blur-sm">
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="quota-guard-title"
                className="w-full max-w-sm rounded-2xl border border-white/70 bg-white/95 p-5 shadow-[0_20px_60px_rgba(30,64,110,0.25)] backdrop-blur-xl"
            >
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-200">
                        <AlertTriangle className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                        <h2 id="quota-guard-title" className="text-base font-semibold text-slate-900">
                            {g?.title || "AI 余额偏低"}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {g?.delayHint || "余额来自服务端快照，火山账单约 5–10 分钟出账，数值可能略有延迟。"}
                        </p>
                    </div>
                </div>

                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/70 p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs text-blue-900/70">
                            <Wallet className="h-3.5 w-3.5" />
                            {g?.availableBalance || "账户可用余额"}
                        </span>
                        <span className="text-lg font-semibold text-blue-900">{balance}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-blue-900/70">
                        <span>{g?.thresholdLabel || "后台告警阈值"}</span>
                        <span className="font-medium">{threshold}</span>
                    </div>
                    {syncedAt && (
                        <p className="text-[11px] text-blue-900/55">
                            {(g?.syncedAt || "余额同步于 {time}").replace("{time}", syncedAt)}
                        </p>
                    )}
                </div>

                <p className="mt-3 text-sm leading-relaxed text-slate-600">
                    {(g?.desc || "当前可用余额 {balance}，低于后台设置的告警阈值 {threshold}。继续导入会调用 AI 并产生费用。")
                        .replace("{balance}", balance)
                        .replace("{threshold}", threshold)}
                </p>

                <a
                    href={consoleUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-700 underline underline-offset-2"
                >
                    {g?.consoleLink || "去火山费用中心充值"}
                    <ExternalLink className="h-3 w-3" />
                </a>

                <div className="mt-5 flex gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        className="flex-1"
                        onClick={() => resolveQuotaWarning(false)}
                    >
                        {g?.cancel || "取消本次导入"}
                    </Button>
                    <Button
                        type="button"
                        className="flex-[1.2]"
                        onClick={() => resolveQuotaWarning(true)}
                    >
                        {g?.continueLabel || "仍要继续导入"}
                    </Button>
                </div>
            </div>
        </div>
    );
}
