-- 批量导入：批次（BatchJob）+ 批次条目（BatchItem）
--
-- 设计要点：
-- 1. 任务归属数据库，不归属浏览器。前端只是「看板」，关页/换设备/重登录都不影响执行。
-- 2. 图片以 base64 存库（前端已压到长边 1600px / q0.8，单张约 120–300KB），
--    另存一份 240px 缩略图用于确认列表，避免列表页拉全量原图。
-- 3. worker 为 Edge Function 自链式调用，每轮只处理 1 张（深度模式单张约 70–80s，
--    必须留出 150s 函数上限的余量），处理完写库并刷新 heartbeatAt 后再触发下一轮。

create table if not exists public."BatchJob" (
  id             text primary key,
  "userId"       text not null references public."User"(id) on delete cascade,
  -- queued | processing | confirming | paused | done | canceled
  status         text not null default 'queued',
  -- 批次级思考模式：fast（默认，失败自动降级深度重试）| deep
  "reasoningMode" text not null default 'fast',
  "totalCount"   int  not null default 0,
  "doneCount"    int  not null default 0,
  "failedCount"  int  not null default 0,
  "savedCount"   int  not null default 0,
  -- worker 每轮结束时刷新；前端超过 200s 未见更新即提示「可能已中断」
  "heartbeatAt"  timestamptz,
  "startedAt"    timestamptz,
  "finishedAt"   timestamptz,
  "errorMessage" text,
  "createdAt"    timestamptz not null default now(),
  "updatedAt"    timestamptz not null default now()
);

create table if not exists public."BatchItem" (
  id              text primary key,
  "jobId"         text not null references public."BatchJob"(id) on delete cascade,
  "userId"        text not null references public."User"(id) on delete cascade,
  idx             int  not null default 0,
  -- pending | processing | done | failed | saved
  status          text not null default 'pending',
  "imageBase64"   text not null default '',
  "thumbBase64"   text,
  "questionText"  text,
  "answerText"    text,
  analysis        text,
  "subjectId"     text,
  "subjectName"   text,
  "gradeSemester" text,
  "knowledgePoints" text,
  "errorItemId"   text,
  "failureReason" text,
  attempts        int  not null default 0,
  -- 快速模式缺标签后自动用深度重跑过（费用与时长会上浮，列表里明确标注）
  "autoDeepRetry" boolean not null default false,
  -- 解析正文结论与提交答案不一致：批量不做在线验算，落库后在确认列表标黄提醒人工核对
  "answerConflict" boolean not null default false,
  "originalAnswerText" text,
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz not null default now()
);

create index if not exists batch_job_user_created_idx
  on public."BatchJob" ("userId", "createdAt" desc);
create index if not exists batch_job_status_idx
  on public."BatchJob" (status);
create index if not exists batch_item_job_idx
  on public."BatchItem" ("jobId", idx);

alter table public."BatchJob" enable row level security;
alter table public."BatchItem" enable row level security;

drop policy if exists batch_job_owner on public."BatchJob";
create policy batch_job_owner on public."BatchJob" for all to authenticated
  using ("userId" = current_app_user_id() or is_admin())
  with check ("userId" = current_app_user_id() or is_admin());

drop policy if exists batch_item_owner on public."BatchItem";
create policy batch_item_owner on public."BatchItem" for all to authenticated
  using ("userId" = current_app_user_id() or is_admin())
  with check ("userId" = current_app_user_id() or is_admin());
