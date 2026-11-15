"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api-client";
import { useLanguage } from "@/contexts/LanguageContext";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { daysUntilExpiry, formatMoney, getQuotaStatus } from "@/lib/quota-status";
import type { AiQuotaResponse } from "@/types/api";

const STATUS_STYLES: Record<string, string> = {
    ok: "border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
    warn: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
    danger: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
    error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
    unknown: "border-border bg-muted text-muted-foreground",
    unconfigured: "border-border bg-muted text-muted-foreground",
};

const VOLC_CONSOLE_FALLBACK = "https://console.volcengine.com/finance/fund/account-balance";

/** 火山方舟账户额度与余额。挂在设置页 AI 页与「我的」页。 */
export function AiQuotaCard() {
    const { t } = useLanguage();
    const q = t.settings?.quota;
    const [data, setData] = useState<AiQuotaResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [threshold, setThreshold] = useState("20");
    const [expireAt, setExpireAt] = useState("");
    const [stopEnabled, setStopEnabled] = useState(true);
    const [manualBalance, setManualBalance] = useState("");

    const load = useCallback(async (force = false) => {
        try {
            const res = await apiClient.get<AiQuotaResponse>(`/api/ai-quota${force ? "?refresh=1" : ""}`);
            setData(res);
            if (res.settings) {
                setThreshold(String(res.settings.warnThreshold ?? 20));
                setExpireAt(res.settings.freeQuotaExpireAt ?? "");
                setStopEnabled(res.settings.stopWhenFreeExpired !== false);
                setManualBalance(
                    res.settings.manualBalance === null || res.settings.manualBalance === undefined
                        ? ""
                        : String(res.settings.manualBalance)
                );
            }
        } catch {
            setData(null);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const parsedBalance = manualBalance.trim() === "" ? null : Number(manualBalance);
            if (parsedBalance !== null && (!Number.isFinite(parsedBalance) || parsedBalance < 0)) {
                toast.error(q?.invalidBalance || "余额必须是非负数字");
                setSaving(false);
                return;
            }
            await apiClient.post("/api/ai-quota", {
                manualBalance: parsedBalance,
                warnThreshold: Number(threshold),
                freeQuotaExpireAt: expireAt,
                stopWhenFreeExpired: stopEnabled,
            });
            toast.success(q?.saved || "额度设置已保存");
            await load(true);
        } catch {
            toast.error(q?.saveError || "保存失败：需要管理员权限");
        } finally {
            setSaving(false);
        }
    };

    const numericThreshold = Number(threshold) || 20;
    const status = getQuotaStatus(data, numericThreshold);
    const statusLabel = {
        ok: q?.statusOk || "正常",
        warn: q?.statusWarn || "偏低",
        danger: q?.statusDanger || "告警",
        error: q?.statusDanger || "告警",
        unconfigured: q?.unconfigured || "尚未同步",
        unknown: q?.statusUnknown || "未知",
    }[status];

    const daysLeft = daysUntilExpiry(expireAt);
    const nearExpiry = daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;
    const blocked = !!data?.availability && data.availability.allowed === false;
    const balance = data?.balance;
    const consoleUrl = data?.consoleUrl || VOLC_CONSOLE_FALLBACK;
    const sourceLabel = {
        "volc-api": q?.sourceVolcApi || "服务端自动同步",
        manual: q?.sourceManual || "控制台手动录入",
        none: q?.sourceNone || "尚未同步",
    }[data?.source || "none"];

    return (
        <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{q?.title || "火山方舟 · 额度与余额"}</span>
                    <span
                        className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                            STATUS_STYLES[status]
                        )}
                    >
                        {status === "danger" || status === "error" ? (
                            <AlertTriangle className="h-3 w-3" />
                        ) : status === "ok" ? (
                            <CheckCircle2 className="h-3 w-3" />
                        ) : null}
                        {statusLabel}
                    </span>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={loading || refreshing}
                    onClick={() => {
                        setRefreshing(true);
                        void load(true);
                    }}
                >
                    {refreshing ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                        <RefreshCw className="mr-1 h-3 w-3" />
                    )}
                    {q?.refresh || "刷新"}
                </Button>
            </div>

            <p className="text-xs text-muted-foreground">{q?.desc}</p>

            {/* 自动同步状态：密钥只在服务端，前端永远不接触 */}
            <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 text-xs space-y-1.5 dark:border-blue-900 dark:bg-blue-950/40">
                <div className="flex flex-wrap items-center justify-between gap-2 font-medium text-blue-900 dark:text-blue-100">
                    <span>{q?.balanceNotice || "余额与自动同步"}</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-white/70 px-2 py-0.5 text-[11px] dark:border-blue-700 dark:bg-blue-900/40">
                        <span className={`h-1.5 w-1.5 rounded-full ${data?.autoSyncConfigured ? "bg-green-500" : "bg-amber-500"}`} />
                        {data?.autoSyncConfigured
                            ? (q?.autoSyncOn || "自动同步已开启")
                            : (q?.autoSyncOff || "自动同步未开启")}
                    </span>
                </div>
                <p className="leading-relaxed text-blue-900/75 dark:text-blue-100/75">
                    {q?.keyNotice || "已配置火山引擎 IAM 只读密钥，打开本页时自动向费用中心查询真实余额（10 分钟节流），密钥仅保存在服务端。点「刷新」可立即重新查询。"}
                </p>
                <a
                    href={consoleUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 font-medium text-blue-800 underline underline-offset-2 dark:text-blue-200"
                >
                    {q?.consoleLink || "打开火山引擎费用中心查看余额"}
                    <ExternalLink className="h-3 w-3" />
                </a>
            </div>

            {blocked && !loading ? (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1">
                        <p className="font-medium">{q?.aiStopped || "AI 已暂停"}</p>
                        <p className="text-red-700 dark:text-red-300">{q?.aiStoppedDesc}</p>
                    </div>
                </div>
            ) : null}

            {loading ? (
                <div className="flex justify-center py-3">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            ) : !data || data.status === "unconfigured" ? (
                <div className="rounded-md border bg-background p-3 text-xs space-y-1">
                    <p className="font-medium">{q?.unconfigured || "尚未同步余额"}</p>
                    <p className="text-muted-foreground">{q?.unconfiguredDesc}</p>
                </div>
            ) : data.status === "error" ? (
                <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                    {data.message || q?.error}
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-md border bg-background p-3">
                        <p className="text-xs text-muted-foreground">{q?.availableBalance || "账户可用余额"}</p>
                        <p className="mt-1 text-xl font-semibold">
                            {formatMoney(balance?.availableAmount, balance?.currency)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {q?.cashBalance || "现金余额"}: {formatMoney(balance?.availableCashAmount, balance?.currency)}
                        </p>
                    </div>
                    <div className="rounded-md border bg-background p-3">
                        <p className="text-xs text-muted-foreground">{q?.balanceSource || "余额来源"}</p>
                        <p className="mt-1 text-base font-semibold">{sourceLabel}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {data.fetchedAt
                                ? `${q?.syncedAt || "同步于"} ${new Date(data.fetchedAt).toLocaleString()}`
                                : q?.autoSyncOff || "自动同步未开启"}
                        </p>
                    </div>
                    <div
                        className={cn(
                            "rounded-md border bg-background p-3",
                            daysLeft !== null && daysLeft < 0
                                ? "border-red-300 dark:border-red-900"
                                : nearExpiry
                                    ? "border-amber-300 dark:border-amber-900"
                                    : ""
                        )}
                    >
                        <p className="text-xs text-muted-foreground">{q?.freeQuotaExpiry || "免费额度到期日"}</p>
                        <p className="mt-1 text-xl font-semibold">{expireAt || q?.noExpiry || "未填写"}</p>
                        <p
                            className={cn(
                                "mt-1 text-xs text-muted-foreground",
                                daysLeft !== null && daysLeft < 0
                                    ? "font-medium text-red-600 dark:text-red-400"
                                    : nearExpiry
                                        ? "font-medium text-amber-600 dark:text-amber-400"
                                        : ""
                            )}
                        >
                            {daysLeft === null
                                ? ""
                                : daysLeft < 0
                                    ? q?.expired || "已过期"
                                    : `${daysLeft} ${q?.daysLeft || "天后到期"}`}
                        </p>
                    </div>
                </div>
            )}

            {data?.provider && (
                <p className="text-xs text-muted-foreground">
                    {q?.provider || "当前供应商"}: {data.provider.name} · {data.provider.model}
                </p>
            )}

            <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
                <div className="space-y-1">
                    <Label htmlFor="quota-balance" className="text-xs">{q?.syncBalance || "同步账户余额（元）"}</Label>
                    <Input
                        id="quota-balance"
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="例如 19.50"
                        value={manualBalance}
                        onChange={(e) => setManualBalance(e.target.value)}
                        className="h-8"
                    />
                    <p className="text-xs text-muted-foreground">{q?.syncBalanceDesc}</p>
                </div>
                <div className="space-y-1">
                    <Label htmlFor="quota-threshold" className="text-xs">{q?.warnThreshold || "低余额告警阈值（元）"}</Label>
                    <Input
                        id="quota-threshold"
                        type="number"
                        min="0"
                        step="1"
                        value={threshold}
                        onChange={(e) => setThreshold(e.target.value)}
                        className="h-8"
                    />
                    <p className="text-xs text-muted-foreground">{q?.warnThresholdDesc}</p>
                </div>
                <div className="space-y-1">
                    <Label htmlFor="quota-expiry" className="text-xs">{q?.freeQuotaExpiry || "免费额度到期日"}</Label>
                    <Input
                        id="quota-expiry"
                        type="date"
                        value={expireAt}
                        onChange={(e) => setExpireAt(e.target.value)}
                        className="h-8"
                    />
                    <p className="text-xs text-muted-foreground">
                        {q?.expiryDesc || "按火山方舟免费额度或资源包的实际到期日填写。"}
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t pt-3">
                <div className="space-y-0.5">
                    <Label htmlFor="quota-stop" className="text-xs font-medium">{q?.stopWhenFreeExpired || "额度到期即停"}</Label>
                    <p className="text-xs text-muted-foreground">{q?.stopWhenFreeExpiredDesc}</p>
                </div>
                <Switch
                    id="quota-stop"
                    checked={stopEnabled}
                    onCheckedChange={setStopEnabled}
                />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" size="sm" className="h-8" disabled={saving} onClick={handleSave}>
                    {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                    {q?.save || "保存额度设置"}
                </Button>
                {data?.fetchedAt && (
                    <span className="text-xs text-muted-foreground">
                        {q?.updatedAt || "更新于"}: {new Date(data.fetchedAt).toLocaleString()}
                    </span>
                )}
            </div>
        </div>
    );
}
