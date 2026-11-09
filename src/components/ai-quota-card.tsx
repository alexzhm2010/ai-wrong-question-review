"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wallet } from "lucide-react";
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

/** 仅管理员可见：AI 额度与账户余额。挂在设置页 AI 提供商 tab 顶部。 */
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

    const load = useCallback(async (force = false) => {
        try {
            const res = await apiClient.get<AiQuotaResponse>(`/api/ai-quota${force ? "?refresh=1" : ""}`);
            setData(res);
            if (res.settings) {
                setThreshold(String(res.settings.warnThreshold ?? 20));
                setExpireAt(res.settings.freeQuotaExpireAt ?? "");
                setStopEnabled(res.settings.stopWhenFreeExpired !== false);
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
            const parsed = Number(threshold);
            await apiClient.post("/api/settings", {
                quota: {
                    warnThreshold: Number.isFinite(parsed) && parsed > 0 ? parsed : 20,
                    freeQuotaExpireAt: expireAt,
                    stopWhenFreeExpired: stopEnabled,
                },
            });
            toast.success(q?.saved || "Quota settings saved");
        } catch {
            toast.error(q?.error || "Failed to save quota settings");
        } finally {
            setSaving(false);
        }
    };

    const numericThreshold = Number(threshold) || 20;
    const status = getQuotaStatus(data, numericThreshold);
    const statusLabel = {
        ok: q?.statusOk || "Healthy",
        warn: q?.statusWarn || "Low",
        danger: q?.statusDanger || "Critical",
        error: q?.statusDanger || "Critical",
        unconfigured: q?.unconfigured || "Not configured",
        unknown: q?.statusUnknown || "Unknown",
    }[status];

    const daysLeft = daysUntilExpiry(expireAt);
    const nearExpiry = daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;
    const blocked = !!data?.availability && data.availability.allowed === false;
    const balance = data?.balance;
    const spend = data?.monthSpend;

    return (
        <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{q?.title || "AI quota & balance"}</span>
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
                    {q?.refresh || "Refresh"}
                </Button>
            </div>

            <p className="text-xs text-muted-foreground">{q?.desc}</p>

            {blocked && !loading ? (
                <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1">
                        <p className="font-medium">{q?.aiStopped || "AI paused"}</p>
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
                    <p className="font-medium">{q?.unconfigured || "Not configured"}</p>
                    <p className="text-muted-foreground">{q?.unconfiguredDesc}</p>
                </div>
            ) : data.status === "error" ? (
                <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                    {data.message || q?.error}
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                    <div className="rounded-md border bg-background p-3">
                        <p className="text-xs text-muted-foreground">{q?.availableBalance || "Available balance"}</p>
                        <p className="mt-1 text-xl font-semibold">
                            {balance ? formatMoney(balance.availableAmount, balance.currency) : "--"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {q?.cashBalance || "Cash balance"}: {balance ? formatMoney(balance.availableCashAmount, balance.currency) : "--"}
                        </p>
                    </div>
                    <div className="rounded-md border bg-background p-3">
                        <p className="text-xs text-muted-foreground">{q?.monthSpend || "Model Studio spend (this month)"}</p>
                        <p className="mt-1 text-xl font-semibold">
                            {spend ? formatMoney(spend.amount, spend.currency) : q?.notBilled || "--"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{q?.billDelay}</p>
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
                        <p className="text-xs text-muted-foreground">{q?.freeQuotaExpiry || "Free quota expiry"}</p>
                        <p className="mt-1 text-xl font-semibold">{expireAt || q?.noExpiry || "--"}</p>
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
                                    ? q?.expired || "Expired"
                                    : `${daysLeft} ${q?.daysLeft || "days left"}`}
                        </p>
                    </div>
                </div>
            )}

            {data?.provider && (
                <p className="text-xs text-muted-foreground">
                    {q?.provider || "Active provider"}: {data.provider.name} · {data.provider.model}
                </p>
            )}

            <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
                <div className="space-y-1">
                    <Label htmlFor="quota-threshold" className="text-xs">{q?.warnThreshold || "Low balance threshold (CNY)"}</Label>
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
                    <Label htmlFor="quota-expiry" className="text-xs">{q?.freeQuotaExpiry || "Free quota expiry"}</Label>
                    <Input
                        id="quota-expiry"
                        type="date"
                        value={expireAt}
                        onChange={(e) => setExpireAt(e.target.value)}
                        className="h-8"
                    />
                    <p className="text-xs text-muted-foreground">
                        {t.settings?.quota?.billDelay || ""}
                    </p>
                </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t pt-3">
                <div className="space-y-0.5">
                    <Label htmlFor="quota-stop" className="text-xs font-medium">{q?.stopWhenFreeExpired || "Stop AI when free quota expires"}</Label>
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
                    {q?.save || "Save quota settings"}
                </Button>
                {data?.fetchedAt && (
                    <span className="text-xs text-muted-foreground">
                        {q?.updatedAt || "Updated"}: {new Date(data.fetchedAt).toLocaleString()}
                    </span>
                )}
            </div>
        </div>
    );
}
