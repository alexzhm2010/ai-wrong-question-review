"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <div className="rounded-full bg-destructive/10 p-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
      </div>
      <h1 className="text-2xl font-bold text-foreground">页面出错了</h1>
      <p className="max-w-md break-words text-sm text-muted-foreground">
        {error?.message || "发生了未知错误，请稍后重试。"}
        {error?.digest ? ` (${error.digest})` : ""}
      </p>
      <Button onClick={reset}>重试</Button>
    </main>
  );
}
