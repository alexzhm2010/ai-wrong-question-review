"use client";

/**
 * 摄像头扫码器：打开后置摄像头逐帧识别二维码，识别到试卷凭证后回调。
 * 纯浏览器本地解码（jsqr），图像不出设备、不耗 AI 额度。
 * 识别失败可手动输入卷号/凭证兜底。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { parseScannedCode } from "@/lib/paper-list";
import { Button } from "@/components/ui/button";

type Props = {
    onResult: (code: string) => void;
    onClose: () => void;
};

export function QrScanner({ onResult, onClose }: Props) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rafRef = useRef<number>(0);
    const streamRef = useRef<MediaStream | null>(null);
    const resultRef = useRef(false);
    const [status, setStatus] = useState<"starting" | "scanning" | "error">("starting");
    const [error, setError] = useState("");
    const [manual, setManual] = useState("");

    const stopCamera = useCallback(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        const s = streamRef.current;
        if (s) {
            for (const track of s.getTracks()) track.stop();
            streamRef.current = null;
        }
    }, []);

    const fire = useCallback((code: string) => {
        if (resultRef.current || !code) return;
        resultRef.current = true;
        stopCamera();
        onResult(code);
    }, [onResult, stopCamera]);

    // 逐帧取像 → jsQR 解码
    const tick = useCallback(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w && h) {
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (ctx) {
                    ctx.drawImage(video, 0, 0, w, h);
                    const img = ctx.getImageData(0, 0, w, h);
                    const found = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
                    if (found?.data) {
                        const code = parseScannedCode(found.data);
                        if (code) {
                            fire(code);
                            return;
                        }
                    }
                }
            }
        }
        rafRef.current = requestAnimationFrame(tick);
    }, [fire]);

    useEffect(() => {
        let cancelled = false;
        resultRef.current = false;

        const start = async () => {
            if (!navigator.mediaDevices?.getUserMedia) {
                setStatus("error");
                setError("当前浏览器不支持摄像头扫码，请在下方粘贴二维码链接或试卷编号。");
                return;
            }
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: "environment" } },
                    audio: false,
                });
                if (cancelled) {
                    for (const t of stream.getTracks()) t.stop();
                    return;
                }
                streamRef.current = stream;
                setStatus("scanning");
                const video = videoRef.current;
                if (video) {
                    video.srcObject = stream;
                    await video.play().catch(() => undefined);
                    rafRef.current = requestAnimationFrame(tick);
                }
            } catch {
                if (cancelled) return;
                setStatus("error");
                setError("无法打开摄像头，请检查拍照权限；也可在下方粘贴二维码链接或试卷编号。");
            }
        };
        void start();
        return () => {
            cancelled = true;
            stopCamera();
        };
    }, [stopCamera, tick]);

    const handleClose = () => {
        stopCamera();
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
            <div className="flex items-center justify-between px-4 py-3 text-white">
                <div>
                    <div className="text-sm font-bold">扫码批卷</div>
                    <div className="text-[11px] text-white/60">对准卷首二维码，自动识别并打开试卷</div>
                </div>
                <button
                    type="button"
                    onClick={handleClose}
                    aria-label="关闭扫码"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-xl text-white/80 hover:bg-white/10"
                >
                    ×
                </button>
            </div>

            <div className="relative mx-auto flex w-full max-w-lg flex-1 flex-col items-center justify-center px-4">
                {status !== "error" ? (
                    <>
                        <div className="relative aspect-square w-full max-w-[320px] overflow-hidden rounded-2xl bg-black">
                            <video
                                ref={videoRef}
                                playsInline
                                muted
                                autoPlay
                                className="h-full w-full object-cover"
                            />
                            <canvas ref={canvasRef} className="hidden" />
                            {/* 取景框 */}
                            <div className="pointer-events-none absolute inset-[18%] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
                        </div>
                        <p className="mt-4 text-center text-xs text-white/70">
                            {status === "starting" ? "正在打开摄像头…" : "将二维码放入框内即可自动识别"}
                        </p>
                    </>
                ) : (
                    <div className="w-full max-w-sm rounded-2xl bg-white p-5 text-center">
                        <div className="text-4xl">📷</div>
                        <p className="mt-3 text-sm text-slate-700">{error}</p>
                    </div>
                )}
            </div>

            {/* 手动输入兜底 */}
            <div className="border-t border-white/10 bg-black/40 px-4 py-4">
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        fire(parseScannedCode(manual));
                    }}
                    className="mx-auto flex max-w-lg items-center gap-2"
                >
                    <input
                        value={manual}
                        onChange={(e) => setManual(e.target.value)}
                        placeholder="或粘贴二维码链接 / 试卷编号"
                        className="min-w-0 flex-1 rounded-lg border-0 bg-white/95 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                    />
                    <Button type="submit" disabled={!manual.trim()}>
                        打开
                    </Button>
                </form>
            </div>
        </div>
    );
}
