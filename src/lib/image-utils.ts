/**
 * 压缩图片文件
 * @param file 原始图片文件
 * @param maxSizeMB 最大文件大小（MB），默认 1MB
 * @param maxWidth 最大宽度，默认 1920px
 * @param quality 压缩质量 0-1，默认 0.8
 * @returns 压缩后的 Base64 字符串
 */
export async function compressImage(
    file: File,
    maxSizeMB: number = 1,
    maxWidth: number = 1920,
    quality: number = 0.8
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

                // 计算新的尺寸（保持宽高比）
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }

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
 * 检查并压缩图片（如果需要）
 * @param file 图片文件
 * @returns Base64 字符串
 */
export async function processImageFile(file: File): Promise<string> {
    const fileSizeMB = file.size / 1024 / 1024;

    console.log(`文件大小: ${fileSizeMB.toFixed(2)}MB`);

    // 无论原图大小，都统一缩放到最长边 1600px，降低上传体积与视觉 token 数量，
    // 显著缩短 AI 分析耗时（手机直出照片常见 3000-4000px，直接上传会让模型预处理变慢）。
    return await compressImage(file, 1, 1600, 0.8);
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
