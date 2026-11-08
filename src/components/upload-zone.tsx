"use client";

import { useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { Card, CardContent } from "@/components/ui/card";
import { UploadCloud, Loader2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

interface UploadZoneProps {
    onImageSelect: (file: File) => void;  // 改为传递 File 对象
    isAnalyzing: boolean;
    /** 是否撑满父容器剩余高度（首页整屏布局使用） */
    fill?: boolean;
}

export function UploadZone({ onImageSelect, isAnalyzing, fill = false }: UploadZoneProps) {
    const { t } = useLanguage();
    useEffect(() => {
        // 请求通知权限
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }, []);

    const onDrop = useCallback(
        (acceptedFiles: File[]) => {
            const file = acceptedFiles[0];
            if (file) {
                // 直接传递 File 对象，让父组件处理压缩
                onImageSelect(file);
            }
        },
        [onImageSelect]
    );

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: {
            "image/*": [".jpeg", ".jpg", ".png"],
        },
        maxFiles: 1,
        disabled: isAnalyzing,
    });

    return (
        <div className={fill ? "flex h-full min-h-0 flex-col" : "space-y-4"}>
            <Card
                {...getRootProps()}
                className={`border-2 border-dashed cursor-pointer transition-colors hover:border-primary/50 ${fill ? "flex h-full min-h-0 flex-1 flex-col overflow-hidden" : ""} ${isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25"
                    }`}
            >
                <CardContent className={`flex flex-1 flex-col items-center justify-center text-center ${fill ? "min-h-0 gap-2 py-4 sm:gap-3 sm:py-8" : "min-h-[300px] space-y-4 py-12"}`}>
                    <input {...getInputProps()} />
                    <div className={`rounded-full bg-muted ${fill ? "p-2.5 sm:p-4" : "p-4"}`}>
                        {isAnalyzing ? (
                            <Loader2 className={`text-primary animate-spin ${fill ? "h-8 w-8 sm:h-10 sm:w-10" : "h-10 w-10"}`} />
                        ) : (
                            <UploadCloud className={`text-muted-foreground ${fill ? "h-8 w-8 sm:h-10 sm:w-10" : "h-10 w-10"}`} />
                        )}
                    </div>
                    <div className="space-y-1">
                        <h3 className="text-base font-semibold sm:text-lg">
                            {isAnalyzing ? t.app.analyzing : t.upload.analyze}
                        </h3>
                        <p className="text-xs text-muted-foreground sm:text-sm">
                            {isAnalyzing ? t.app.analyzing : t.app.dragDrop}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground sm:mt-2">
                            {t.upload.support}
                        </p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
