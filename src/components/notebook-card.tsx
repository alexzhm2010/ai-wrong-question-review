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
 * 图标 + 名称/题数 + 右箭头，整卡约 60px，移动端两列即可一屏看全。
 */
export function NotebookCard({ id, name, errorCount, onClick, onRename, onDelete, itemLabel = "items" }: NotebookCardProps) {
    return (
        <Card
            className="cursor-pointer hover:border-primary/50 transition-colors relative group py-0 gap-0"
            onClick={onClick}
        >
            <div className="flex items-center gap-2.5 px-3.5 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <BookOpen className="h-4 w-4 text-primary" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold leading-tight">{name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                        {errorCount} {itemLabel}
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-opacity group-hover:hidden" />
            </div>
        </Card>
    );
}
