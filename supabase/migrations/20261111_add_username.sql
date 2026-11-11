-- ============================================================================
-- 2026-11-11: 新增 username 字段，登录改用用户名，email 仅用于通知
-- ============================================================================
begin;

-- 1) 字段
alter table public."User" add column if not exists username text;

-- 2) 回填：取邮箱 @ 前缀（admin@localhost -> admin）
update public."User"
   set username = lower(split_part(email, '@', 1))
 where coalesce(btrim(username), '') = '';

-- 2.1) 兜底：回填后仍重名的，追加序号
with dup as (
  select id, username,
         row_number() over (partition by lower(username) order by "createdAt") as rn
    from public."User"
   where username is not null
)
update public."User" u
   set username = d.username || d.rn
  from dup d
 where u.id = d.id and d.rn > 1 and d.rn <= 99;

-- 3) 大小写不敏感唯一
create unique index if not exists user_username_lower_key
  on public."User" (lower(username))
  where username is not null;

-- 4) 登录名 -> 邮箱（未登录可调用，只返回激活账号的邮箱）
create or replace function public.login_email(p_identifier text)
returns text
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select u.email
    from public."User" u
   where u."isActive"
     and (lower(u.username) = lower(btrim(coalesce(p_identifier, '')))
          or lower(u.email) = lower(btrim(coalesce(p_identifier, ''))))
   limit 1;
$$;

grant execute on function public.login_email(text) to anon, authenticated;

-- 5) 建号函数：支持 username
drop function if exists public._create_auth_and_app_user(text, text, text, text);

