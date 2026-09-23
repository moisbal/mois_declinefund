-- TEST-only additive delta: atomic soft deletion for standalone drafts and transaction-free new projects.
-- The migration preserves financial rows and history. Rolling application code back remains compatible
-- because all added columns are nullable and existing RPC signatures are retained.

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true;

  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      '확인된 TEST DB(reviewtestxxxxxxxxxx)에서만 신규사업 논리 삭제 기능을 적용할 수 있습니다.';
  end if;
end;
$$;

create temporary table new_project_soft_delete_guard on commit drop as
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

alter table public.projects
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete restrict,
  add column if not exists deletion_event_id uuid;

alter table public.financial_new_project_requests
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete restrict,
  add column if not exists deletion_event_id uuid;

create table if not exists public.project_deletion_events (
  id uuid primary key default gen_random_uuid(),
  target_kind text not null check (target_kind in ('DRAFT', 'PROJECT')),
  target_id uuid not null,
  request_id uuid references public.financial_new_project_requests(id) on delete restrict,
  project_id uuid references public.projects(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  project_name text not null check (char_length(btrim(project_name)) between 1 and 500),
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  reason text not null check (char_length(btrim(reason)) between 2 and 500),
  deleted_by uuid not null references public.profiles(id) on delete restrict,
  deleted_at timestamptz not null default clock_timestamp(),
  unique (target_kind, target_id),
  check ((target_kind = 'DRAFT' and request_id = target_id and project_id is null)
    or (target_kind = 'PROJECT' and project_id = target_id and request_id is not null))
);

alter table public.projects
  drop constraint if exists projects_deletion_event_id_fkey;
alter table public.projects
  add constraint projects_deletion_event_id_fkey
  foreign key (deletion_event_id) references public.project_deletion_events(id) on delete restrict;

alter table public.financial_new_project_requests
  drop constraint if exists financial_new_project_requests_deletion_event_id_fkey;
alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_deletion_event_id_fkey
  foreign key (deletion_event_id) references public.project_deletion_events(id) on delete restrict;

create index if not exists projects_active_dashboard_idx
  on public.projects(year, region_id, project_code)
  where deleted_at is null;
create index if not exists financial_new_project_requests_active_region_idx
  on public.financial_new_project_requests(region_id, status, requested_at desc)
  where deleted_at is null;

drop index if exists public.financial_new_project_requests_one_active_source_uidx;
create unique index financial_new_project_requests_one_active_source_uidx
  on public.financial_new_project_requests(source_lot_id)
  where source_lot_id is not null
    and status in ('DRAFT', 'SUBMITTED', 'APPROVED')
    and deleted_at is null;

alter table public.project_deletion_events enable row level security;
drop policy if exists project_deletion_events_select on public.project_deletion_events;
create policy project_deletion_events_select on public.project_deletion_events
for select to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and (profiles.role = 'admin' or profiles.region_id = project_deletion_events.region_id)
  )
);
revoke all on public.project_deletion_events from anon, authenticated;
grant select on public.project_deletion_events to authenticated;

create or replace function public.financial_prevent_project_deletion_event_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = '신규사업 삭제 감사기록은 변경하거나 삭제할 수 없습니다.';
end;
$$;

drop trigger if exists project_deletion_events_immutable on public.project_deletion_events;
create trigger project_deletion_events_immutable
before update or delete on public.project_deletion_events
for each row execute function public.financial_prevent_project_deletion_event_mutation();

create or replace function public.financial_guard_soft_deleted_record()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'financial_new_project_requests'
       or exists (
         select 1 from public.financial_new_project_requests as requests
         where requests.materialized_project_id = old.id
       ) then
      raise exception using errcode = '55000', message =
        '신규사업 원본과 이력은 물리 삭제할 수 없습니다. 검증된 논리 삭제 절차를 이용해 주세요.';
    end if;
    return old;
  end if;

  if old.deleted_at is not null then
    raise exception using errcode = '55000', message = '이미 삭제된 신규사업 또는 초안은 변경할 수 없습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_guard_soft_deleted_record on public.projects;
