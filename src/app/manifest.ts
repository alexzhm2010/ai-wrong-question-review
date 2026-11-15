import type { MetadataRoute } from 'next'
import { BASE_PATH } from '@/lib/supabase/config'

// output: 'export' 下 metadata route 必须显式声明为静态
export const dynamic = 'force-static'

/** GitHub Pages 部署在子路径下，PWA 的 start_url / scope / 图标都必须带 basePath */
export default function manifest(): MetadataRoute.Manifest {
    return {
        id: `${BASE_PATH}/`,
        name: '智能错题本',
        short_name: '错题本',
        description: 'AI 驱动的智能错题管理系统，帮助学生高效整理、分析和复习错题',
        start_url: `${BASE_PATH}/`,
        scope: `${BASE_PATH}/`,
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        background_color: '#ffffff',
        theme_color: '#f97316',
        orientation: 'portrait',
        icons: [
            // 小尺寸用简化图形（去星光/细节），避免桌面 32px 下糊成一团
            {
                src: `${BASE_PATH}/icons/icon-48.png`,
                sizes: '48x48',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: `${BASE_PATH}/icons/icon-96.png`,
                sizes: '96x96',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: `${BASE_PATH}/icons/icon-192.png`,
                sizes: '192x192',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: `${BASE_PATH}/icons/icon-384.png`,
                sizes: '384x384',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: `${BASE_PATH}/icons/icon-512.png`,
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any',
            },
            // maskable：主体收在中心 80% 安全圆内，供 Android 自适应图标裁成圆形/水滴等形状
            {
                src: `${BASE_PATH}/icons/icon-maskable-192.png`,
                sizes: '192x192',
                type: 'image/png',
                purpose: 'maskable',
            },
            {
                src: `${BASE_PATH}/icons/icon-maskable-512.png`,
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
            },
        ],
    }
}
