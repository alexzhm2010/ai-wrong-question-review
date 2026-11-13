"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { autoCrop } from "@/lib/image-autocrop";
import { imageSrc } from "@/lib/storage";

interface ImageReplaceDialogProps {
    open: boolean;
    current?: string | null;
    title?: string;
    /** 确认按钮文案：换图流程里是「继续编辑」 */
    actionLabel?: string;
    /** 传入最终要存的 data URL；抛错则弹窗不关闭，用户可重试 */
    onSave: (dataUrl: string) => Promise<void> | void;
    onClose: () => void;
}

/** 原样读成 data URL：这条链路上不先压缩，交给编辑器统一缩到 2400 再编码 */
function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });
}

/** base64 长度换算成 KB（4 个字符 ≈ 3 字节） */
function kbOf(dataUrl: string): number {
    const body = dataUrl.split(",", 2)[1] || "";
    return Math.round((body.length * 3) / 4 / 1024);
}

/**
 * 替换题目原图：拍照/选图 → 压缩 → 可选自动裁边 → 预览确认 → 回库。
 * 只在浏览器本地处理，图片对象不经过任何第三方。
 */
export function ImageReplaceDialog({ open, current, title, actionLabel, onSave, onClose }: ImageReplaceDialogProps) {
    const camRef = useRef<HTMLInputElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [raw, setRaw] = useState("");
    const [preview, setPreview] = useState("");
    const [autoCropOn, setAutoCropOn] = useState(true);
    const [cropping, setCropping] = useState(false);
    const [reading, setReading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) {
            setRaw("");
            setPreview("");
            setError("");
            setCropping(false);
            setReading(false);
            setSaving(false);
        }
    }, [open]);

    // 压缩后的原图 + 裁边开关 → 预览图
    useEffect(() => {
        if (!raw) return;
        let cancelled = false;
        if (!autoCropOn) {
            setPreview(raw);
            setCropping(false);
            return;
        }
        setCropping(true);
        autoCrop(raw, 1600)
            .then((res) => {
                if (!cancelled) setPreview(res.url);
            })
            .catch(() => {
                if (!cancelled) setPreview(raw);
            })
            .finally(() => {
                if (!cancelled) setCropping(false);
            });
        return () => {
            cancelled = true;
        };
    }, [raw, autoCropOn]);

    const pick = async (file?: File | null) => {
        if (!file) return;
        setError("");
        setReading(true);
        try {
            setRaw(await readAsDataUrl(file));
        } catch (e) {
            setError(e instanceof Error ? e.message : "图片处理失败");
        } finally {
            setReading(false);
        }
    };

    const confirm = async () => {
        if (!preview) return;
        setSaving(true);
        setError("");
        try {
            await onSave(preview);
        } catch (e) {
            setError(e instanceof Error ? e.message : "保存失败，请重试");
        } finally {
            setSaving(false);
        }
    };

    if (!open) return null;

    const size = preview ? kbOf(preview) : 0;

    return (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
            <div
                className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl bg-background p-4 space-y-3 pb-[calc(16px+env(safe-area-inset-bottom))]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <div>
                        <div className="font-semibold">{title || "更换原图"}</div>
                        <div className="text-[11px] text-muted-foreground">重新拍一张，下一步可以裁边、抹掉批改痕迹；题干/答案不动</div>
                    </div>
                    <button onClick={onClose} aria-label="关闭" className="text-muted-foreground p-1">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <input
                    ref={camRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                        void pick(e.target.files?.[0]);
                        e.currentTarget.value = "";
                    }}
                />
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                        void pick(e.target.files?.[0]);
                        e.currentTarget.value = "";
                    }}
                />

                {reading ? (
                    <div className="h-52 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        正在压缩…
                    </div>
                ) : preview ? (
                    <div className="space-y-2">
                        <div className="rounded-lg border bg-white p-2">
                            <img src={preview} alt="新原图预览" className="w-full max-h-[52vh] object-contain mx-auto" />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={autoCropOn}
                                    onChange={(e) => setAutoCropOn(e.target.checked)}
                                    className="rounded border-gray-300 accent-blue-600"
                                />
                                自动裁掉截图状态栏/白边
                                {cropping && <Loader2 className="h-3 w-3 animate-spin" />}
                            </label>
                            <span>{size} KB</span>
                        </div>
                        {size > 1600 && (
                            <p className="text-[11px] text-amber-600">
                                图片偏大（{size} KB），列表加载会变慢；建议把题目区域拍近一点。
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                            <button
                                onClick={() => camRef.current?.click()}
                                className="rounded-lg bg-slate-900 text-white py-6 flex flex-col items-center gap-1.5 text-sm font-semibold"
                            >
                                <Camera className="h-5 w-5" />
                                重拍一张
                            </button>
                            <button
                                onClick={() => fileRef.current?.click()}
                                className="rounded-lg border bg-white py-6 flex flex-col items-center gap-1.5 text-sm"
                            >
                                <ImagePlus className="h-5 w-5" />
                                从相册选择
                            </button>
                        </div>
                        {current && (
                            <div className="rounded-lg border bg-white p-2">
                                <div className="text-[11px] text-muted-foreground mb-1">当前图片</div>
                                <img src={imageSrc(current)} alt="当前原图" className="w-full max-h-[32vh] object-contain mx-auto" />
                            </div>
                        )}
                    </div>
                )}

                {error && <p className="text-xs text-red-600">{error}</p>}

                <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={onClose} disabled={saving}>
                        取消
                    </Button>
                    <Button className="flex-[2]" onClick={confirm} disabled={!preview || saving || cropping || reading}>
                        {saving ? "处理中…" : (actionLabel || "用这张替换")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
