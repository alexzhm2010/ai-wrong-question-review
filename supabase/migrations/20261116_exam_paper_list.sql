-- =====================================================================
-- 批改中心：列出当前用户生成过的所有试卷
-- 设计要点：
--  - ExamPaper 表被 RLS 锁死（无 policy），匿名/普通角色都拿不到原表，
--    只能通过 SECURITY DEFINER 函数访问；
--  - paper_list 内部用 current_app_user_id() 强制按当前用户过滤，
--    前端无法越权看到别人的试卷；
--  - 只返回列表所需字段，不暴露题目内容/答案（内容仍由 paper_read 凭 code 读）。
-- =====================================================================
create or replace function public.paper_list()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid text;
  v_result jsonb;
begin
  v_uid := public.current_app_user_id();
  if v_uid is null then
    raise exception 'NOT_LOGGED_IN';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'code',         code,
    'paperNo',      "paperNo",
    'subjectNames', "subjectNames",
    'itemCount',    "itemCount",
    'score',        "score",
    'correctCount', "correctCount",
    'submittedAt',  "submittedAt",
    'createdAt',    "createdAt"
  ) order by "createdAt" desc), '[]'::jsonb)
  into v_result
  from public."ExamPaper"
  where "userId" = v_uid;

  return v_result;
end;
$function$;

-- 只有登录用户能列出自己的试卷；匿名不可调用
grant execute on function public.paper_list() to authenticated;
