-- DRAFT MIGRATION ONLY: run manually in the Supabase SQL editor after review.
--
-- Prerequisites:
--   20260818_13_add_project_classification.sql
--   20260818_15_add_custom_small_category_workflow.sql
--
-- This migration is additive. It keeps all imported project columns and all
-- existing RLS policies intact. No historical project value is backfilled or
-- deleted; legacy rows continue to use `alloc` until an editor saves them.

begin;

alter table public.projects
  add column if not exists original_alloc bigint,
  add column if not exists increase_amount bigint not null default 0,
  add column if not exists decrease_amount bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_original_alloc_nonnegative_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_original_alloc_nonnegative_check
      check (original_alloc is null or original_alloc >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_increase_amount_nonnegative_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_increase_amount_nonnegative_check
      check (increase_amount >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_decrease_amount_nonnegative_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_decrease_amount_nonnegative_check
      check (decrease_amount >= 0);
  end if;
end;
$$;

create table if not exists public.project_related_projects (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  project_name varchar(200) not null,
  total_budget bigint not null default 0,
  regional_fund_alloc bigint not null default 0,
  local_fund_alloc bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_related_projects_total_budget_nonnegative_check check (total_budget >= 0),
  constraint project_related_projects_regional_fund_nonnegative_check check (regional_fund_alloc >= 0),
  constraint project_related_projects_local_fund_nonnegative_check check (local_fund_alloc >= 0)
);

create index if not exists idx_project_related_projects_project_id
  on public.project_related_projects(project_id);

alter table public.project_related_projects enable row level security;
grant select on public.project_related_projects to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'project_related_projects'
      and policyname = 'project_related_projects_select_region_or_admin'
  ) then
    create policy project_related_projects_select_region_or_admin
      on public.project_related_projects
      for select to authenticated using (
        exists (
          select 1
          from public.projects as projects
          join public.profiles as profiles on profiles.id = auth.uid()
          where projects.id = project_related_projects.project_id
            and (
              profiles.role = 'admin'
              or profiles.region_id = projects.region_id
            )
        )
      );
  end if;
end;
$$;

create or replace function public.update_my_project_with_audit(
  p_project_id uuid,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_status varchar,
  p_original_alloc bigint,
  p_increase_amount bigint,
  p_decrease_amount bigint,
  p_exec bigint,
  p_related_projects jsonb,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_standard_small_category_ids uuid[],
  p_custom_small_categories jsonb,
  p_business_type varchar,
  p_save_mode varchar default 'SAVE'
)
returns table (
  id uuid,
  project_code text,
  alloc bigint,
  exec bigint,
  rate numeric,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_role text;
  v_user_region_id uuid;
  v_project public.projects%rowtype;
  v_related_item jsonb;
  v_related_name text;
  v_related_total_budget bigint;
  v_related_regional_fund_alloc bigint;
  v_related_local_fund_alloc bigint;
  v_related_count integer := 0;
  v_related_names text[] := array[]::text[];
  v_new_related_projects jsonb := '[]'::jsonb;
  v_old_related_projects jsonb;
  v_adjusted_alloc numeric;
  v_rate numeric;
  v_old_value jsonb;
  v_new_value jsonb;
  v_updated_at timestamptz := clock_timestamp();
  v_save_mode varchar := upper(btrim(coalesce(p_save_mode, 'SAVE')));
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 사업을 저장할 수 있습니다.';
  end if;

  v_user_role := public.current_user_role()::text;
  v_user_region_id := public.current_user_region_id();
  if v_user_role is null or v_user_role not in ('admin', 'local_user') then
    raise exception using errcode = '42501', message = '사업 수정 권한이 없습니다.';
  end if;
  if v_user_role = 'local_user' and v_user_region_id is null then
    raise exception using errcode = '42501', message = '지역 정보가 없는 사용자는 사업을 수정할 수 없습니다.';
  end if;
  if v_save_mode not in ('DRAFT', 'SAVE') then
    raise exception using errcode = '22023', message = '저장 방식이 올바르지 않습니다.';
  end if;

  select projects.*
    into v_project
  from public.projects as projects
  where projects.id = p_project_id
    and projects.project_code is not null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '수정할 사업을 찾을 수 없습니다.';
  end if;
  if v_user_role = 'local_user' and v_project.region_id is distinct from v_user_region_id then
    raise exception using errcode = '42501', message = '본인 지역의 사업만 수정할 수 있습니다.';
  end if;

  if p_detail_project_name is null
     or char_length(btrim(p_detail_project_name)) < 2
     or char_length(btrim(p_detail_project_name)) > 250 then
    raise exception using errcode = '22023', message = '사업명은 2~250자로 입력하세요.';
  end if;
  if p_project_period is null
     or char_length(btrim(p_project_period)) < 2
     or char_length(btrim(p_project_period)) > 120 then
    raise exception using errcode = '22023', message = '사업기간은 2~120자로 입력하세요.';
  end if;
  if p_status not in ('정상추진', '지연', '완료', '추진곤란') then
    raise exception using errcode = '22023', message = '집행상태는 정상추진, 지연, 완료, 추진곤란 중 하나여야 합니다.';
  end if;
  if p_project_start_year is null
     or p_project_start_year < 1900
     or (v_project.year is not null and p_project_start_year > v_project.year) then
    raise exception using errcode = '22023', message = '시작연도는 사업연도 이하의 유효한 연도여야 합니다.';
  end if;

  if p_original_alloc is null
     or p_increase_amount is null
     or p_decrease_amount is null
     or p_exec is null
     or p_original_alloc < 0
     or p_increase_amount < 0
     or p_decrease_amount < 0
     or p_exec < 0 then
    raise exception using errcode = '22023', message = '예산과 집행액은 0 이상의 정수로 입력하세요.';
  end if;

  v_adjusted_alloc := p_original_alloc::numeric + p_increase_amount::numeric - p_decrease_amount::numeric;
  if v_adjusted_alloc < 0 or v_adjusted_alloc > 9223372036854775807::numeric then
    raise exception using errcode = '22003', message = '조정 후 배분액이 유효한 범위를 벗어났습니다.';
  end if;
  if p_exec::numeric > v_adjusted_alloc then
    raise exception using errcode = '23514', message = '집행액은 조정 후 배분액을 초과할 수 없습니다.';
  end if;
  v_rate := case
    when v_adjusted_alloc = 0 then 0
    else round((p_exec::numeric / v_adjusted_alloc) * 100, 2)
  end;

  if p_related_projects is null then
    p_related_projects := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_related_projects) <> 'array' then
    raise exception using errcode = '22023', message = '타 사업 연계 목록 형식이 올바르지 않습니다.';
  end if;

  for v_related_item in select value from jsonb_array_elements(p_related_projects)
  loop
    v_related_count := v_related_count + 1;
    if v_related_count > 50 then
      raise exception using errcode = '22023', message = '타 사업 연계는 최대 50건까지 입력할 수 있습니다.';
    end if;

    v_related_name := btrim(v_related_item ->> 'project_name');
    if v_related_name is null
       or char_length(v_related_name) < 2
       or char_length(v_related_name) > 200
       or lower(v_related_name) = any(v_related_names) then
      raise exception using errcode = '22023', message = '타 사업명은 2~200자로 중복 없이 입력하세요.';
    end if;
    v_related_names := array_append(v_related_names, lower(v_related_name));

    if coalesce(v_related_item ->> 'total_budget', '') !~ '^\d+$'
       or coalesce(v_related_item ->> 'regional_fund_alloc', '') !~ '^\d+$'
       or coalesce(v_related_item ->> 'local_fund_alloc', '') !~ '^\d+$' then
      raise exception using errcode = '22023', message = '타 사업 연계 금액은 0 이상의 정수로 입력하세요.';
    end if;

    v_related_total_budget := (v_related_item ->> 'total_budget')::bigint;
    v_related_regional_fund_alloc := (v_related_item ->> 'regional_fund_alloc')::bigint;
    v_related_local_fund_alloc := (v_related_item ->> 'local_fund_alloc')::bigint;
    v_new_related_projects := v_new_related_projects || jsonb_build_array(jsonb_build_object(
      'project_name', v_related_name,
      'total_budget', v_related_total_budget,
      'regional_fund_alloc', v_related_regional_fund_alloc,
      'local_fund_alloc', v_related_local_fund_alloc
    ));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'project_name', related_projects.project_name,
    'total_budget', related_projects.total_budget,
    'regional_fund_alloc', related_projects.regional_fund_alloc,
    'local_fund_alloc', related_projects.local_fund_alloc
  ) order by related_projects.id), '[]'::jsonb)
    into v_old_related_projects
  from public.project_related_projects as related_projects
  where related_projects.project_id = v_project.id;

  v_old_value := jsonb_build_object(
    'detail_project_name', v_project.detail_project_name,
    'project_period', v_project.project_period,
    'project_start_year', v_project.project_start_year,
    'status', v_project.status,
    'original_alloc', v_project.original_alloc,
    'increase_amount', v_project.increase_amount,
    'decrease_amount', v_project.decrease_amount,
    'alloc', v_project.alloc,
    'exec', v_project.exec,
    'rate', v_project.rate,
    'related_projects', v_old_related_projects
  );

  update public.projects as projects
  set
    detail_project_name = btrim(p_detail_project_name),
    project_period = btrim(p_project_period),
    project_start_year = p_project_start_year,
    status = p_status,
    original_alloc = p_original_alloc,
    increase_amount = p_increase_amount,
    decrease_amount = p_decrease_amount,
    alloc = v_adjusted_alloc::bigint,
    exec = p_exec,
    rate = v_rate,
    updated_at = v_updated_at
  where projects.id = v_project.id
  returning projects.* into v_project;

  delete from public.project_related_projects where project_id = v_project.id;
  insert into public.project_related_projects (
    project_id, project_name, total_budget, regional_fund_alloc, local_fund_alloc, created_at, updated_at
  )
  select
    v_project.id,
    related_projects.project_name,
    related_projects.total_budget,
    related_projects.regional_fund_alloc,
    related_projects.local_fund_alloc,
    v_updated_at,
    v_updated_at
  from jsonb_to_recordset(v_new_related_projects) as related_projects(
    project_name text,
    total_budget bigint,
    regional_fund_alloc bigint,
    local_fund_alloc bigint
  );

  v_new_value := jsonb_build_object(
    'detail_project_name', v_project.detail_project_name,
    'project_period', v_project.project_period,
    'project_start_year', v_project.project_start_year,
    'status', v_project.status,
    'original_alloc', v_project.original_alloc,
    'increase_amount', v_project.increase_amount,
    'decrease_amount', v_project.decrease_amount,
    'alloc', v_project.alloc,
    'exec', v_project.exec,
    'rate', v_project.rate,
    'related_projects', v_new_related_projects
  );

  insert into public.audit_logs (
    project_id, region_id, changed_by, action, field_name,
    old_value, new_value, changed_at, created_at, updated_at
  ) values (
    v_project.id,
    v_project.region_id,
    v_user_id,
    case when v_save_mode = 'DRAFT' then 'SAVE_MY_PROJECT_DRAFT' else 'SAVE_MY_PROJECT' end,
    'my_project_details',
    v_old_value::text,
    v_new_value::text,
    v_updated_at,
    v_updated_at,
    v_updated_at
  );

  -- The existing classification RPC performs its own hierarchy, region, RLS,
  -- and audit validation. Because this call is inside the same function
  -- invocation, an error rolls back basic information, budget, related rows,
  -- and classification together.
  perform 1
  from public.update_project_classification_with_custom_small_categories(
    p_project_id,
    p_large_category_id,
    p_middle_category_id,
    p_standard_small_category_ids,
    p_custom_small_categories,
    p_business_type
  );

  select projects.* into v_project
  from public.projects as projects
  where projects.id = p_project_id;

  return query
  select v_project.id, v_project.project_code::text, v_project.alloc,
    v_project.exec, v_project.rate, v_project.updated_at;
end;
$$;

revoke all on function public.update_my_project_with_audit(
  uuid, text, text, integer, varchar, bigint, bigint, bigint, bigint, jsonb,
  uuid, uuid, uuid[], jsonb, varchar, varchar
) from public;
revoke all on function public.update_my_project_with_audit(
  uuid, text, text, integer, varchar, bigint, bigint, bigint, bigint, jsonb,
  uuid, uuid, uuid[], jsonb, varchar, varchar
) from anon;
grant execute on function public.update_my_project_with_audit(
  uuid, text, text, integer, varchar, bigint, bigint, bigint, bigint, jsonb,
  uuid, uuid, uuid[], jsonb, varchar, varchar
) to authenticated;

notify pgrst, 'reload schema';

commit;
