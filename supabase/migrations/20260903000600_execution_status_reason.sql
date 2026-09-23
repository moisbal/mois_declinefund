-- TEST-only common execution-status reason persistence for projects and new-project drafts.
-- Existing reason values are preserved; no business rows, money, or audit history are backfilled.

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
      '확인된 TEST 환경에서만 집행상태 사유 저장 기능을 적용할 수 있습니다.';
  end if;
end;
$$;

create temporary table execution_status_reason_guard on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select count(*) from public.financial_new_project_requests)::bigint as request_count,
  (select count(*) from public.audit_logs)::bigint as audit_count,
  (select coalesce(sum(coalesce(total_budget, 0)), 0) from public.projects)::numeric as total_budget,
  (select coalesce(sum(coalesce(original_alloc, 0)), 0) from public.projects)::numeric as original_alloc,
  (select coalesce(sum(coalesce(increase_amount, 0)), 0) from public.projects)::numeric as increase_amount,
  (select coalesce(sum(coalesce(decrease_amount, 0)), 0) from public.projects)::numeric as decrease_amount,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric as allocation,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric as execution;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'delay_reason'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'execution_status_reason'
  ) then
    raise exception using errcode = '55000', message =
      '지연 사유와 집행상태 사유 컬럼이 중복되어 있어 자동 승격할 수 없습니다.';
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'delay_reason'
  ) then
    alter table public.projects rename column delay_reason to execution_status_reason;
  elsif not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'execution_status_reason'
  ) then
    alter table public.projects add column execution_status_reason text;
  end if;
end;
$$;

alter table public.financial_new_project_requests
  add column if not exists execution_status_reason text;

alter table public.projects
  drop constraint if exists projects_delay_reason_length_check,
  drop constraint if exists projects_execution_status_reason_length_check;
alter table public.projects
  add constraint projects_execution_status_reason_length_check
  check (execution_status_reason is null or char_length(btrim(execution_status_reason)) between 1 and 500)
  not valid;

alter table public.financial_new_project_requests
  drop constraint if exists financial_new_project_requests_execution_status_reason_length_check;
alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_execution_status_reason_length_check
  check (execution_status_reason is null or char_length(btrim(execution_status_reason)) between 1 and 500)
  not valid;

comment on column public.projects.execution_status_reason is
  'Required for 지연 or 추진곤란 on application-managed writes; cleared for 정상추진 or 완료.';
comment on column public.financial_new_project_requests.execution_status_reason is
  'Draft-safe common reason for 지연 or 추진곤란; copied to the materialized project.';

