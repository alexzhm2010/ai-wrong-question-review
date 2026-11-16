"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { BASE_PATH } from "@/lib/supabase/config";

/** 拼扫码批改的完整网址（纯函数，便于测试）。origin 由调用方传入。 */
export function markUrl(origin: string, code: string): string {
    return `${origin}${BASE_PATH}/mark?c=${encodeURIComponent(code)}`;
}

/**
 * 卷首二维码：编码「扫码批改」完整网址，学生扫码即开批改页（免登录）。
 * 用 SVG dataURL，打印放大不糊；生成失败时降级为纯编号文字。
 */
export function PaperQrCode({ code, paperNo }: { code: string; paperNo?: string }) {
    const [svg, setSvg] = useState<string>("");

    useEffect(() => {
        if (!code) return;
        // 用当前站点 origin + basePath 拼绝对地址，扫码设备可直接在浏览器打开
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const url = markUrl(origin, code);
        QRCode.toString(url, {
            type: "svg",
            margin: 1,
            width: 220,
            errorCorrectionLevel: "M",
            color: { dark: "#000000ff", light: "#ffffffff" },
        })
            .then(setSvg)
            .catch(() => setSvg(""));
    }, [code]);

    if (!code) return null;

    return (
        <div className="mb-5 flex items-start justify-end gap-3 print:mb-4">
            <div className="text-right">
                <div className="text-[11px] font-semibold text-slate-700 print:text-[9pt]">
                    扫码批改
                </div>
                <div className="text-[10px] text-slate-500 print:text-[8pt]">
                    做完扫描二维码
                </div>
                <div className="mt-0.5 font-mono text-[10px] tracking-tight text-slate-500 print:text-[8pt]">
                    {paperNo || code.slice(0, 12)}
                </div>
              {svg && (
                <div
                    className="mt-1 [&>svg]:h-[76px] [&>svg]:w-[76px] print:[&>svg]:h-[22mm] print:[&>svg]:w-[22mm]"
                    dangerouslySetInnerHTML={{ __html: svg }}
                />
              )}
            </div>
        </div>
    );
}
