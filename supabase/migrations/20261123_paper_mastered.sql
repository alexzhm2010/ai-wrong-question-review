-- =====================================================================
-- 2026-11-23: 批改新增「完全掌握」判定（verdict = mastered）
-- 设计：
--  - 「完全掌握」在卷面 verdict 里是一个独立值 mastered，读卷原样返回，
--    重新打开试卷能正确显示「完全掌握」标签；
--  - 计分上 mastered 视同 correct（答对）；
--  - 熟练度上 mastered 按 correct 做差分，并额外把 masteryLevel=3（归档），
--    correctStreak 至少置 2，确保该题不再进入后续任何今日复习卷；
--  - 与 correct 之间互相切换时计数不重复累加（差分：撤销旧 + 加新）。
-- 本迁移整段覆盖 paper_submit / paper_read 两个函数，其余逻辑与 20261116 保持一致。
-- =====================================================================
begin;

-- ---------- paper_read：verdict 原样返回（mastered 也照常带出，无需改字段） ----------
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

-- ---------- paper_submit：支持 mastered ----------
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
  v_cc int;
  v_wc int;
  v_streak int;
  v_mastery int;
  v_is_correct boolean;
begin
  select * into v_paper from public."ExamPaper" where code = p_code;
  if not found then
    return jsonb_build_object('error', 'PAPER_NOT_FOUND');
  end if;

  for v_res in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
  loop
    v_new := v_res->>'verdict';
    -- 新增 mastered：与 correct/wrong/blank 同为合法判定
    if v_new not in ('correct', 'wrong', 'blank', 'mastered') then
      continue;
    end if;

    select "verdict" into v_old
      from public."ExamPaperItem"
     where "paperCode" = p_code and "errorItemId" = v_res->>'errorItemId';
    if not found then
      continue;
    end if;

    v_total := v_total + 1;
    -- mastered 计分为答对
    v_is_correct := (v_new = 'correct' or v_new = 'mastered');
    if v_is_correct then v_correct := v_correct + 1; end if;

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

        -- 撤销旧（correct 与 mastered 都算「对」的贡献）
        if v_old = 'correct' or v_old = 'mastered' then v_cc := v_cc - 1;
        elsif v_old = 'wrong' or v_old = 'blank' then v_wc := v_wc - 1; end if;
        -- 加新
        if v_is_correct then v_cc := v_cc + 1;
        else v_wc := v_wc + 1; end if;
        v_cc := greatest(v_cc, 0);
        v_wc := greatest(v_wc, 0);

        -- 连对：新判为对（含 mastered）才 +1，否则清零
        if v_is_correct then
          v_streak := coalesce(v_e."correctStreak", 0) + 1;
        else
          v_streak := 0;
        end if;

        -- 掌握档位：
        --  - 新判 mastered → 直接归档 masteryLevel=3（手动确认完全掌握）
        --  - 原本已归档(masteryLevel>=3)且新判为对 → 保持归档
        --  - 其它与 recordAttempt 一致 streak>=3→2, >=2→1, else 0
        if v_new = 'mastered' then
          v_mastery := 3;
          v_streak  := greatest(v_streak, 2); -- 确保 isMastered 成立
        elsif coalesce(v_e."masteryLevel", 0) >= 3 and v_is_correct then
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
               "lastResult" = case when v_new = 'mastered' then 'correct'
                                   when v_is_correct then 'correct' else 'wrong' end,
               "lastAttemptAt" = now(),
               "updatedAt" = now(),
               "mistakeStatus" = case when v_is_correct then "mistakeStatus" else 'wrong_attempt' end
         where id = v_res->>'errorItemId';
      end if;
    end if;
  end loop;

  -- 分数：答对（含 mastered）/ 题数 × 100，四舍五入；未做=blank 按错
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

commit;