create or replace function public.financial_normalize_execution_status_reason(
  p_status text,
  p_reason text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_status not in ('정상추진', '지연', '완료', '추진곤란') then
    raise exception using errcode = '22023', message = '집행상태 값이 올바르지 않습니다.';
  end if;
  if p_status = '지연' then
    if v_reason = '' then
      raise exception using errcode = '22023', message = '지연 사유를 입력해 주세요.';
    elsif char_length(v_reason) > 500 then
      raise exception using errcode = '22023', message = '지연 사유는 500자 이하로 입력해 주세요.';
    end if;
    return v_reason;
  end if;
  if p_status = '추진곤란' then
    if v_reason = '' then
      raise exception using errcode = '22023', message = '추진곤란 사유를 입력해 주세요.';
    elsif char_length(v_reason) > 500 then
      raise exception using errcode = '22023', message = '추진곤란 사유는 500자 이하로 입력해 주세요.';
    end if;
    return v_reason;
  end if;
  return null;
end;
$$;

create or replace function public.update_my_project_metadata_v4(
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
  p_execution_status_reason text default null
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
  v_old_reason text;
  v_new_reason text;
begin
  v_new_reason := public.financial_normalize_execution_status_reason(
    p_status, p_execution_status_reason
  );

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

  select projects.execution_status_reason into v_old_reason
  from public.projects
  where projects.id = p_project_id
  for update;

  update public.projects
  set execution_status_reason = v_new_reason
  where projects.id = p_project_id;

  if v_old_reason is distinct from v_new_reason then
    insert into public.audit_logs (
      project_id, region_id, action, field_name,
      old_value, new_value, changed_by, changed_at
    )
    select
      projects.id, projects.region_id, 'UPDATE_PROJECT_EXECUTION_STATUS_REASON',
      'execution_status_reason', v_old_reason, v_new_reason, auth.uid(), clock_timestamp()
    from public.projects
    where projects.id = p_project_id;
  end if;

  return query
  select v_saved.id, v_saved.project_code::text, v_saved.alloc,
    v_saved.exec, v_saved.rate, v_saved.updated_at;
end;
$$;

-- Compatibility for the immediately preceding TEST client while the deployment rolls forward.
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
language sql
security definer
set search_path = public, pg_temp
as $$
  select * from public.update_my_project_metadata_v4(
    p_project_id, p_detail_project_name, p_project_period, p_project_start_year,
    p_status, p_related_projects, p_primary_small_category_id,
    p_related_small_category_ids, p_business_type, p_change_basis_code,
    p_other_basis, p_change_reason_codes, p_other_reason, p_change_detail,
    p_similarity_candidate, p_save_mode, p_delay_reason
  );
$$;

create or replace function public.financial_save_new_project_request_draft_v2(
  p_request_id uuid,
  p_region_id uuid,
  p_fiscal_year integer,
  p_project_name text,
  p_fund_project_name text,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_project_end_year integer,
  p_status text,
  p_business_type text,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_source_lot_id uuid,
  p_requested_amount bigint,
  p_idempotency_key uuid,
  p_execution_status_reason text default null
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved record;
  v_reason text;
begin
  v_reason := public.financial_normalize_execution_status_reason(p_status, p_execution_status_reason);
  select saved.* into v_saved
  from public.financial_save_new_project_request_draft(
    p_request_id, p_region_id, p_fiscal_year, p_project_name,
    p_fund_project_name, p_detail_project_name, p_project_period,
    p_project_start_year, p_project_end_year, p_status, p_business_type,
    p_large_category_id, p_middle_category_id, p_source_lot_id,
    p_requested_amount, p_idempotency_key
  ) as saved;
  update public.financial_new_project_requests as requests
  set execution_status_reason = v_reason
  where requests.id = v_saved.request_id;
  return query select v_saved.request_id, v_saved.status;
end;
$$;

create or replace function public.financial_submit_new_project_request_v2(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_reason text;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.id = p_request_id
  for update;
  if not found or v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message =
      '요청자 본인의 독립 신규사업 초안만 제출할 수 있습니다.';
  end if;
  v_reason := public.financial_normalize_execution_status_reason(
    v_request.project_status, v_request.execution_status_reason
  );
  update public.financial_new_project_requests as requests
  set execution_status_reason = v_reason
  where requests.id = v_request.id;
  return query select submitted.request_id, submitted.status
  from public.financial_submit_new_project_request(v_request.id) as submitted;
end;
$$;

create or replace function public.get_financial_attachable_new_project_drafts_v2(
  p_source_project_id uuid
)
returns table (
  id uuid,
  region_id uuid,
  fiscal_year integer,
  project_name text,
  fund_project_name text,
  detail_project_name text,
  project_period text,
  project_start_year integer,
  project_end_year integer,
  project_status text,
  execution_status_reason text,
  business_type text,
  large_category_id uuid,
  middle_category_id uuid,
  requested_amount bigint,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_region_id uuid;
  v_source_year integer;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select projects.region_id, projects.year
    into v_region_id, v_source_year
  from public.projects
  where projects.id = p_source_project_id;
  if not found or (v_role = 'local_user' and v_region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '조회할 수 없는 출처 사업입니다.';
  end if;
  return query
  select requests.id, requests.region_id, requests.fiscal_year,
    requests.project_name, requests.fund_project_name, requests.detail_project_name,
    requests.project_period, requests.project_start_year, requests.project_end_year,
    requests.project_status, requests.execution_status_reason, requests.business_type,
    requests.large_category_id, requests.middle_category_id,
    requests.requested_amount, requests.status, requests.requested_at
  from public.financial_new_project_requests as requests
  where requests.requested_by = v_actor_id
    and requests.region_id = v_region_id
    and requests.fiscal_year = v_source_year + 1
    and requests.status = 'DRAFT'
    and requests.source_lot_id is null
    and requests.source_budget_change_request_id is null
    and requests.source_budget_change_line_id is null
    and requests.materialized_project_id is null
  order by requests.requested_at desc;
end;
$$;

create or replace function public.financial_test_uat_save_budget_change_request_complete_v2(
  p_source_project_id uuid,
  p_source_budget_year_id uuid,
  p_destinations jsonb,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_submit boolean default false
)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_ordinality bigint;
  v_saved record;
  v_new_request_id uuid;
  v_reason text;
begin
  if jsonb_typeof(p_destinations) <> 'array' then
    raise exception using errcode = '22023', message = '예산조정 목적지를 확인해 주세요.';
  end if;
  for v_item in select value from jsonb_array_elements(p_destinations) loop
    if v_item ->> 'destination_type' = 'PENDING_NEW_PROJECT'
       and not coalesce((v_item ->> 'create_unlinked_funding')::boolean, false)
       and coalesce(v_item ->> 'note', '') not like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      perform public.financial_normalize_execution_status_reason(
        v_item ->> 'planned_project_status',
        v_item ->> 'planned_execution_status_reason'
      );
    end if;
  end loop;

  select saved.* into v_saved
  from public.financial_test_uat_save_budget_change_request_complete(
    p_source_project_id, p_source_budget_year_id, p_destinations,
    p_effective_date, p_reason, p_idempotency_key, p_submit
  ) as saved;

  for v_item, v_ordinality in
    select items.value, items.ordinality
    from jsonb_array_elements(p_destinations) with ordinality as items(value, ordinality)
  loop
    if v_item ->> 'destination_type' = 'PENDING_NEW_PROJECT'
       and not coalesce((v_item ->> 'create_unlinked_funding')::boolean, false)
       and coalesce(v_item ->> 'note', '') not like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      v_reason := public.financial_normalize_execution_status_reason(
        v_item ->> 'planned_project_status',
        v_item ->> 'planned_execution_status_reason'
      );
      select lines.new_project_request_id into v_new_request_id
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_saved.request_id and lines.line_no = v_ordinality;
      if v_new_request_id is null then
        raise exception using errcode = '55000', message =
          '신규사업 집행상태 사유를 연결할 요청을 찾지 못했습니다.';
      end if;
      update public.financial_new_project_requests as requests
      set execution_status_reason = v_reason
      where requests.id = v_new_request_id;
    end if;
  end loop;

  return query select v_saved.request_id, v_saved.status, v_saved.gap_amount;
end;
$$;

create or replace function public.financial_copy_new_project_execution_status_reason()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.financial_new_project_requests%rowtype;
begin
  if new.project_code is null then return new; end if;
  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.official_project_code = new.project_code
    and requests.status = 'APPROVED'
  order by requests.approved_at desc nulls last
  limit 1;
  if found then
    new.execution_status_reason := public.financial_normalize_execution_status_reason(
      new.status, v_request.execution_status_reason
    );
  end if;
  return new;
end;
$$;

drop trigger if exists financial_copy_new_project_execution_status_reason_trg on public.projects;
create trigger financial_copy_new_project_execution_status_reason_trg
before insert on public.projects
for each row execute function public.financial_copy_new_project_execution_status_reason();

revoke all on function public.financial_normalize_execution_status_reason(text,text)
  from public, anon, authenticated;
revoke all on function public.financial_copy_new_project_execution_status_reason()
  from public, anon, authenticated;
revoke all on function public.update_my_project_metadata_v4(
  uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text,text
) from public, anon;
grant execute on function public.update_my_project_metadata_v4(
  uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text,text
) to authenticated;
revoke all on function public.financial_save_new_project_request_draft_v2(
  uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,text
) from public, anon;
grant execute on function public.financial_save_new_project_request_draft_v2(
  uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,text
) to authenticated;
revoke all on function public.financial_submit_new_project_request_v2(uuid) from public, anon;
grant execute on function public.financial_submit_new_project_request_v2(uuid) to authenticated;
revoke all on function public.get_financial_attachable_new_project_drafts_v2(uuid) from public, anon;
grant execute on function public.get_financial_attachable_new_project_drafts_v2(uuid) to authenticated;
revoke all on function public.financial_test_uat_save_budget_change_request_complete_v2(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_test_uat_save_budget_change_request_complete_v2(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;

do $$
declare
  v_before execution_status_reason_guard%rowtype;
  v_after execution_status_reason_guard%rowtype;
begin
  select * into v_before from execution_status_reason_guard;
  select
    (select count(*) from public.projects)::bigint,
    (select count(*) from public.financial_new_project_requests)::bigint,
    (select count(*) from public.audit_logs)::bigint,
    (select coalesce(sum(coalesce(total_budget, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(original_alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(increase_amount, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(decrease_amount, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '집행상태 사유 마이그레이션이 기존 사업·요청·금액 또는 감사이력을 변경했습니다.';
  end if;
  if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'projects' and column_name = 'delay_reason'
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'projects' and column_name = 'execution_status_reason'
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'financial_new_project_requests'
        and column_name = 'execution_status_reason'
    )
    or to_regprocedure(
      'public.update_my_project_metadata_v4(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text,text)'
    ) is null
    or to_regprocedure(
      'public.financial_save_new_project_request_draft_v2(uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,text)'
    ) is null
    or to_regprocedure('public.financial_submit_new_project_request_v2(uuid)') is null
    or to_regprocedure('public.get_financial_attachable_new_project_drafts_v2(uuid)') is null
    or to_regprocedure(
      'public.financial_test_uat_save_budget_change_request_complete_v2(uuid,uuid,jsonb,date,text,uuid,boolean)'
    ) is null
    or not exists (
      select 1 from pg_trigger where tgname = 'financial_copy_new_project_execution_status_reason_trg'
        and not tgisinternal
    ) then
    raise exception using errcode = '55000', message = '집행상태 사유 저장 정의 검증에 실패했습니다.';
  end if;
end;
$$;

commit;
