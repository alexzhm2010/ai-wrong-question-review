-- =============================================================================
-- 灾备 / 新环境用数据库脚本
--
-- ⚠️ 线上现有 Supabase 项目（sheoajxitvznnjlfyugq）已经建好这些表、RLS 与函数，
--    并且保存着你的错题数据。恢复前端代码时【不要】对现有库执行 CREATE TABLE。
--    只有迁移到全新 Supabase 项目时才执行本文件。
--
-- 设计要点：表名与列名沿用旧版 Prisma schema，使 src/lib/supabase/routes/*
-- 里的 PostgREST 查询（/ErrorItem?select=* 等）无需改动即可复用。
-- 数据安全：所有业务表启用 RLS，按 auth.uid() 映射到 "User".auth_uid 隔离。
-- =============================================================================

create extension if not exists pgcrypto;

-- ------------------------------ 用户表 ------------------------------
create table if not exists public."User" (
  id               text primary key,
  auth_uid         uuid unique references auth.users(id) on delete cascade,
  email            text unique not null,
  username         text,
  password         text not null default '',
  name             text,
  "createdAt"      timestamptz not null default now(),
  "updatedAt"      timestamptz not null default now(),
  "educationStage" text,
  "enrollmentYear" int,
  role             text not null default 'user',
  "isActive"       boolean not null default true
);

-- 用户名：登录用；大小写不敏感唯一
create unique index if not exists user_username_lower_key
  on public."User" (lower(username)) where username is not null;

-- ---------------------------- 学科 / 错题本 ----------------------------
create table if not exists public."Subject" (
  id          text primary key,
  name        text not null,
  "userId"    text not null references public."User"(id) on delete cascade,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique (name, "userId")
);

-- ------------------------------ 知识点标签 ------------------------------
create table if not exists public."KnowledgeTag" (
  id          text primary key,
  name        text not null,
  subject     text not null,
  "parentId"  text references public."KnowledgeTag"(id) on delete set null,
  "order"     int not null default 0,
  code        text,
  "isSystem"  boolean not null default false,
  "userId"    text references public."User"(id) on delete cascade,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- -------------------------------- 错题 --------------------------------
create table if not exists public."ErrorItem" (
  id                 text primary key,
  "userId"           text not null references public."User"(id) on delete cascade,
  "subjectId"        text references public."Subject"(id) on delete cascade,
  "originalImageUrl" text not null default '',
  "ocrText"          text,
  "questionText"     text,
  "answerText"       text,
  analysis           text,
  "wrongAnswerText"  text,
  "mistakeAnalysis"  text,
  "mistakeStatus"    text,
  "knowledgePoints"  text,
  "geogebraCommands" text,
  source             text,
  "errorType"        text,
  "userNotes"        text,
  "masteryLevel"     int not null default 0,
  "gradeSemester"    text,
  "paperLevel"       text,
  "createdAt"        timestamptz not null default now(),
  "updatedAt"        timestamptz not null default now()
);

-- Prisma 隐式多对多表，列名必须为 A / B
create table if not exists public."_ErrorItemToKnowledgeTag" (
  "A" text not null references public."ErrorItem"(id) on delete cascade,
  "B" text not null references public."KnowledgeTag"(id) on delete cascade,
  primary key ("A", "B")
);

create table if not exists public."ReviewSchedule" (
  id            text primary key,
  "errorItemId" text not null references public."ErrorItem"(id) on delete cascade,
  "scheduledFor" timestamptz not null,
  "completedAt" timestamptz,
  "isCorrect"   boolean,
  "createdAt"   timestamptz not null default now()
);

create table if not exists public."PracticeRecord" (
  id          text primary key,
  "userId"    text not null references public."User"(id) on delete cascade,
  subject     text,
  difficulty  text,
  "isCorrect" boolean,
  "createdAt" timestamptz not null default now()
);

create table if not exists public."AppSetting" (
  key        text primary key,
  value      text not null,
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.frontend_logs (
  id           bigint generated always as identity primary key,
  auth_user_id uuid,
  level        text not null default 'info',
  event        text,
  context      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists public.quota_snapshot (
  id                 bigint generated always as identity primary key,
  balance            numeric,
  currency           text default 'CNY',
  free_quota_expired boolean default false,
  captured_at        timestamptz not null default now()
);

-- ------------------------------ RLS ------------------------------
alter table public."User" enable row level security;
alter table public."Subject" enable row level security;
alter table public."KnowledgeTag" enable row level security;
alter table public."ErrorItem" enable row level security;
alter table public."_ErrorItemToKnowledgeTag" enable row level security;
alter table public."ReviewSchedule" enable row level security;
alter table public."PracticeRecord" enable row level security;
alter table public."AppSetting" enable row level security;
alter table public.frontend_logs enable row level security;
alter table public.quota_snapshot enable row level security;

drop policy if exists user_self on public."User";
create policy user_self on public."User" for all
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

-- 系统预设标签（userId 为空）所有登录用户可读
drop policy if exists tag_read on public."KnowledgeTag";
create policy tag_read on public."KnowledgeTag" for select to authenticated
  using ("userId" is null or exists (
    select 1 from public."User" u where u.id = "userId" and u.auth_uid = auth.uid()
  ));
drop policy if exists tag_write on public."KnowledgeTag";
create policy tag_write on public."KnowledgeTag" for all to authenticated
  using (exists (select 1 from public."User" u where u.id = "userId" and u.auth_uid = auth.uid()))
  with check (exists (select 1 from public."User" u where u.id = "userId" and u.auth_uid = auth.uid()));

-- 以下表统一按 owner 隔离
do $$
declare t text;
begin
  foreach t in array array['Subject','ErrorItem','PracticeRecord'] loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format($f$
      create policy owner_all on public.%I for all to authenticated
      using (exists (select 1 from public."User" u where u.id = "userId" and u.auth_uid = auth.uid()))
      with check (exists (select 1 from public."User" u where u.id = "userId" and u.auth_uid = auth.uid()))
    $f$, t);
  end loop;
end $$;

drop policy if exists link_owner on public."_ErrorItemToKnowledgeTag";
create policy link_owner on public."_ErrorItemToKnowledgeTag" for all to authenticated
  using (exists (
    select 1 from public."ErrorItem" e join public."User" u on u.id = e."userId"
    where e.id = "A" and u.auth_uid = auth.uid()
  ))
  with check (exists (
    select 1 from public."ErrorItem" e join public."User" u on u.id = e."userId"
    where e.id = "A" and u.auth_uid = auth.uid()
  ));

drop policy if exists schedule_owner on public."ReviewSchedule";
create policy schedule_owner on public."ReviewSchedule" for all to authenticated
  using (exists (
    select 1 from public."ErrorItem" e join public."User" u on u.id = e."userId"
    where e.id = "errorItemId" and u.auth_uid = auth.uid()
  ))
  with check (exists (
    select 1 from public."ErrorItem" e join public."User" u on u.id = e."userId"
    where e.id = "errorItemId" and u.auth_uid = auth.uid()
  ));

-- 公开配置：匿名可读，仅管理员可写
drop policy if exists setting_public_read on public."AppSetting";
create policy setting_public_read on public."AppSetting" for select
  using (key = 'app_config_public');
drop policy if exists setting_admin_write on public."AppSetting";
create policy setting_admin_write on public."AppSetting" for all to authenticated
  using (exists (select 1 from public."User" u where u.auth_uid = auth.uid() and u.role = 'admin'))
  with check (exists (select 1 from public."User" u where u.auth_uid = auth.uid() and u.role = 'admin'));

drop policy if exists log_insert on public.frontend_logs;
create policy log_insert on public.frontend_logs for insert with check (true);
drop policy if exists quota_read on public.quota_snapshot;
create policy quota_read on public.quota_snapshot for select to authenticated using (true);

-- -------------------- Auth 用户 → 业务 User 同步 --------------------
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public."User" (id, auth_uid, email, username, name, role, "isActive")
  values (
    'c' || replace(gen_random_uuid()::text, '-', ''),
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'displayName', ''),
    'user', true
  ) on conflict (auth_uid) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ------------------------------ RPC ------------------------------
-- 注册：创建 Auth 用户后由上面的 trigger 生成 "User" 行。
-- 现有项目已部署同名函数，这里给出等价实现以便迁移到新项目。
create or replace function public.register_user(
  p_email text, p_password text, p_name text default null, p_username text default null)
returns json language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid; v_id text;
  v_username text := lower(btrim(coalesce(p_username, '')));
begin
  if v_username = '' then v_username := lower(split_part(p_email, '@', 1)); end if;
  if v_username !~ '^[a-z0-9_.-]{2,32}$' then
    return json_build_object('success', false, 'error', '用户名 2-32 位，仅支持字母、数字、下划线、点、横线');
  end if;
  if exists (select 1 from public."User" where lower(username) = v_username) then
    return json_build_object('success', false, 'error', '该用户名已被占用');
  end if;
  if exists (select 1 from auth.users where email = p_email) then
    return json_build_object('success', false, 'error', '该邮箱已注册');
  end if;
  if coalesce(length(p_password), 0) < 6 then
    return json_build_object('success', false, 'error', '密码至少 6 位');
  end if;
  v_uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change,
    email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_uid,
    'authenticated', 'authenticated', p_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('displayName', coalesce(p_name, ''), 'username', v_username),
    now(), now(), '', '', '', ''
  );
  select id into v_id from public."User" where auth_uid = v_uid;
  update public."User" set username = v_username where id = v_id;
  return json_build_object('success', true, 'id', v_id, 'email', p_email, 'username', v_username);
end $$;

create or replace function public.admin_create_user(
  p_email text, p_password text, p_name text default null, p_role text default 'user', p_username text default null)
returns json language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid; v_id text;
  v_username text := lower(btrim(coalesce(p_username, '')));
begin
  if not exists (select 1 from public."User" where auth_uid = auth.uid() and role = 'admin') then
    return json_build_object('success', false, 'error', 'Forbidden');
  end if;
  if v_username = '' then v_username := lower(split_part(p_email, '@', 1)); end if;
  if exists (select 1 from public."User" where lower(username) = v_username) then
    return json_build_object('success', false, 'error', '该用户名已被占用');
  end if;
  v_uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change,
    email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_uid,
    'authenticated', 'authenticated', p_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('displayName', coalesce(p_name, ''), 'username', v_username),
    now(), now(), '', '', '', ''
  );
  update public."User"
     set role = coalesce(p_role, 'user'), username = v_username
   where auth_uid = v_uid;
  select id into v_id from public."User" where auth_uid = v_uid;
  return json_build_object('success', true, 'id', v_id, 'email', p_email,
                           'username', v_username, 'role', coalesce(p_role, 'user'));
end $$;

create or replace function public.admin_delete_user(p_target_user_id text)
returns json language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid;
begin
  if not exists (select 1 from public."User" where auth_uid = auth.uid() and role = 'admin') then
    return json_build_object('success', false, 'error', 'Forbidden');
  end if;
  select auth_uid into v_uid from public."User" where id = p_target_user_id;
  if v_uid is null then return json_build_object('success', false, 'error', '用户不存在'); end if;
  delete from auth.users where id = v_uid;
  return json_build_object('success', true, 'deleted', p_target_user_id);
end $$;

create or replace function public.reset_user_data()
returns json language plpgsql security definer set search_path = public as $$
declare v_id text; n int;
begin
  select id into v_id from public."User" where auth_uid = auth.uid();
  if v_id is null then return json_build_object('success', false, 'error', 'Unauthorized'); end if;
  delete from public."ErrorItem" where "userId" = v_id;
  delete from public."PracticeRecord" where "userId" = v_id;
  get diagnostics n = row_count;
  return json_build_object('success', true, 'cleared', n);
end $$;

-- 登录名 → 邮箱（Supabase Auth 只认邮箱，前端先用它做一次映射）
create or replace function public.login_email(p_identifier text)
returns text language sql security definer set search_path = public as $$
  select u.email from public."User" u
   where u."isActive"
     and (lower(u.username) = lower(btrim(coalesce(p_identifier, '')))
          or lower(u.email) = lower(btrim(coalesce(p_identifier, ''))))
   limit 1;
$$;

grant execute on function public.login_email(text) to anon, authenticated;
grant execute on function public.register_user(text,text,text,text) to anon, authenticated;
grant execute on function public.admin_create_user(text,text,text,text,text) to authenticated;
grant execute on function public.admin_delete_user(text) to authenticated;
grant execute on function public.reset_user_data() to authenticated;

-- ===========================================================================
-- 批量导入（与 migrations/20261111_add_batch_import.sql 保持一致）
-- 任务状态存库，worker 为 Edge Function batch-worker 自链式调用，与浏览器无关。
-- ===========================================================================
create table if not exists public."BatchJob" (
  id             text primary key,
  "userId"       text not null references public."User"(id) on delete cascade,
  status         text not null default 'queued', -- queued|processing|confirming|paused|done|canceled
  "reasoningMode" text not null default 'fast',
  "totalCount"   int  not null default 0,
  "doneCount"    int  not null default 0,
  "failedCount"  int  not null default 0,
  "savedCount"   int  not null default 0,
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
  status          text not null default 'pending', -- pending|processing|done|failed|saved
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
  "autoDeepRetry" boolean not null default false,
  "answerConflict" boolean not null default false,
  "originalAnswerText" text,
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz not null default now()
);

create index if not exists batch_job_user_created_idx on public."BatchJob" ("userId", "createdAt" desc);
create index if not exists batch_job_status_idx on public."BatchJob" (status);
create index if not exists batch_item_job_idx on public."BatchItem" ("jobId", idx);

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
