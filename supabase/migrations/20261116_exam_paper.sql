-- =====================================================================
-- 扫码批改：试卷主表 / 题目从表 + 免登录 RPC
-- 设计要点：
--  - 凭证 code = 短日期 + 强随机串，不可猜；匿名凭 code 读写，不依赖 auth.uid()
--  - 所有对原表的写入封装在 SECURITY DEFINER 函数里，匿名拿不到原表权限
--  - 重复提交幂等：卷面结果/分数整体覆盖；熟练度按新旧差值修正，不重复累加
-- =====================================================================

-- ---------- 1. 试卷主表 ----------
create table if not exists public."ExamPaper" (
  code            text primary key,
  "userId"        text not null references public."User"(id) on delete cascade,
  "paperNo"       text not null default '',        -- 展示用：日期+时分秒，如 261116183012
  "subjectNames"  text not null default '',        -- 学科摘要
  "itemCount"     int  not null default 0,
  "score"         int,                              -- 提交后分数(0-100)，未提交为 null
  "correctCount"  int,                              -- 提交后答对数
  "submittedAt"   timestamptz,                      -- 最近一次提交时间
  "createdAt"     timestamptz not null default now()
);

-- ---------- 2. 试卷题目从表 ----------
create table if not exists public."ExamPaperItem" (
  "paperCode"     text not null references public."ExamPaper"(code) on delete cascade,
  "errorItemId"   text not null references public."ErrorItem"(id) on delete cascade,
  "orderIndex"    int  not null default 0,          -- 卷面顺序，从 0 开始
  "shortCode"     text not null default '',         -- 卷面题号 #2611110020
  "answerSnapshot" text not null default '',        -- 出卷时的标准答案快照
  "imageUrl"      text not null default '',         -- 题目截图 URL
  "questionText"  text not null default '',         -- 题干文字(无图时兜底)
  verdict         text,                             -- correct | wrong | blank(未做) | null
  "judgedAt"      timestamptz,
  primary key ("paperCode", "errorItemId")
);

create index if not exists exam_paper_item_order_idx
  on public."ExamPaperItem" ("paperCode", "orderIndex");
create index if not exists exam_paper_user_idx
  on public."ExamPaper" ("userId", "createdAt" desc);

-- ---------- RLS：原表保持锁定，匿名无权直接读写 ----------
alter table public."ExamPaper" enable row level security;
alter table public."ExamPaperItem" enable row level security;
-- 不建任何 policy = 除 SECURITY DEFINER 函数外，谁都碰不到（含 anon/authenticated）

-- =====================================================================
-- RPC 1: paper_create —— 登录用户出卷时调用，创建试卷 + 题目快照
-- 入参 items: [{id, orderIndex, shortCode, answerSnapshot, imageUrl, questionText}]
-- 返回: {code, paperNo}
-- =====================================================================
create or replace function public.paper_create(
  p_subject_names text,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid text;
  v_code text;
  v_paper_no text;
  v_item jsonb;
  v_e record;
begin
  -- 出卷必须登录（这是用户主动操作，有登录态）
  v_uid := public.current_app_user_id();
  if v_uid is null then
    raise exception 'NOT_LOGGED_IN';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_ITEMS';
  end if;

  -- 凭证：日期(YYMMDD) + 20 位强随机（去横线、大小写），约 26 字符，不可枚举
  v_paper_no := to_char(now() at time zone 'Asia/Shanghai', 'YYMMDDHH24MISS');
  v_code := to_char(now() at time zone 'Asia/Shanghai', 'YYMMDD')
            || translate(substr(gen_random_uuid()::text || gen_random_uuid()::text, 1, 20), '-', '');

  insert into public."ExamPaper" (code, "userId", "paperNo", "subjectNames", "itemCount", "createdAt")
  values (v_code, v_uid, v_paper_no, coalesce(p_subject_names, ''), jsonb_array_length(p_items), now());

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    -- 只 accept 属于当前用户的题，防止塞别人的题进卷；
    -- 答案/图片/题干一律从 ErrorItem 表取真实值做快照，不信任前端传来的文本。
    select e."shortCode", e."answerText", e."originalImageUrl", e."questionText"
      into v_e
      from public."ErrorItem" e
     where e.id = v_item->>'id' and e."userId" = v_uid;
    if found then
      insert into public."ExamPaperItem"
        ("paperCode", "errorItemId", "orderIndex", "shortCode", "answerSnapshot", "imageUrl", "questionText")
      values
        (v_code, v_item->>'id', coalesce((v_item->>'orderIndex')::int, 0),
         coalesce(v_e."shortCode", ''), coalesce(v_e."answerText", ''),
         coalesce(v_e."originalImageUrl", ''), coalesce(v_e."questionText", ''));
    end if;
  end loop;

  return jsonb_build_object('code', v_code, 'paperNo', v_paper_no);
end;
$function$;

-- =====================================================================
-- RPC 2: paper_read —— 匿名凭 code 读试卷（扫码免登录）
-- 返回主表摘要 + 题目数组；只返回题目/答案，不暴露 userId 等敏感字段
-- =====================================================================
create or replace function public.paper_read(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_paper public."ExamPaper"%rowtype;
  v_items jsonb;
begin
  select * into v_paper from public."ExamPaper" where code = p_code;
  if not found then
    return jsonb_build_object('error', 'PAPER_NOT_FOUND');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'errorItemId', "errorItemId",
    'orderIndex',  "orderIndex",
    'shortCode',   "shortCode",
    'answer',      "answerSnapshot",
    'imageUrl',    "imageUrl",
    'questionText',"questionText",
    'verdict',     verdict
  ) order by "orderIndex"), '[]'::jsonb)
  into v_items
  from public."ExamPaperItem" where "paperCode" = p_code;

  return jsonb_build_object(
    'code',         v_paper.code,
    'paperNo',      v_paper."paperNo",
    'subjectNames', v_paper."subjectNames",
    'itemCount',    v_paper."itemCount",
    'score',        v_paper."score",
    'correctCount', v_paper."correctCount",
    'submittedAt',  v_paper."submittedAt",
    'items',        v_items
  );
