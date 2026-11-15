"use client";

import { Card } from "@/components/ui/card";
import { BookOpen, Pencil, Trash2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NotebookCardProps {
    id: string;
    name: string;
    errorCount: number;
    onClick: () => void;
    onRename?: () => void;
    onDelete?: (id: string) => void;
    itemLabel?: string;
}

/**
 * 紧凑型错题本卡片。
 *
 * 旧版用 CardHeader + CardContent 两段式，再叠加 Card 默认的 py-6 / gap-6，
 * 单张卡片在手机上高约 150px，6 个学科要滚两屏。这里改成单行横排：
 * 图标 + 名称/题数 + 右箭头，整卡约 64px，移动端两列即可一屏看全。
 *
 * 注意：重命名/删除按钮必须绝对定位。它们虽然默认 opacity-0，但若留在文档流中，
 * 仍会占掉约 60px 宽度；手机两列布局下文字区只剩十几像素，学科名会被截成省略号、
 * 题数被挤成竖排单字。
 */
export function NotebookCard({ id, name, errorCount, onClick, onRename, onDelete, itemLabel = "items" }: NotebookCardProps) {
    const hasActions = Boolean(onRename || onDelete);

    return (
        <Card
            className="cursor-pointer hover:border-primary/50 transition-colors relative group py-0 gap-0 overflow-hidden"
            onClick={onClick}
        >
            <div className="flex items-center gap-2 px-3 py-3 sm:gap-2.5 sm:px-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 sm:h-8 sm:w-8">
                    <BookOpen className="h-3.5 w-3.5 text-primary sm:h-4 sm:w-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate whitespace-nowrap text-sm font-semibold leading-tight sm:text-[15px]">
                        {name}
                    </div>
                    <div className="mt-0.5 truncate whitespace-nowrap text-[11px] leading-tight text-muted-foreground sm:text-xs">
                        {errorCount} {itemLabel}
                    </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-opacity group-hover:opacity-0" />
            </div>

            {hasActions && (
                <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-md bg-card/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {onRename && (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-7 w-7"
                            onClick={(e) => {
                                e.stopPropagation();
                                onRename();
                            }}
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </Button>
                    )}
                    {onDelete && (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-7 w-7"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(id);
                            }}
                        >
                            <Trash2 className={`h-3.5 w-3.5 ${errorCount > 0 ? "text-muted-foreground" : "text-destructive"}`} />
                        </Button>
                    )}
                </div>
            )}
        </Card>
    );
}
