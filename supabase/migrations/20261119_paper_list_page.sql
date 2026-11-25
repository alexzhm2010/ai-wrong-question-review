-- =====================================================================
-- 练习试卷归档：服务端分页列表
-- 设计要点：
--  - 独立于 paper_list（批改中心仍用全量），只给归档页用，互不干扰
--  - 内部用 current_app_user_id() 强制按当前用户过滤，前端无法越权
--  - 复合排序 createdAt desc, code desc：createdAt 可能相同（同一秒出多卷），
--    加 code 作 tie-breaker 保证跨页顺序稳定，翻页不重复、不遗漏
--  - limit 限制在 1~100，offset >= 0，防止异常参数
--  - 返回 { rows, total }：rows 是当前页，total 是全量条数供前端算页数
-- =====================================================================
create or replace function public.paper_list_page(p_limit int default 20, p_offset int default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid text;
  v_limit int;
  v_offset int;
  v_total int;
  v_rows jsonb;
begin
  v_uid := public.current_app_user_id();
  if v_uid is null then
    raise exception 'NOT_LOGGED_IN';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  select count(*) into v_total
    from public."ExamPaper"
   where "userId" = v_uid;

  select coalesce(jsonb_agg(jsonb_build_object(
    'code',         code,
    'paperNo',      "paperNo",
    'subjectNames', "subjectNames",
    'itemCount',    "itemCount",
    'score',        "score",
    'correctCount', "correctCount",
    'submittedAt',  "submittedAt",
    'createdAt',    "createdAt"
  ) order by "createdAt" desc, code desc), '[]'::jsonb)
  into v_rows
  from (
    select * from public."ExamPaper"
     where "userId" = v_uid
     order by "createdAt" desc, code desc
     limit v_limit offset v_offset
  ) p;

  return jsonb_build_object('rows', v_rows, 'total', v_total);
end;
$function$;

-- 只有登录用户能分页列出自己的试卷；匿名不可调用
revoke all on function public.paper_list_page(int, int) from public, anon;
grant execute on function public.paper_list_page(int, int) to authenticated;
