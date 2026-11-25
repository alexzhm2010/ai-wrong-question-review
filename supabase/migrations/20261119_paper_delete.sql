-- =====================================================================
-- 练习试卷归档：批量删除当前用户自己的试卷
-- 设计要点：
--  - ExamPaper 表被 RLS 锁死（无 policy），只能通过 SECURITY DEFINER 函数访问
--  - paper_delete 内部用 current_app_user_id() 强制只删本人试卷，前端无法越权
--  - 入参是 code 数组，一次事务删多份；ExamPaperItem 有 on delete cascade，
--    主表删除后题目快照自动清理，无需单独处理
--  - 返回实际删除份数，便于前端提示
--  - 已批改的试卷（submittedAt 非空）禁止删除：其每题判定明细是熟练度差分计算的
--    依据，删掉会让已累加的掌握度失去来源，因此服务端硬性拦截（前端绕过也无效）
--  - 注意：删除试卷只移除「试卷档案」，不影响题目本身及已累加的熟练度历史
-- =====================================================================
create or replace function public.paper_delete(p_codes jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid text;
  v_deleted int;
begin
  v_uid := public.current_app_user_id();
  if v_uid is null then
    raise exception 'NOT_LOGGED_IN';
  end if;

  if jsonb_typeof(coalesce(p_codes, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_CODES';
  end if;

  -- 关键：where 同时限定 userId = 当前用户，杜绝越权删除他人试卷；
  -- 并限定 submittedAt is null，已批改试卷的明细要留作熟练度计算依据，绝不删除。
  delete from public."ExamPaper"
   where "userId" = v_uid
     and "submittedAt" is null
     and code in (select value from jsonb_array_elements_text(p_codes));

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$function$;

-- 只有登录用户能删除自己的试卷；匿名不可调用
revoke all on function public.paper_delete(jsonb) from public, anon;
grant execute on function public.paper_delete(jsonb) to authenticated;
