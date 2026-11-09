"use client";

import { useState } from "react";
import { Box, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface GeogebraEntryProps {
    onGenerate: () => void;
    isAnalyzing: boolean;
    error?: string | null;
    description?: string;
}

const DEFAULT_DESCRIPTION = "AI 将判断本题是否可以用 GeoGebra 进行动态演示，如适合则自动生成可拖拽的交互图形";

/**
 * GeoGebra 动态演示的折叠入口。
 *
 * 旧版是一整块带说明文字和按钮的虚线卡片，每次题目识别完都占据一块版面；
 * 这里收敛成一行小入口，默认折叠，展开后才出现「生成演示」按钮。
 * 生成成功后由调用方直接渲染 <GeogebraDemo>，本组件不再出现。
 */
export function GeogebraEntry({
    onGenerate,
    isAnalyzing,
    error,
    description = DEFAULT_DESCRIPTION,
}: GeogebraEntryProps) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className="rounded-lg border border-dashed">
            <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50"
            >
                <Box className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">GeoGebra 动态演示（可选）</span>
                {isAnalyzing && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
                <span className="shrink-0">{expanded ? "收起" : "展开"}</span>
                {expanded
                    ? <ChevronUp className="h-3.5 w-3.5 shrink-0" />
                    : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
            </button>

            {expanded && (
                <div className="border-t px-3 pb-3 pt-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={onGenerate}
                            disabled={isAnalyzing}
                        >
                            {isAnalyzing ? (
                                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />AI 分析中...</>
                            ) : (
                                <><Box className="mr-2 h-4 w-4" />生成演示</>
                            )}
                        </Button>
                    </div>
                    {error && <p className="mt-2 text-xs text-muted-foreground">{error}</p>}
                </div>
            )}
        </div>
    );
}