create trigger projects_guard_soft_deleted_record
before update or delete on public.projects
for each row execute function public.financial_guard_soft_deleted_record();

drop trigger if exists new_project_requests_guard_soft_deleted_record on public.financial_new_project_requests;
create trigger new_project_requests_guard_soft_deleted_record
before update or delete on public.financial_new_project_requests
for each row execute function public.financial_guard_soft_deleted_record();

create or replace function public.financial_guard_deleted_project_reference()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_project_id uuid;
  v_deleted_at timestamptz;
begin
  v_project_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if v_project_id is null then return new; end if;

  select projects.deleted_at into v_deleted_at
  from public.projects
  where projects.id = v_project_id
  for key share;

  if v_deleted_at is not null then
    raise exception using errcode = '23503', message =
      '삭제된 신규사업에는 재원 연결·배분·집행·감액·증액·재배분·이월 또는 재정 요청을 추가할 수 없습니다.';
  end if;
  return new;
end;
$$;

do $$
declare
  v_spec text;
  v_table text;
  v_column text;
  v_trigger text;
begin
  foreach v_spec in array array[
    'project_budget_years:project_id:guard_active_project_budget_year',
    'project_budget_cohorts:origin_project_id:guard_active_project_cohort',
    'project_financial_baselines:project_id:guard_active_project_baseline',
    'financial_budget_change_requests:source_project_id:guard_active_budget_source',
    'financial_budget_change_request_lines:destination_project_id:guard_active_budget_destination',
    'financial_budget_workflow_amount_snapshots:project_id:guard_active_budget_snapshot',
    'financial_pending_new_project_funds:linked_project_id:guard_active_pending_project',
    'financial_pending_new_project_link_requests:destination_project_id:guard_active_pending_destination',
    'financial_project_baseline_attestations:project_id:guard_active_attestation_project',
    'financial_project_decrease_classifications:source_project_id:guard_active_decrease_source',
    'financial_project_decrease_classification_reversals:source_project_id:guard_active_reversal_source',
    'financial_project_lineage_members:project_id:guard_active_lineage_project',
    'financial_unallocated_fund_lots:source_project_id:guard_active_lot_source',
    'financial_unallocated_fund_movements:destination_project_id:guard_active_movement_destination',
    'financial_new_project_requests:materialized_project_id:guard_active_materialized_project',
    'financial_budget_change_destination_corrections:original_destination_project_id:guard_active_original_destination',
    'financial_budget_change_destination_corrections:replacement_destination_project_id:guard_active_replacement_destination',
    'legacy_ledger_reconstruction_entries:project_id:guard_active_legacy_project',
    'legacy_ledger_reconstruction_entries:destination_project_id:guard_active_legacy_destination',
    'financial_test_uat_project_bootstraps:project_id:guard_active_uat_project'
  ] loop
    v_table := split_part(v_spec, ':', 1);
    v_column := split_part(v_spec, ':', 2);
    v_trigger := split_part(v_spec, ':', 3);
    if to_regclass('public.' || v_table) is not null
       and exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = v_table and column_name = v_column
       ) then
      execute format('drop trigger if exists %I on public.%I', v_trigger, v_table);
      execute format(
        'create trigger %I before insert or update of %I on public.%I for each row execute function public.financial_guard_deleted_project_reference(%L)',
        v_trigger, v_column, v_table, v_column
      );
    end if;
  end loop;
end;
$$;

