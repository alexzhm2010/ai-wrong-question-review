"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

interface VersionInfo {
    version: string;
    releasedAt?: string;
    notes?: string;
}

/**
 * 右上角版本徽标：读取 /version.json（带缓存破坏），展示当前版本号。
 * 点击弹出发布时间，方便用户在系统内确认是否为最新版本。
 */
export function VersionBadge() {
    const [info, setInfo] = useState<VersionInfo | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let active = true;
        fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
            .then((d: VersionInfo) => {
                if (active) setInfo(d);
            })
            .catch(() => {
                if (active) setFailed(true);
            });
        return () => {
            active = false;
        };
    }, []);

    const label = info?.version
        ? `v${info.version}`
        : failed
            ? "v?"
            : "…";

    const handleClick = () => {
        if (!info) {
            toast.info("未能获取版本信息");
            return;
        }
        const time = info.releasedAt
            ? new Date(info.releasedAt).toLocaleString()
            : "未知时间";
        const extra = info.notes ? `｜${info.notes}` : "";
        toast.info(`当前版本 ${label} · 发布于 ${time}${extra}`);
    };

    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={handleClick}
            title="点击查看版本信息"
            className="rounded-full text-xs font-mono text-muted-foreground hover:text-primary px-3 h-9 shrink-0"
        >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5 shrink-0" />
            {label}
        </Button>
    );
}
