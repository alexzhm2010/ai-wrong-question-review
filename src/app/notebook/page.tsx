"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryId } from "@/lib/use-query-id";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { Plus, House, Pencil } from "lucide-react";
import Link from "next/link";
import { ErrorList } from "@/components/error-list";
import { RenameNotebookDialog } from "@/components/rename-notebook-dialog";

import { Notebook } from "@/types/api";
import { apiClient } from "@/lib/api-client";
import { toast } from "@/lib/toast";

import { useLanguage } from "@/contexts/LanguageContext";

/**
 * 错题本元信息（名称、题数）的内存缓存。
 * 从详情页返回时列表页会重新挂载，没有缓存就要再等一次「加载中」，
 * 整页闪一下白——那正是用户说的「像刷新了一遍」。
 */
const notebookMem = new Map<string, Notebook>();

// ... imports

export default function NotebookDetailPage() {
    const params = useQueryId();
    const router = useRouter();
    const { t } = useLanguage();
    const [notebook, setNotebook] = useState<Notebook | null>(null);
    const [loading, setLoading] = useState(true);
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);

    useEffect(() => {
        if (!params.id) return;
        const hit = notebookMem.get(params.id);
        if (hit) {
            setNotebook(hit);
            setLoading(false);
        }
        fetchNotebook(params.id as string);
    }, [params.id]);

    const fetchNotebook = async (id: string) => {
        try {
            const data = await apiClient.get<Notebook>(`/api/notebooks/${id}`);
            notebookMem.set(id, data);
            setNotebook(data);
        } catch (error) {
            console.error("Failed to fetch notebook:", error);
            toast.info(t.notebooks?.notFound || "Notebook not found");
            router.push("/notebooks");
        } finally {
            setLoading(false);
        }
    };

    const handleRename = async (name: string) => {
        if (!notebook) return;
        const updated = await apiClient.put<Notebook>(`/api/notebooks/${notebook.id}`, { name });
        notebookMem.set(updated.id, updated);
        setNotebook(updated);
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <p className="text-muted-foreground">{t.common.loading}</p>
            </div>
        );
    }

    if (!notebook) return null;

    return (
        <main className="min-h-screen p-4 md:p-8 bg-background">
            <div className="max-w-6xl mx-auto space-y-6 md:space-y-8">
                <div className="flex items-start gap-4">
                    <BackButton fallbackUrl="/notebooks" className="shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight truncate">{notebook.name}</h1>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setRenameDialogOpen(true)}
                                title={t.notebooks?.rename || "Rename"}
                            >
                                <Pencil className="h-4 w-4" />
                            </Button>
                        </div>
                        <p className="text-muted-foreground text-sm sm:text-base">
                            {(t.notebooks?.totalErrors || "Total {count} errors").replace("{count}", (notebook._count?.errorItems || 0).toString())}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Link href={`/notebook/add?id=${notebook.id}`}>
                            <Button size="sm" className="hidden sm:flex">
                                <Plus className="mr-2 h-4 w-4" />
                                {t.notebooks?.addError || "Add Error"}
                            </Button>
                            <Button size="icon" className="sm:hidden">
                                <Plus className="h-4 w-4" />
                            </Button>
                        </Link>
                        <Link href="/">
                            <Button variant="ghost" size="icon">
                                <House className="h-5 w-5" />
                            </Button>
                        </Link>
                    </div>
                </div>

                <ErrorList subjectId={notebook.id} subjectName={notebook.name} />

                <RenameNotebookDialog
                    open={renameDialogOpen}
                    onOpenChange={setRenameDialogOpen}
                    currentName={notebook.name}
                    onRename={handleRename}
                />
            </div>
        </main>
    );
}
