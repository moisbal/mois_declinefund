-- TEST-only project delay-reason persistence. Monetary and Ledger values are unchanged.

begin;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      '확인된 TEST 환경에서만 지연 사유 저장 기능을 적용할 수 있습니다.';
  end if;
end;
$$;

create temporary table project_delay_reason_guard on commit drop as
select
  count(*)::bigint as project_count,
  count(*) filter (where status = '지연')::bigint as delayed_count,
  coalesce(sum(coalesce(total_budget, 0)), 0)::numeric as total_budget,
  coalesce(sum(coalesce(original_alloc, 0)), 0)::numeric as original_alloc,
  coalesce(sum(coalesce(increase_amount, 0)), 0)::numeric as increase_amount,
  coalesce(sum(coalesce(decrease_amount, 0)), 0)::numeric as decrease_amount,
  coalesce(sum(coalesce(alloc, 0)), 0)::numeric as allocation,
  coalesce(sum(coalesce(exec, 0)), 0)::numeric as execution
from public.projects;

alter table public.projects
  add column if not exists delay_reason text;

comment on column public.projects.delay_reason is
  'Required by application and RPC validation when project status is 지연; cleared for other statuses.';

alter table public.projects
  drop constraint if exists projects_delay_reason_length_check;
alter table public.projects
  add constraint projects_delay_reason_length_check
  check (delay_reason is null or char_length(btrim(delay_reason)) between 2 and 500)
  not valid;

create or replace function public.update_my_project_metadata_v3(
  p_project_id uuid,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_status text,
  p_related_projects jsonb,
  p_primary_small_category_id uuid,
  p_related_small_category_ids uuid[],
  p_business_type text,
  p_change_basis_code text default null,
  p_other_basis text default null,
  p_change_reason_codes text[] default null,
  p_other_reason text default null,
  p_change_detail text default null,
  p_similarity_candidate boolean default false,
  p_save_mode text default 'SAVE',
  p_delay_reason text default null
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
set search_path = public, pg_temp
as $$
declare
  v_saved record;
  v_old_delay_reason text;
  v_new_delay_reason text;
begin
  select * into v_saved
  from public.update_my_project_metadata_v2(
    p_project_id => p_project_id,
    p_detail_project_name => p_detail_project_name,
    p_project_period => p_project_period,
    p_project_start_year => p_project_start_year,
    p_status => p_status,
    p_related_projects => p_related_projects,
    p_primary_small_category_id => p_primary_small_category_id,
    p_related_small_category_ids => p_related_small_category_ids,
    p_business_type => p_business_type,
    p_change_basis_code => p_change_basis_code,
    p_other_basis => p_other_basis,
    p_change_reason_codes => p_change_reason_codes,
    p_other_reason => p_other_reason,
    p_change_detail => p_change_detail,
    p_similarity_candidate => p_similarity_candidate,
    p_save_mode => p_save_mode
  );

  if p_status = '지연' then
    if char_length(btrim(coalesce(p_delay_reason, ''))) not between 2 and 500 then
      raise exception using errcode = '22023', message = '지연 사유는 2~500자로 입력하세요.';
    end if;
    v_new_delay_reason := btrim(p_delay_reason);
  else
    v_new_delay_reason := null;
  end if;

  select projects.delay_reason into v_old_delay_reason
  from public.projects
  where projects.id = p_project_id
  for update;

  update public.projects
  set delay_reason = v_new_delay_reason
  where projects.id = p_project_id;

  if v_old_delay_reason is distinct from v_new_delay_reason then
    insert into public.audit_logs (
      project_id, region_id, action, field_name,
      old_value, new_value, changed_by, changed_at
    )
    select
      projects.id, projects.region_id, 'UPDATE_PROJECT_DELAY_REASON', 'delay_reason',
      v_old_delay_reason, v_new_delay_reason, auth.uid(), clock_timestamp()
    from public.projects
    where projects.id = p_project_id;
  end if;

  return query
  select v_saved.id, v_saved.project_code::text, v_saved.alloc,
    v_saved.exec, v_saved.rate, v_saved.updated_at;
end;
$$;

revoke all on function public.update_my_project_metadata_v3(
  uuid, text, text, integer, text, jsonb, uuid, uuid[], text,
  text, text, text[], text, text, boolean, text, text
) from public, anon;
grant execute on function public.update_my_project_metadata_v3(
  uuid, text, text, integer, text, jsonb, uuid, uuid[], text,
  text, text, text[], text, text, boolean, text, text
) to authenticated;

do $$
declare
  v_before project_delay_reason_guard%rowtype;
  v_after project_delay_reason_guard%rowtype;
begin
  select * into v_before from project_delay_reason_guard;
  select
    count(*)::bigint,
    count(*) filter (where status = '지연')::bigint,
    coalesce(sum(coalesce(total_budget, 0)), 0)::numeric,
    coalesce(sum(coalesce(original_alloc, 0)), 0)::numeric,
    coalesce(sum(coalesce(increase_amount, 0)), 0)::numeric,
    coalesce(sum(coalesce(decrease_amount, 0)), 0)::numeric,
    coalesce(sum(coalesce(alloc, 0)), 0)::numeric,
    coalesce(sum(coalesce(exec, 0)), 0)::numeric
  into v_after
  from public.projects;

  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '지연 사유 마이그레이션이 기존 사업 또는 금액 자료를 변경했습니다.';
  end if;
  if to_regprocedure(
    'public.update_my_project_metadata_v3(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text,text)'
  ) is null then
    raise exception using errcode = '55000', message = '지연 사유 저장 함수 생성 검증에 실패했습니다.';
  end if;
end;
$$;

commit;
