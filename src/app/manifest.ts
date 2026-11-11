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
            {
                src: `${BASE_PATH}/icons/icon-192.png`,
                sizes: '192x192',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: `${BASE_PATH}/icons/icon-512.png`,
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any',
            },
        ],
    }
}
