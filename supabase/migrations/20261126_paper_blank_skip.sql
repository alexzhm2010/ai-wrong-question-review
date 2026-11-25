-- =====================================================================
-- 2026-11-26: 批改「未做」(verdict=blank) 语义修正
-- 问题：旧逻辑把 blank 当成 wrong —— wrongCount+1、连对清零、lastResult='wrong'，
--       于是「没做的题」被推进 7~14 天错题冷却，恰恰和最该优先补做的直觉相反；
--       而且和错题详情页的「未做」(recordAttempt 的 skip：只留痕不计对错) 语义打架。
-- 修正：blank 等同 skip ——
--   * 不计入 wrongCount / correctCount；
--   * 不打断 correctStreak（保持原值）；
--   * 不改变 masteryLevel（不归档、不降级）；
--   * 不改 mistakeStatus；
--   * lastResult 写 'skip'，lastAttemptAt 刷新为 now()（表示这次接触过，pending 解除）；
--   * 计分仍按「答对数 / 题数」，blank 不得分（得分率不因未做而虚高）。
-- 差分兼容：新规则下 blank 从不加减 wrongCount，因此撤销旧 blank 时也不再减 wrong，
--   避免「先标未做、再改成其它」时误扣历史计数。旧版已提交的卷子不可重批，不再差分。
-- 本迁移只覆盖 paper_submit；paper_read 原样返回 verdict，无需改动。
-- =====================================================================
begin;

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
  v_is_skip boolean;
begin
  select * into v_paper from public."ExamPaper" where code = p_code;
  if not found then
    return jsonb_build_object('error', 'PAPER_NOT_FOUND');
  end if;

  for v_res in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
  loop
    v_new := v_res->>'verdict';
    -- correct / wrong / blank(未做→skip) / mastered 都是合法判定
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
    v_is_correct := (v_new = 'correct' or v_new = 'mastered');
    v_is_skip := (v_new = 'blank');
    -- 计分：只有答对（含完全掌握）计分；未做 blank 不得分
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

        -- 撤销旧：correct 与 mastered 算「对」；只有 wrong 算「错」。
        -- blank（未做）在新规则下从未加减过 wrongCount，撤销时也不减，避免误扣。
        if v_old = 'correct' or v_old = 'mastered' then v_cc := v_cc - 1;
        elsif v_old = 'wrong' then v_wc := v_wc - 1; end if;

        -- 加新：答对加 correct；只有「错」加 wrong；blank 不加任何计数。
        if v_is_correct then v_cc := v_cc + 1;
        elsif v_new = 'wrong' then v_wc := v_wc + 1; end if;
        v_cc := greatest(v_cc, 0);
        v_wc := greatest(v_wc, 0);

        -- 连对：答对 +1；判错清零；未做 blank 保持原值（不打断连对）
        if v_is_correct then
          v_streak := coalesce(v_e."correctStreak", 0) + 1;
        elsif v_new = 'wrong' then
          v_streak := 0;
        else
          v_streak := coalesce(v_e."correctStreak", 0);
        end if;

        -- 掌握档位：
        --  - mastered → 归档 masteryLevel=3，streak 至少 2；
        --  - blank（未做）→ 保持原 masteryLevel，不归档也不降级；
        --  - 原已归档且新判为对 → 保持归档；
        --  - 其它与 recordAttempt 一致 streak>=3→2, >=2→1, else 0。
        if v_new = 'mastered' then
          v_mastery := 3;
          v_streak  := greatest(v_streak, 2);
        elsif v_is_skip then
          v_mastery := coalesce(v_e."masteryLevel", 0);
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
                                   when v_is_correct then 'correct'
                                   when v_is_skip then 'skip'
                                   else 'wrong' end,
               "lastAttemptAt" = now(),
               "updatedAt" = now(),
               "mistakeStatus" = case when v_is_correct or v_is_skip
                                      then "mistakeStatus" else 'wrong_attempt' end
         where id = v_res->>'errorItemId';
      end if;
    end if;
  end loop;

  -- 分数：答对（含 mastered）/ 题数 × 100，四舍五入；未做 blank 按不得分
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
