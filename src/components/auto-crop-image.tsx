"use client";

import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { autoCrop } from "@/lib/image-autocrop";

/**
 * 自动裁边图片：先按原图渲染，裁完再原地换掉（不闪、不跳版）。
 * enabled=false 时完全走原图，用户想核对原始截图可以关掉。
 */
export function useAutoCrop(src: string | undefined, maxWidth: number, enabled: boolean) {
    const [url, setUrl] = useState<string | null>(null);
    const [saved, setSaved] = useState(0);
    const [done, setDone] = useState(false);

    useEffect(() => {
        setUrl(null);
        setSaved(0);
        setDone(false);
        if (!enabled || !src) return;
        let alive = true;
        autoCrop(src, maxWidth)
            .then((r) => {
                if (!alive) return;
                setUrl(r.changed ? r.url : null);
                setSaved(r.saved);
                setDone(true);
            })
            .catch(() => {
                if (alive) setDone(true);
            });
        return () => {
            alive = false;
        };
    }, [src, maxWidth, enabled]);

    return { url, saved, done };
}

interface Props extends ImgHTMLAttributes<HTMLImageElement> {
    src: string;
    maxWidth: number;
    enabled: boolean;
    /** 裁完回调：给页面累计「省了多少空白」 */
    onCrop?: (saved: number) => void;
}

export function AutoCropImage({ src, maxWidth, enabled, onCrop, ...rest }: Props) {
    const { url, saved, done } = useAutoCrop(src, maxWidth, enabled);

    useEffect(() => {
        if (done) onCrop?.(saved);
        // onCrop 由调用方用 useCallback 固定，避免每帧重跑
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [done, saved]);

    return <img {...rest} src={url || src} data-autocropped={url ? "1" : undefined} />;
}
