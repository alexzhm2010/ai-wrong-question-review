-- =====================================================================
-- 2026-11-28: 错题新增「必备知识点精讲」字段
-- 目的：原 knowledgePoints 只是知识点标题（标签），学生看完仍要自己查资料。
--       新增 knowledgeDetail 存放一段由 AI 生成、可人工编辑的详细讲解，
--       把解答这道题必备的知识点讲透，目标是学生看完就能立即掌握。
-- 说明：
--   * 只加列，不改任何函数；列名 camelCase，与 ErrorItem 其它字段一致。
--   * 旧题保持 NULL（前端据此显示「AI 生成精讲」按钮，按需逐题补全），
--     不做全库回填，避免一次性消耗大量 AI 额度。
-- =====================================================================
begin;

alter table public."ErrorItem"
  add column if not exists "knowledgeDetail" text;

-- 批量导入先落 BatchItem 再由前端确认入库， worker 解析出的精讲也要有地方存，
-- 否则批量 worker 写该列会 400 导致整批失败。
alter table public."BatchItem"
  add column if not exists "knowledgeDetail" text;

commit;
