/**
 * 静态骨架屏：直接作为页面 loading 分支渲染，因此会被 Next 静态导出写进
 * 预渲染 HTML —— 用户在几十个 JS 分片下载执行期间就能看到页面轮廓和占位，
 * 而不是一片空白加一个居中的「加载中…」。
 */
export function NotebookPageSkeleton() {
    return (
        <main className="min-h-screen p-4 md:p-8 bg-background" aria-busy="true" aria-label="加载中">
            <div className="max-w-6xl mx-auto space-y-8">
                <div className="flex items-start gap-4">
                    <div className="h-9 w-9 shrink-0 rounded-md bg-muted animate-pulse" />
                    <div className="flex-1 space-y-2">
                        <div className="h-8 w-48 rounded bg-muted animate-pulse" />
                        <div className="h-4 w-64 max-w-full rounded bg-muted/70 animate-pulse" />
                    </div>
                    <div className="h-9 w-24 shrink-0 rounded-md bg-muted/60 animate-pulse" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="rounded-lg border p-5 space-y-3">
                            <div className="h-5 w-2/3 rounded bg-muted animate-pulse" />
                            <div className="h-3 w-1/2 rounded bg-muted/60 animate-pulse" />
                            <div className="mt-4 h-8 w-full rounded bg-muted/40 animate-pulse" />
                        </div>
                    ))}
                </div>
            </div>
        </main>
    );
}

/** 错题列表卡片骨架，用于列表首次加载与筛选时保留布局 */
export function ErrorListSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <div className="space-y-3" aria-busy="true" aria-label="加载中">
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="h-4 w-1/3 rounded bg-muted animate-pulse" />
                        <div className="h-5 w-16 rounded-full bg-muted/60 animate-pulse" />
                    </div>
                    <div className="h-3 w-full rounded bg-muted/70 animate-pulse" />
                    <div className="h-3 w-4/5 rounded bg-muted/60 animate-pulse" />
                    <div className="flex gap-2 pt-1">
                        <div className="h-5 w-14 rounded-full bg-muted/50 animate-pulse" />
                        <div className="h-5 w-20 rounded-full bg-muted/50 animate-pulse" />
                    </div>
                </div>
            ))}
        </div>
    );
}
