"use client";

import { useState, useRef } from "react";
import ReactCrop, { Crop, PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";

interface ImageCropperProps {
    imageSrc: string;
    open: boolean;
    onClose: () => void;
    onCropComplete: (croppedImageBlob: Blob) => void;
}

export function ImageCropper({ imageSrc, open, onClose, onCropComplete }: ImageCropperProps) {
    const { t } = useLanguage();
    const [crop, setCrop] = useState<Crop>();
    const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
    const imgRef = useRef<HTMLImageElement>(null);

    /**
     * 默认整张图全选：拍照录入时题目往往横跨整页，
     * 之前默认框在中间（80%×50%）容易把上下题干切掉，用户还没意识到就已经裁掉了。
     * 现在默认铺满，想裁再自己拉。
     */
    function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
        const { width, height } = e.currentTarget;
        selectAll(width, height);
    }

    function selectAll(width: number, height: number) {
        setCrop({ unit: "%", x: 0, y: 0, width: 100, height: 100 });
        // 直接给出像素级选区，保证用户不动框也能确认
        setCompletedCrop({ unit: "px", x: 0, y: 0, width, height });
    }

    const getCroppedImg = async (
        image: HTMLImageElement,
        crop: PixelCrop
    ): Promise<Blob | null> => {
        const canvas = document.createElement("canvas");
        const scaleX = image.naturalWidth / image.width;
        const scaleY = image.naturalHeight / image.height;
        canvas.width = crop.width * scaleX;
        canvas.height = crop.height * scaleY;
        const ctx = canvas.getContext("2d");

        if (!ctx) {
            return null;
        }

        ctx.drawImage(
            image,
            crop.x * scaleX,
            crop.y * scaleY,
            crop.width * scaleX,
            crop.height * scaleY,
            0,
            0,
            crop.width * scaleX,
            crop.height * scaleY
        );

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error("Canvas is empty"));
                    return;
                }
                resolve(blob);
            }, "image/jpeg");
        });
    };

    const handleConfirm = async () => {
        if (completedCrop && imgRef.current) {
            try {
                const croppedBlob = await getCroppedImg(imgRef.current, completedCrop);
                if (croppedBlob) {
                    onCropComplete(croppedBlob);
                }
            } catch (e) {
                console.error(e);
            }
        } else {
            // If no crop, just return original? Or force crop?
            // Let's assume user wants to crop. If they didn't touch it, use current crop state?
            // If crop is undefined, maybe they want whole image?
            // For now, let's require a crop or just use the whole image if nothing selected?
            // Actually, better to just close if they cancel.
            // If they click confirm but no crop is set (unlikely with initial state), do nothing or alert.
            if (!completedCrop && imageSrc) {
                // Fallback: fetch original and return as blob
                try {
                    const res = await fetch(imageSrc);
                    const blob = await res.blob();
                    onCropComplete(blob);
                } catch (e) {
                    console.error(e);
                }
            }
        }
    };

    return (
        <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContent className="left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:rounded-none">
                <DialogHeader className="shrink-0 border-b p-4 pr-12">
                    <DialogTitle>{t.common.cropper?.title || "Crop Image"}</DialogTitle>
                </DialogHeader>

                <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden bg-black p-3 sm:p-4">
                    <ReactCrop
                        crop={crop}
                        onChange={(_, percentCrop) => setCrop(percentCrop)}
                        onComplete={(c) => setCompletedCrop(c)}
                        className="max-h-full max-w-full"
                        style={{ maxHeight: '100%', maxWidth: '100%' }}
                    >
                        <img
                            ref={imgRef}
                            alt="Crop me"
                            src={imageSrc}
                            onLoad={onImageLoad}
                            style={{ maxWidth: '100%', maxHeight: 'calc(100dvh - 9.5rem)', display: 'block' }}
                        />
                    </ReactCrop>
                </div>

                <div className="flex shrink-0 flex-col gap-2 border-t bg-background p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                    <div className="flex items-center gap-3">
                        <p className="text-xs text-muted-foreground sm:text-sm">
                            {t.common.cropper?.hint || "💡 Drag to adjust crop area"}
                        </p>
                        <button
                            type="button"
                            className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
                            onClick={() => {
                                const img = imgRef.current;
                                if (img) selectAll(img.width, img.height);
                            }}
                        >
                            {t.common.cropper?.selectAll || "全选"}
                        </button>
                    </div>
                    <div className="flex w-full gap-2 sm:w-auto">
                        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
                            {t.common.cancel || "Cancel"}
                        </Button>
                        <Button className="flex-1 sm:flex-none" onClick={handleConfirm}>
                            {t.common.confirm || "Confirm"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