end;
$function$;

-- =====================================================================
-- RPC 3: paper_submit —— 匿名凭 code 提交批改（幂等覆盖）
-- 入参 results: [{errorItemId, verdict}]  verdict ∈ correct|wrong|blank
-- 逻辑：
--   1. 校验 code 存在
--   2. 每题：读旧 verdict → 写新 verdict；仅当变化时对 ErrorItem 熟练度做差分修正
--   3. 计算分数（答对数 / 题数 × 100，未做=blank 按错），覆盖主表 score/submittedAt
-- 返回 {ok, score, correctCount, total}
-- =====================================================================
create or replace function public.paper_submit(
  p_code text,
  p_results jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_paper public."ExamPaper"%rowtype;
  v_res jsonb;
  v_old text;
  v_new text;
  v_e record;
  v_correct int := 0;
  v_total int := 0;
  v_cc int;      -- correctCount delta
  v_wc int;      -- wrongCount delta
  v_streak int;
  v_mastery int;
begin
  select * into v_paper from public."ExamPaper" where code = p_code;
  if not found then
    return jsonb_build_object('error', 'PAPER_NOT_FOUND');
  end if;

  for v_res in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
  loop
    v_new := v_res->>'verdict';
    if v_new not in ('correct', 'wrong', 'blank') then
      continue;
    end if;

    select "verdict" into v_old
      from public."ExamPaperItem"
     where "paperCode" = p_code and "errorItemId" = v_res->>'errorItemId';
    if not found then
      continue;
    end if;

    v_total := v_total + 1;
    if v_new = 'correct' then v_correct := v_correct + 1; end if;

    -- 写卷面结果（覆盖）
    update public."ExamPaperItem"
       set verdict = v_new, "judgedAt" = now()
     where "paperCode" = p_code and "errorItemId" = v_res->>'errorItemId';

    -- 熟练度差分：先撤销旧 verdict 的贡献，再加上新 verdict 的贡献
    if v_old is distinct from v_new then
      select * into v_e from public."ErrorItem" where id = v_res->>'errorItemId';
      if found then
        v_cc := coalesce(v_e."correctCount", 0);
        v_wc := coalesce(v_e."wrongCount", 0);

        -- 撤销旧
        if v_old = 'correct' then v_cc := v_cc - 1;
        elsif v_old = 'wrong' or v_old = 'blank' then v_wc := v_wc - 1; end if;
        -- 加新
        if v_new = 'correct' then v_cc := v_cc + 1;
        else v_wc := v_wc + 1; end if;
        v_cc := greatest(v_cc, 0);
        v_wc := greatest(v_wc, 0);

        -- 连对：新判为对才 +1，否则清零（与 recordAttempt 语义一致）
        if v_new = 'correct' then
          v_streak := coalesce(v_e."correctStreak", 0) + 1;
        else
          v_streak := 0;
        end if;
        -- 掌握档位：与 recordAttempt 一致 streak>=3→2, >=2→1, else 0；归档(3)保持
        if coalesce(v_e."masteryLevel", 0) >= 3 and v_new = 'correct' then
          v_mastery := 3;
        elsif v_streak >= 3 then v_mastery := 2;
        elsif v_streak >= 2 then v_mastery := 1;
        else v_mastery := 0;
        end if;

        update public."ErrorItem"
           set "correctCount" = v_cc,
               "wrongCount" = v_wc,
               "correctStreak" = v_streak,
               "masteryLevel" = v_mastery,
               "lastResult" = case when v_new = 'correct' then 'correct' else 'wrong' end,
               "lastAttemptAt" = now(),
               "updatedAt" = now(),
               "mistakeStatus" = case when v_new = 'correct' then "mistakeStatus" else 'wrong_attempt' end
         where id = v_res->>'errorItemId';
      end if;
    end if;
  end loop;

  -- 分数：答对/总提交数，四舍五入；全 blank 则 0
  -- 分母用题数(itemCount)还是提交数？用 itemCount，未提交的也算未答=错
  update public."ExamPaper"
     set "score" = case when v_paper."itemCount" > 0
                        then round(v_correct::numeric / v_paper."itemCount"::numeric * 100)::int
                        else 0 end,
         "correctCount" = v_correct,
         "submittedAt" = now()
   where code = p_code;

  return jsonb_build_object(
    'ok', true,
    'score', case when v_paper."itemCount" > 0
                  then round(v_correct::numeric / v_paper."itemCount"::numeric * 100)::int
                  else 0 end,
    'correctCount', v_correct,
    'total', v_paper."itemCount"
  );
end;
$function$;

-- =====================================================================
-- 授权：anonym 只能调用三个 RPC；原表无任何 policy，匿名无法直接碰
-- =====================================================================
grant execute on function public.paper_create(text, jsonb) to authenticated;
grant execute on function public.paper_read(text) to anon, authenticated;
grant execute on function public.paper_submit(text, jsonb) to anon, authenticated;