create or replace function public._create_auth_and_app_user(
  p_email text, p_password text, p_name text, p_role text, p_username text default null
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp', 'auth', 'extensions'
as $function$
declare
  v_email text := lower(trim(p_email));
  v_auth_id uuid := gen_random_uuid();
  v_app_id text;
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_suffix int := 0;
  v_candidate text;
begin
  if v_username = '' then
    v_username := lower(split_part(v_email, '@', 1));
  end if;

  -- 唯一化兜底（正常路径已在调用方校验并报错）
  v_candidate := v_username;
  while exists (select 1 from public."User" where lower(username) = v_candidate) loop
    v_suffix := v_suffix + 1;
    v_candidate := v_username || v_suffix::text;
    if v_suffix > 99 then
      raise exception '用户名已被占用';
    end if;
  end loop;
  v_username := v_candidate;

  insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
     confirmation_token, recovery_token, email_change_token_new,
     email_change, is_super_admin, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000'::uuid, v_auth_id, 'authenticated', 'authenticated',
     v_email, crypt(p_password, gen_salt('bf')),
     now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     jsonb_build_object('displayName', coalesce(p_name, ''), 'username', v_username),
     '', '', '', '', false, now(), now());

  insert into auth.identities
    (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values
    (v_auth_id::text, v_auth_id,
     jsonb_build_object('sub', v_auth_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
     'email', now(), now());

  insert into public."User"
    (id, email, password, name, username, "createdAt", "updatedAt", role, "isActive", "auth_user_id")
  values
    (gen_random_uuid()::text, v_email, '',
     coalesce(nullif(trim(p_name), ''), v_username),
     v_username, now()::timestamp(3), now()::timestamp(3),
     coalesce(nullif(trim(p_role), ''), 'user'), true, v_auth_id)
  returning id into v_app_id;

  return v_app_id;
end;
$function$;

-- 6) 自助注册：新增 p_username
drop function if exists public.register_user(text, text, text);

create or replace function public.register_user(
  p_email text, p_password text, p_name text default null, p_username text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp', 'auth', 'extensions'
as $function$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_app_id text;
  v_cfg jsonb;
begin
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return jsonb_build_object('success', false, 'error', '邮箱格式不合法');
  end if;
  if length(coalesce(p_password, '')) < 6 then
    return jsonb_build_object('success', false, 'error', '密码至少 6 位');
  end if;
  if v_username = '' then
    v_username := lower(split_part(v_email, '@', 1));
  end if;
  if v_username !~ '^[a-z0-9_.-]{2,32}$' then
    return jsonb_build_object('success', false, 'error', '用户名 2-32 位，仅支持字母、数字、下划线、点、横线');
  end if;
  if exists (select 1 from public."User" where lower(username) = v_username) then
    return jsonb_build_object('success', false, 'error', '该用户名已被占用');
  end if;

  begin
    select value::jsonb into v_cfg
      from public."AppSetting" where key = 'app_config_public' limit 1;
  exception when others then
    v_cfg := null;
  end;
  if v_cfg is not null and (v_cfg ->> 'allowRegistration') = 'false' then
    return jsonb_build_object('success', false, 'error', '当前已关闭自助注册');
  end if;

  if exists (select 1 from public."User" where lower(email) = v_email)
     or exists (select 1 from auth.users where lower(email) = v_email) then
    return jsonb_build_object('success', false, 'error', '该邮箱已注册');
  end if;

  v_app_id := public._create_auth_and_app_user(v_email, p_password, p_name, 'user', v_username);
  return jsonb_build_object('success', true, 'id', v_app_id, 'email', v_email, 'username', v_username);
end;
$function$;

-- 7) 管理员建号：新增 p_username
drop function if exists public.admin_create_user(text, text, text, text);

create or replace function public.admin_create_user(
  p_email text, p_password text, p_name text default null, p_role text default 'user', p_username text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp', 'auth', 'extensions'
as $function$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_app_id text;
begin
  if not public.is_admin() then
    return jsonb_build_object('success', false, 'error', '需要管理员权限');
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return jsonb_build_object('success', false, 'error', '邮箱格式不合法');
  end if;
  if length(coalesce(p_password, '')) < 6 then
    return jsonb_build_object('success', false, 'error', '密码至少 6 位');
  end if;
  if v_username = '' then
    v_username := lower(split_part(v_email, '@', 1));
  end if;
  if v_username !~ '^[a-z0-9_.-]{2,32}$' then
    return jsonb_build_object('success', false, 'error', '用户名 2-32 位，仅支持字母、数字、下划线、点、横线');
  end if;
  if exists (select 1 from public."User" where lower(username) = v_username) then
    return jsonb_build_object('success', false, 'error', '该用户名已被占用');
  end if;
  if exists (select 1 from public."User" where lower(email) = v_email)
     or exists (select 1 from auth.users where lower(email) = v_email) then
    return jsonb_build_object('success', false, 'error', '该邮箱已注册');
  end if;

  v_app_id := public._create_auth_and_app_user(v_email, p_password, p_name, p_role, v_username);
  return jsonb_build_object('success', true, 'id', v_app_id, 'email', v_email, 'username', v_username, 'role', p_role);
end;
$function$;

-- 8) 自动建号（首次 OAuth/邮箱登录）：补 username
create or replace function public.ensure_app_user()
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid;
  v_email text;
  v_id text;
  v_claim jsonb;
  v_username text;
  v_suffix int := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'ensure_app_user: 必须先登录';
  end if;

  select u.id into v_id from public."User" u where u."auth_user_id" = v_uid;
  if v_id is not null then
    return v_id;
  end if;

  begin
    v_claim := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    v_claim := null;
  end;
  v_email := coalesce(nullif(v_claim ->> 'email', ''), v_uid::text || '@auth.local');

  if exists (select 1 from public."User" u where u.email = v_email) then
    v_email := v_uid::text || '@auth.local';
  end if;

  v_username := lower(split_part(v_email, '@', 1));
  while exists (select 1 from public."User" where lower(username) = v_username) loop
    v_suffix := v_suffix + 1;
    v_username := lower(split_part(v_email, '@', 1)) || v_suffix::text;
  end loop;

  insert into public."User"
    (id, email, password, name, username, "createdAt", "updatedAt", role, "isActive", "auth_user_id")
  values
    (gen_random_uuid()::text, v_email, '', null, v_username,
     now()::timestamp(3), now()::timestamp(3), 'user', true, v_uid)
  on conflict ("auth_user_id") do nothing;

  select u.id into v_id from public."User" u where u."auth_user_id" = v_uid;
  return v_id;
end;
$function$;

-- 9) 普通用户不得自行改用户名
create or replace function public.protect_user_privileges()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if public.is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role
     or new."isActive" is distinct from old."isActive"
     or new."auth_user_id" is distinct from old."auth_user_id"
     or new.email is distinct from old.email
     or new.username is distinct from old.username then
    raise exception
      'protect_user_privileges: 普通用户不得修改 role / isActive / auth_user_id / email / username';
  end if;
  return new;
end;
$function$;

commit;
