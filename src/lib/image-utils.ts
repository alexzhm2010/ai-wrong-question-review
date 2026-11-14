/**
 * 按「最长边 + 总像素」双限制等比缩放（纯计算，不依赖 DOM）。
 *
 * 只按最长边不够：竖版整页拍题图 2136×3034 的最长边 3034 会被缩到 2400，
 * 但仍有 4.1M 像素；反过来只按宽度判断（旧实现）则 2136 宽根本不触发缩放，
 * 6.5M 像素原样送模型。两个约束同时取最小缩放比才不会漏。
 */
export function fitImageSize(
    srcW: number,
    srcH: number,
    maxEdge: number,
    maxPixels: number,
): { width: number; height: number; scale: number } {
    const w = Math.max(1, Math.round(srcW));
    const h = Math.max(1, Math.round(srcH));
    const edge = Math.max(1, maxEdge);
    const pixels = Math.max(1, maxPixels);
    const scale = Math.min(
        1,
        edge / Math.max(1, Math.max(w, h)),
        Math.sqrt(pixels / Math.max(1, w * h)),
    );
    return {
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale)),
        scale,
    };
}

/**
 * 压缩图片文件
 * @param file 原始图片文件
 * @param maxSizeMB 最大文件大小（MB），默认 1MB
 * @param maxWidth 最长边上限（不是「宽度」），默认 1920px
 * @param quality 压缩质量 0-1，默认 0.8
 * @param maxPixels 总像素上限，默认 400 万（≈ A4 @200dpi 整页）
 * @returns 压缩后的 Base64 字符串
 */
export async function compressImage(
    file: File,
    maxSizeMB: number = 1,
    maxWidth: number = 1920,
    quality: number = 0.8,
    maxPixels: number = 4_000_000
): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                if (!ctx) {
                    reject(new Error('无法获取 Canvas 上下文'));
                    return;
                }

                // 计算新的尺寸（保持宽高比）。
                // 必须同时限制「最长边」和「总像素」：旧版只判断 width > maxWidth，
                // 竖版整页拍题图（如 2136×3034）宽度没超 2400 就完全不缩，
                // 6.5M 像素直接送进模型，单次 AI 请求被拖到超时 → 批量卡在「解析中」。
                // 400 万像素≈A4 @200dpi 整页（1654×2339），正常题图打印清晰度不受影响。
                const srcW = img.naturalWidth || img.width;
                const srcH = img.naturalHeight || img.height;
                const { width, height } = fitImageSize(srcW, srcH, maxWidth, maxPixels);

                canvas.width = width;
                canvas.height = height;

                // 绘制图片
                ctx.drawImage(img, 0, 0, width, height);

                // 转换为 Base64，逐步降低质量直到满足大小要求
                let currentQuality = quality;
                let compressed = canvas.toDataURL('image/jpeg', currentQuality);

                // 检查大小（Base64 字符串长度约等于文件大小的 4/3）
                const sizeInMB = (compressed.length * 3) / 4 / 1024 / 1024;

                // 如果还是太大，继续降低质量
                while (sizeInMB > maxSizeMB && currentQuality > 0.1) {
                    currentQuality -= 0.1;
                    compressed = canvas.toDataURL('image/jpeg', currentQuality);
                    const newSize = (compressed.length * 3) / 4 / 1024 / 1024;

                    console.log(`压缩质量: ${currentQuality.toFixed(1)}, 大小: ${newSize.toFixed(2)}MB`);

                    if (newSize <= maxSizeMB) break;
                }

                console.log(`原始文件: ${(file.size / 1024 / 1024).toFixed(2)}MB, 压缩后: ${((compressed.length * 3) / 4 / 1024 / 1024).toFixed(2)}MB`);

                resolve(compressed);
            };

            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = e.target?.result as string;
        };

        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

/**
 * 批量草稿图的压缩规格（只作用于批量导入，不作用于单题上传）。
 *
 * 隔离跑批结论：同一批 4 张超时图，保持原图 0/4；压到 1600 长边 /
 * 150 万像素 / q82 后 2/4 成功，且成功的两张约 9s 返回。单题仍走默认
 * 2400 / 400 万，保证详情页放大与打印清晰度。
 *
 * 放在这里而不是 batch-draft.ts：批量编辑保存导出的图也要用同一套规格，
 * 而 batch-draft-editor 的单元测试 mock 掉了 batch-draft 模块。
 */
export const DRAFT_IMAGE_LIMITS = {
    maxWidth: 1600,
    maxPixels: 1_500_000,
    quality: 0.82,
} as const;

/**
 * 检查并压缩图片（如果需要）
 * @param file 图片文件
 * @returns Base64 字符串
 */
export async function processImageFile(file: File): Promise<string> {
    const fileSizeMB = file.size / 1024 / 1024;

    console.log(`文件大小: ${fileSizeMB.toFixed(2)}MB`);

    // 最长边 2400px / 质量 0.88 / 上限 2MB：
    // 题图既要给模型看，也要在详情页放大查看和打印导出，1600px 在 A4 上约 135dpi，字会发虚。
    // 2400px 约 200dpi，放大到整屏仍清晰；体积约为原来的 2 倍，批量上传可接受。
    return await compressImage(file, 2, 2400, 0.88);
}

/**
 * 生成确认列表用的缩略图（默认长边 240px）。
 * 列表页一次要渲染 30 张，直接塞 1600px 原图会把内存和滚动都拖垮。
 */
export async function makeThumbnail(base64: string, maxSize: number = 240): Promise<string> {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) return resolve('');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.7).replace(/^data:[^;]+;base64,/, ''));
        };
        img.onerror = () => resolve('');
        img.src = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
    });
}
