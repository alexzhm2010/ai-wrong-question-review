"use client";

import { useEffect, useState } from "react";

/**
 * 静态导出下用查询参数传递详情页 ID（GitHub Pages 无法为未知 ID 预生成文件）。
 * 返回一个形如 `{ id }` 的对象，页面里原有的 params.id 用法无需改动。
 * 首次渲染返回空字符串，挂载后从 URL 读取，避免 SSR/预渲染与浏览器 hydration 不一致。
 */
export function useQueryId(): { id: string } {
  const [id, setId] = useState("");

  useEffect(() => {
    const read = () => setId(new URLSearchParams(window.location.search).get("id") || "");
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  return { id };
}