create or replace function public.financial_new_project_deletion_block_reason(p_project_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
begin
  select * into v_project from public.projects where id = p_project_id;
  if not found then return '사업을 찾을 수 없습니다.'; end if;
  if v_project.deleted_at is not null then return '이미 삭제된 신규사업입니다.'; end if;

  if coalesce(v_project.total_budget, 0) <> 0
     or coalesce(v_project.original_alloc, 0) <> 0
     or coalesce(v_project.increase_amount, 0) <> 0
     or coalesce(v_project.decrease_amount, 0) <> 0
     or coalesce(v_project.alloc, 0) <> 0
     or coalesce(v_project.exec, 0) <> 0 then
    return '총사업비·배분액·집행액 또는 증감액이 기록되어 있습니다. 현재 잔액이 0원이더라도 과거 금액 기록이 있으면 삭제할 수 없습니다.';
  end if;

  if exists (select 1 from public.project_budget_years where project_id = p_project_id)
     or exists (select 1 from public.project_budget_cohorts where origin_project_id = p_project_id)
     or exists (select 1 from public.project_financial_baselines where project_id = p_project_id)
     or exists (select 1 from public.financial_project_baseline_attestations where project_id = p_project_id) then
    return '재원 연결·배분 원장 또는 기준금액 이력이 있어 삭제할 수 없습니다.';
  end if;

  if exists (select 1 from public.financial_unallocated_fund_lots where source_project_id = p_project_id)
     or exists (select 1 from public.financial_unallocated_fund_movements where destination_project_id = p_project_id)
     or exists (select 1 from public.legacy_ledger_reconstruction_entries where project_id = p_project_id or destination_project_id = p_project_id) then
    return '감액·증액·재배분·이월을 포함한 원장 거래 이력이 있어 삭제할 수 없습니다.';
  end if;

  if exists (select 1 from public.financial_budget_change_requests where source_project_id = p_project_id)
     or exists (select 1 from public.financial_budget_change_request_lines where destination_project_id = p_project_id)
     or exists (select 1 from public.financial_pending_new_project_funds where linked_project_id = p_project_id)
     or exists (select 1 from public.financial_pending_new_project_link_requests where destination_project_id = p_project_id)
     or exists (select 1 from public.financial_project_decrease_classifications where source_project_id = p_project_id)
     or exists (select 1 from public.financial_project_decrease_classification_reversals where source_project_id = p_project_id) then
    return '처리 중이거나 완료된 예산조정·재원연결·감액 요청 이력이 있어 삭제할 수 없습니다.';
  end if;

  if exists (select 1 from public.financial_budget_workflow_amount_snapshots where project_id = p_project_id)
     or exists (select 1 from public.financial_budget_change_destination_corrections where original_destination_project_id = p_project_id or replacement_destination_project_id = p_project_id)
     or exists (select 1 from public.financial_project_lineage_members where project_id = p_project_id)
     or exists (select 1 from public.financial_test_uat_project_bootstraps where project_id = p_project_id) then
    return '재정 처리 스냅샷·정정·계보 또는 시험 원장 연결 이력이 있어 삭제할 수 없습니다.';
  end if;

  return null;
end;
$$;

create or replace function public.get_financial_new_project_deletion_eligibility(
  p_target_kind text,
  p_target_id uuid
)
returns table (
  target_kind text,
  target_id uuid,
  project_name text,
  fiscal_year integer,
  can_delete boolean,
  reason text,
  project_id uuid,
  request_id uuid,
  impact text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_project public.projects%rowtype;
  v_reason text;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;

  if v_role <> 'local_user' then
    raise exception using errcode = '42501', message = '지자체 편집 권한이 있는 사용자만 신규사업을 삭제할 수 있습니다.';
  end if;
  if upper(btrim(coalesce(p_target_kind, ''))) not in ('DRAFT', 'PROJECT') or p_target_id is null then
    raise exception using errcode = '22023', message = '삭제 대상을 확인해 주세요.';
  end if;

  if upper(btrim(p_target_kind)) = 'DRAFT' then
    select requests.* into v_request
    from public.financial_new_project_requests as requests
    where requests.id = p_target_id;
    if not found or v_request.region_id <> v_actor_region_id then
      raise exception using errcode = '42501', message = '다른 지자체의 신규사업 초안에는 접근할 수 없습니다.';
    end if;
    v_reason := case
      when v_request.deleted_at is not null then '이미 삭제된 신규사업 초안입니다.'
      when v_request.status <> 'DRAFT' then '임시저장 상태의 신규사업 초안만 이 경로에서 삭제할 수 있습니다.'
      when v_request.materialized_project_id is not null or v_request.materialized_movement_id is not null then '이미 사업 또는 원장에 반영된 요청은 초안으로 삭제할 수 없습니다.'
      when v_request.source_budget_change_request_id is not null or v_request.source_budget_change_line_id is not null then '예산조정에서 생성된 초안은 해당 예산조정 화면에서 처리해 주세요.'
      else null end;
    return query select 'DRAFT'::text, v_request.id,
      coalesce(nullif(btrim(v_request.detail_project_name), ''), nullif(btrim(v_request.fund_project_name), ''), v_request.project_name)::text,
      v_request.fiscal_year, v_reason is null, v_reason, null::uuid, v_request.id,
      '초안 건수만 1건 줄어들며 공식 사업 수와 모든 재정 금액은 변하지 않습니다.'::text;
    return;
  end if;

  select projects.* into v_project from public.projects as projects where projects.id = p_target_id;
  if not found or v_project.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '다른 지자체의 사업에는 접근할 수 없습니다.';
  end if;
  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.materialized_project_id = v_project.id
    and requests.status = 'APPLIED'
  order by requests.applied_at desc nulls last, requests.requested_at desc
  limit 1;

  if not found then
    v_reason := '기존 Legacy 사업은 이 기능으로 삭제할 수 없습니다.';
  elsif v_project.deleted_at is not null or v_request.deleted_at is not null then
    v_reason := '이미 삭제된 신규사업입니다.';
  else
    v_reason := public.financial_new_project_deletion_block_reason(v_project.id);
  end if;

  return query select 'PROJECT'::text, v_project.id,
    coalesce(nullif(btrim(v_project.detail_project_name), ''), nullif(btrim(v_project.fund_project_name), ''), v_project.project_name, '사업명 확인 필요')::text,
    v_project.year, v_reason is null, v_reason, v_project.id,
    case when v_request.id is null then null::uuid else v_request.id end,
    '공식 사업 건수만 1건 줄어들며 확인요청·회신·감사 이력은 보존되고 모든 재정 금액은 변하지 않습니다.'::text;
end;
$$;

create or replace function public.soft_delete_financial_new_project(
  p_target_kind text,
  p_target_id uuid,
  p_reason text default '지자체 사용자가 화면에서 삭제'
)
returns table (
  deletion_event_id uuid,
  target_kind text,
  target_id uuid,
  project_name text,
  fiscal_year integer,
  deleted_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_project public.projects%rowtype;
  v_event public.project_deletion_events%rowtype;
  v_reason text;
  v_now timestamptz := clock_timestamp();
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  if v_role <> 'local_user' then
    raise exception using errcode = '42501', message = '지자체 편집 권한이 있는 사용자만 신규사업을 삭제할 수 있습니다.';
  end if;
  if upper(btrim(coalesce(p_target_kind, ''))) not in ('DRAFT', 'PROJECT') or p_target_id is null then
    raise exception using errcode = '22023', message = '삭제 대상을 확인해 주세요.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 2 and 500 then
    raise exception using errcode = '22023', message = '삭제 사유를 확인해 주세요.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('NEW_PROJECT_DELETE:' || p_target_id::text, 0));

  if upper(btrim(p_target_kind)) = 'DRAFT' then
    select requests.* into v_request
    from public.financial_new_project_requests as requests
    where requests.id = p_target_id
    for update;
    if not found or v_request.region_id <> v_actor_region_id then
      raise exception using errcode = '42501', message = '다른 지자체의 신규사업 초안은 삭제할 수 없습니다.';
    end if;
    if v_request.deleted_at is not null then
      raise exception using errcode = '23505', message = '이미 삭제된 신규사업 초안입니다.';
    end if;
    if v_request.status <> 'DRAFT'
       or v_request.materialized_project_id is not null
       or v_request.materialized_movement_id is not null then
      raise exception using errcode = '23514', message = '사업 또는 원장에 반영되지 않은 임시저장 초안만 삭제할 수 있습니다.';
    end if;
    if v_request.source_budget_change_request_id is not null or v_request.source_budget_change_line_id is not null then
      raise exception using errcode = '23514', message = '예산조정에서 생성된 초안은 해당 예산조정 화면에서 처리해 주세요.';
    end if;

    insert into public.project_deletion_events (
      target_kind, target_id, request_id, project_id, region_id,
      project_name, fiscal_year, reason, deleted_by, deleted_at
    ) values (
      'DRAFT', v_request.id, v_request.id, null, v_request.region_id,
      coalesce(nullif(btrim(v_request.detail_project_name), ''), nullif(btrim(v_request.fund_project_name), ''), v_request.project_name),
      v_request.fiscal_year, btrim(p_reason), v_actor_id, v_now
    ) returning * into v_event;

    update public.financial_new_project_requests as requests
    set deleted_at = v_now, deleted_by = v_actor_id, deletion_event_id = v_event.id
    where requests.id = v_request.id;

    return query select v_event.id, 'DRAFT'::text, v_request.id,
      v_event.project_name, v_event.fiscal_year, v_now;
    return;
  end if;

  select projects.* into v_project
  from public.projects as projects
  where projects.id = p_target_id
  for update;
  if not found or v_project.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '다른 지자체의 사업은 삭제할 수 없습니다.';
  end if;
  if v_project.deleted_at is not null then
    raise exception using errcode = '23505', message = '이미 삭제된 신규사업입니다.';
  end if;

  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.materialized_project_id = v_project.id
    and requests.status = 'APPLIED'
  order by requests.applied_at desc nulls last, requests.requested_at desc
  limit 1
  for update;
  if not found then
    raise exception using errcode = '42501', message = '기존 Legacy 사업은 이 기능으로 삭제할 수 없습니다.';
  end if;
  if v_request.deleted_at is not null then
    raise exception using errcode = '23505', message = '이미 삭제된 신규사업입니다.';
  end if;
  v_reason := public.financial_new_project_deletion_block_reason(v_project.id);
  if v_reason is not null then
    raise exception using errcode = '23514', message = v_reason;
  end if;

  insert into public.project_deletion_events (
    target_kind, target_id, request_id, project_id, region_id,
    project_name, fiscal_year, reason, deleted_by, deleted_at
  ) values (
    'PROJECT', v_project.id, v_request.id, v_project.id, v_project.region_id,
    coalesce(nullif(btrim(v_project.detail_project_name), ''), nullif(btrim(v_project.fund_project_name), ''), v_project.project_name, '사업명 확인 필요'),
    v_project.year, btrim(p_reason), v_actor_id, v_now
  ) returning * into v_event;

  update public.projects as projects
  set deleted_at = v_now, deleted_by = v_actor_id, deletion_event_id = v_event.id
  where projects.id = v_project.id;
  update public.financial_new_project_requests as requests
  set deleted_at = v_now, deleted_by = v_actor_id, deletion_event_id = v_event.id
  where requests.id = v_request.id;

  insert into public.audit_logs (
    project_id, region_id, action, field_name, old_value, new_value,
    old_data, new_data, user_id, changed_by, created_at, changed_at, updated_at
  ) values (
    v_project.id, v_project.region_id::text, 'SOFT_DELETE_NEW_PROJECT', 'deleted_at',
    null, v_now::text,
    jsonb_build_object('project_name', v_event.project_name, 'fiscal_year', v_event.fiscal_year, 'deleted', false),
    jsonb_build_object('deletion_event_id', v_event.id, 'reason', btrim(p_reason), 'deleted', true),
    v_actor_id, v_actor_id, v_now, v_now, v_now
  );

  return query select v_event.id, 'PROJECT'::text, v_project.id,
    v_event.project_name, v_event.fiscal_year, v_now;
end;
$$;

revoke all on function public.financial_new_project_deletion_block_reason(uuid) from public, anon, authenticated;
revoke all on function public.get_financial_new_project_deletion_eligibility(text, uuid) from public, anon;
revoke all on function public.soft_delete_financial_new_project(text, uuid, text) from public, anon;
grant execute on function public.get_financial_new_project_deletion_eligibility(text, uuid) to authenticated;
grant execute on function public.soft_delete_financial_new_project(text, uuid, text) to authenticated;

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
for select to authenticated
using (deleted_at is null and (public.current_user_role() = 'admin' or region_id = public.current_user_region_id()));

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
for update to authenticated
using (deleted_at is null and (public.current_user_role() = 'admin' or region_id = public.current_user_region_id()))
with check (deleted_at is null and (public.current_user_role() = 'admin' or region_id = public.current_user_region_id()));

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
for delete to authenticated
using (deleted_at is null and (public.current_user_role() = 'admin' or region_id = public.current_user_region_id()));

drop policy if exists financial_new_project_requests_select_region_or_admin on public.financial_new_project_requests;
create policy financial_new_project_requests_select_region_or_admin on public.financial_new_project_requests
for select to authenticated
using (
  deleted_at is null and exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and (profiles.role = 'admin' or profiles.region_id = financial_new_project_requests.region_id)
  )
);

create or replace function public.get_financial_new_project_requests(p_status text default null)
returns setof public.financial_new_project_requests
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query select requests.* from public.financial_new_project_requests as requests
  where requests.deleted_at is null
    and (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_status is null or requests.status = p_status)
  order by requests.requested_at desc;
end;
$$;

create or replace function public.get_financial_project_funding_positions(p_project_id uuid default null)
returns table (
  project_id uuid, region_id uuid, fiscal_year integer,
  ledger_original_allocation bigint, ledger_adjusted_allocation bigint,
  ledger_increase_amount bigint, ledger_decrease_amount bigint,
  ledger_execution_amount bigint, ledger_execution_rate numeric,
  current_wallet_balance bigint, unclassified_decrease_amount bigint,
  projection_ready boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query select positions.project_id, positions.region_id, positions.fiscal_year,
    positions.ledger_original_allocation, positions.ledger_adjusted_allocation,
    positions.ledger_increase_amount, positions.ledger_decrease_amount,
    positions.ledger_execution_amount, positions.ledger_execution_rate,
    positions.current_wallet_balance, positions.unclassified_decrease_amount,
    positions.projection_ready
  from public.financial_project_funding_positions as positions
  join public.projects as projects on projects.id = positions.project_id and projects.deleted_at is null
  where (v_role = 'admin' or positions.region_id = v_actor_region_id)
    and (p_project_id is null or positions.project_id = p_project_id)
  order by positions.fiscal_year desc, positions.project_id;
end;
$$;

create or replace function public.get_dashboard_filter_options()
returns jsonb
language sql
stable
set search_path = public
as $$
  with visible_projects as (
    select year, nullif(btrim(sido), '') as sido, nullif(btrim(sigungu), '') as sigungu,
      nullif(btrim(region_type), '') as region_type, nullif(btrim(category), '') as category
    from public.projects
    where project_code is not null and deleted_at is null
  ), year_counts as (
    select coalesce(jsonb_object_agg(year::text, project_count), '{}'::jsonb) as value
    from (select year, count(*)::integer project_count from visible_projects where year is not null group by year order by year) grouped_years
  ), sido_values as (
    select coalesce(jsonb_agg(sido order by sido), '[]'::jsonb) as value
    from (select distinct sido from visible_projects where sido is not null) distinct_sidos
  ), sigungu_values as (
    select coalesce(jsonb_object_agg(sido, sigungus), '{}'::jsonb) as value
    from (select sido, jsonb_agg(sigungu order by sigungu) sigungus
      from (select distinct sido, sigungu from visible_projects where sido is not null and sigungu is not null) distinct_sigungus
      group by sido) grouped_sigungus
  ), region_type_values as (
    select coalesce(jsonb_agg(region_type order by region_type), '[]'::jsonb) as value
    from (select distinct region_type from visible_projects where region_type is not null) distinct_region_types
  ), category_values as (
    select coalesce(jsonb_agg(category order by category), '[]'::jsonb) as value
    from (select distinct category from visible_projects where category is not null) distinct_categories
  )
  select jsonb_build_object('year_counts', year_counts.value, 'sidos', sido_values.value,
    'sigungus_by_sido', sigungu_values.value, 'region_types', region_type_values.value,
    'categories', category_values.value)
  from year_counts, sido_values, sigungu_values, region_type_values, category_values;
$$;

create or replace function public.get_financial_post_check_requests(p_status text default null)
returns table (
  id uuid, subject_type text, subject_id uuid, project_id uuid, project_name text,
  region_id uuid, region_name text, fiscal_year integer, amount bigint, status text,
  message text, due_date date, parent_request_id uuid, requested_by uuid,
  requested_at timestamptz, replied_by uuid, replied_at timestamptz,
  reply_message text, completed_by uuid, completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_role text; v_actor_region_id uuid;
begin
  select actor.actor_role, actor.actor_region_id into v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  return query
  select checks.id, checks.subject_type, checks.subject_id, checks.project_id,
    case when projects.deleted_at is not null then '[삭제된 사업] ' else '' end
      || coalesce(projects.project_name, '사업명 확인 필요'),
    checks.region_id, regions.display_name::text,
    case when checks.subject_type = 'BUDGET_CHANGE' then budget_requests.fiscal_year else projects.year end,
    case when checks.subject_type = 'FUNDING_LINK' then links.amount
      when checks.subject_type = 'BUDGET_CHANGE' then budget_requests.total_amount
      else projects.total_budget::bigint end,
    checks.status, checks.message, checks.due_date, checks.parent_request_id,
    checks.requested_by, checks.requested_at, checks.replied_by, checks.replied_at,
    checks.reply_message, checks.completed_by, checks.completed_at
  from public.financial_post_check_requests as checks
  left join public.projects on projects.id = checks.project_id
  left join public.regions on regions.id = checks.region_id
  left join public.financial_pending_new_project_link_requests as links
    on checks.subject_type = 'FUNDING_LINK' and links.id = checks.subject_id
  left join public.financial_budget_change_requests as budget_requests
    on checks.subject_type = 'BUDGET_CHANGE' and budget_requests.id = checks.subject_id
  where (p_status is null or checks.status = upper(btrim(p_status)))
    and (v_role = 'admin' or checks.region_id = v_actor_region_id)
  order by checks.requested_at desc;
end;
$$;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.financial_save_new_project_request_draft(uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid)'::regprocedure)
    into v_definition;
  v_definition := regexp_replace(v_definition,
    'where requests\.id = p_request_id\s+for update;',
    'where requests.id = p_request_id and requests.deleted_at is null for update;', 'g');
  v_definition := regexp_replace(v_definition,
    'where requests\.idempotency_key = p_idempotency_key\s+for update;',
    'where requests.idempotency_key = p_idempotency_key and requests.deleted_at is null for update;', 'g');
  v_definition := replace(v_definition,
    'and other.status in (''DRAFT'', ''SUBMITTED'', ''APPROVED'', ''APPLIED'')',
    'and other.deleted_at is null and other.status in (''DRAFT'', ''SUBMITTED'', ''APPROVED'', ''APPLIED'')');
  execute v_definition;

  select pg_get_functiondef('public.financial_submit_new_project_request(uuid)'::regprocedure)
    into v_definition;
  v_definition := regexp_replace(v_definition,
    'where requests\.id = p_request_id\s+for update;',
    'where requests.id = p_request_id and requests.deleted_at is null for update;', 'g');
  execute v_definition;
end;
$$;

do $$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)'::regprocedure) into v_definition;
  v_definition := replace(v_definition, 'from public.projects where id = p_anchor_project_id;',
    'from public.projects where id = p_anchor_project_id and deleted_at is null;');
  v_definition := replace(v_definition, 'where projects.region_id = v_anchor_region',
    'where projects.deleted_at is null and projects.region_id = v_anchor_region');
  execute v_definition;

  select pg_get_functiondef('public.get_financial_budget_change_next_year_candidates(uuid,text)'::regprocedure) into v_definition;
  v_definition := replace(v_definition, 'from public.projects where id = p_anchor_project_id;',
    'from public.projects where id = p_anchor_project_id and deleted_at is null;');
  v_definition := replace(v_definition, 'where projects.region_id = v_anchor_region',
    'where projects.deleted_at is null and projects.region_id = v_anchor_region');
  execute v_definition;

  select pg_get_functiondef('public.get_transfer_destination_projects(uuid)'::regprocedure) into v_definition;
  v_definition := replace(v_definition,
    'join public.projects as projects on projects.id = budget_years.project_id',
    'join public.projects as projects on projects.id = budget_years.project_id and projects.deleted_at is null');
  v_definition := replace(v_definition, 'where projects.project_code is not null',
    'where projects.deleted_at is null and projects.project_code is not null');
  execute v_definition;

  select pg_get_functiondef('public.get_financial_carryover_destinations(uuid)'::regprocedure) into v_definition;
  v_definition := replace(v_definition,
    'join public.projects on projects.id = wallets.project_id',
    'join public.projects on projects.id = wallets.project_id and projects.deleted_at is null');
  v_definition := replace(v_definition,
    'join public.projects on projects.id = destination_members.project_id',
    'join public.projects on projects.id = destination_members.project_id and projects.deleted_at is null');
  execute v_definition;
end;
$$;

grant execute on function public.get_financial_new_project_requests(text) to authenticated;
grant execute on function public.get_financial_project_funding_positions(uuid) to authenticated;
grant execute on function public.get_dashboard_filter_options() to authenticated;
grant execute on function public.get_financial_post_check_requests(text) to authenticated;

do $$
declare
  v_before new_project_soft_delete_guard%rowtype;
  v_after new_project_soft_delete_guard%rowtype;
begin
  select * into v_before from new_project_soft_delete_guard;
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
      '신규사업 논리 삭제 마이그레이션이 기존 사업·요청·금액 또는 감사이력을 변경했습니다.';
  end if;
  if exists (select 1 from public.projects where deleted_at is not null or deleted_by is not null or deletion_event_id is not null)
     or exists (select 1 from public.financial_new_project_requests where deleted_at is not null or deleted_by is not null or deletion_event_id is not null)
     or exists (select 1 from public.project_deletion_events) then
    raise exception using errcode = '55000', message = '마이그레이션 중 기존 데이터를 삭제 상태로 변경하지 않았는지 확인해 주세요.';
  end if;
  if pg_get_functiondef('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)'::regprocedure) not like '%projects.deleted_at is null%'
     or pg_get_functiondef('public.get_financial_budget_change_next_year_candidates(uuid,text)'::regprocedure) not like '%projects.deleted_at is null%'
     or pg_get_functiondef('public.get_transfer_destination_projects(uuid)'::regprocedure) not like '%projects.deleted_at is null%'
     or pg_get_functiondef('public.get_financial_carryover_destinations(uuid)'::regprocedure) not like '%projects.deleted_at is null%'
     or pg_get_functiondef('public.financial_save_new_project_request_draft(uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid)'::regprocedure) not like '%requests.deleted_at is null%'
     or pg_get_functiondef('public.financial_submit_new_project_request(uuid)'::regprocedure) not like '%requests.deleted_at is null%' then
    raise exception using errcode = '55000', message = '삭제된 사업·초안 제외 경로가 모두 적용되지 않았습니다.';
  end if;
end;
$$;
