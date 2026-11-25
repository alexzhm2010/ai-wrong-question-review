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

    // 卷号给人看用 paperNo（卷号），没有时退回凭证前 12 位
    const displayNo = paperNo || code.slice(0, 12);

    return (
        <div
            className="wq-paper-header relative border-b border-slate-300 pb-2 print:border-b print:border-slate-400 print:pb-2"
        >
            {/*
             * 二维码留在文档流里（flex justify-end）——它比编号区高，由它撑起容器高度，
             * 「扫码批改」文字下方还有 pb-2 内边距，绝不会压到容器底部的分隔线。
             * 之前用 absolute 脱离文档流，容器被编号撑矮，文字就溢出压线了。
             */}
            <div className="flex justify-end">
                <div className="flex flex-col items-center">
                    {svg ? (
                        <div
                            className="[&>svg]:h-[68px] [&>svg]:w-[68px] print:[&>svg]:h-[20mm] print:[&>svg]:w-[20mm]"
                            dangerouslySetInnerHTML={{ __html: svg }}
                        />
                    ) : (
                        <div className="h-[68px] w-[68px] border border-dashed border-slate-300 print:h-[20mm] print:w-[20mm]" />
                    )}
                    <div className="mt-0.5 text-[10px] font-medium text-slate-600 print:text-[8pt]">
                        扫码批改
                    </div>
                </div>
            </div>

            {/* 编号相对整个容器居中（两侧留白避开右侧二维码），高度由二维码块撑起 */}
            <div className="absolute inset-0 flex items-center justify-center px-20 text-center print:px-24">
                <div>
                    <div className="text-[15px] font-bold tracking-wide text-slate-800 print:text-[13pt]">
                        试卷编号
                    </div>
                    <div className="mt-0.5 break-all font-mono text-xl font-bold tracking-wider text-black print:text-[18pt]">
                        {displayNo}
                    </div>
                    <div className="mt-0.5 text-[10px] text-slate-500 print:text-[8pt]">
                        做完扫描右侧二维码即可批改 · 无需登录
                    </div>
                </div>
            </div>
        </div>
    );
}
