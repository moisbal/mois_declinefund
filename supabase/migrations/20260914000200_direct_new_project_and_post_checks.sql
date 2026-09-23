begin;

-- New-project registration and funding links are completed by the requester.
-- Historic approval/rejection columns remain untouched for legacy rows.
do $$
begin
  if to_regclass('public.financial_new_project_requests') is null
     or to_regclass('public.financial_pending_new_project_link_requests') is null
     or to_regclass('public.financial_budget_change_requests') is null
     or to_regprocedure('public.financial_apply_new_project_request(uuid)') is null
     or to_regprocedure('public.financial_apply_pending_new_project_link(uuid)') is null then
    raise exception using errcode = '55000', message =
      '직접 처리 전환에 필요한 재정 원장 스키마가 없습니다.';
  end if;
end;
$$;

create temp table direct_workflow_install_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric as transfer_amount,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric as movement_amount;

create table public.financial_direct_workflow_settings (
  singleton boolean primary key default true check (singleton),
  direct_processing_enabled boolean not null default true,
  post_check_enabled boolean not null default true,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.financial_direct_workflow_settings(singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.financial_new_project_requests
  add column processing_mode text not null default 'LEGACY_APPROVAL'
    check (processing_mode in ('LEGACY_APPROVAL', 'DIRECT'));

alter table public.financial_pending_new_project_link_requests
  add column processing_mode text not null default 'LEGACY_APPROVAL'
    check (processing_mode in ('LEGACY_APPROVAL', 'DIRECT'));

alter table public.financial_new_project_requests
  drop constraint if exists financial_new_project_requests_state_shape;
alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_state_shape check (
    (status = 'DRAFT' and official_project_code is null and submitted_by is null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and official_project_code is null
      and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and official_project_code is not null
      and approved_by is not null and approved_at is not null
      and rejected_by is null and applied_by is null
      and ((processing_mode = 'LEGACY_APPROVAL' and approved_by <> requested_by)
        or (processing_mode = 'DIRECT' and approved_by = requested_by)))
    or (status = 'REJECTED' and official_project_code is null
      and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and official_project_code is not null
      and applied_by is not null and applied_at is not null
      and materialized_project_id is not null
      and ((processing_mode = 'LEGACY_APPROVAL'
          and approved_by is not null and approved_by <> requested_by
          and applied_by <> requested_by)
        or (processing_mode = 'DIRECT'
          and ((approved_by is null and approved_at is null)
            or (approved_by = requested_by and approved_at is not null)))))
  );

alter table public.financial_pending_new_project_link_requests
  drop constraint if exists financial_pending_link_state_shape;
alter table public.financial_pending_new_project_link_requests
  add constraint financial_pending_link_state_shape check (
    (status = 'SUBMITTED' and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and rejected_by is null and applied_by is null
      and ((processing_mode = 'LEGACY_APPROVAL' and approval_mode = 'MANUAL'
          and approved_by <> requested_by)
        or (processing_mode = 'DIRECT' and approval_mode = 'AUTO'
          and approved_by = requested_by)))
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and applied_by is not null and applied_at is not null
      and materialized_movement_id is not null
      and ((processing_mode = 'LEGACY_APPROVAL'
          and approved_by is not null and approved_by <> requested_by
          and applied_by <> requested_by)
        or (processing_mode = 'DIRECT' and approval_mode = 'AUTO'
          and ((approved_by is null and approved_at is null)
            or (approved_by = requested_by and approved_at is not null)))))
  );

create table public.financial_project_code_sequences (
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  region_id uuid not null references public.regions(id) on delete restrict,
  last_number integer not null check (last_number > 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (fiscal_year, region_id)
);

create or replace function public.financial_next_project_code(
  p_fiscal_year integer,
  p_region_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_region_code text;
  v_existing_max integer;
  v_number integer;
  v_code text;
begin
  if p_fiscal_year not between 2000 and 2200 or p_region_id is null then
    raise exception using errcode = '22023', message = '사업연도와 지자체를 확인해 주세요.';
  end if;
  select btrim(regions.region_code) into v_region_code
  from public.regions where id = p_region_id;
  if not found or coalesce(v_region_code, '') = ''
     or v_region_code !~ '^[A-Za-z0-9._/-]+$' then
    raise exception using errcode = '23514', message = '공식 사업코드를 만들 지자체 코드를 확인해 주세요.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('project-code:' || p_fiscal_year::text || ':' || p_region_id::text, 0));
  select coalesce(max((regexp_match(projects.project_code,
      '^' || p_fiscal_year::text || '-' || regexp_replace(v_region_code, '([.\\+*?\[\](){}|^$])', '\\\1', 'g') || '-([0-9]{4,})$'))[1]::integer), 0)
    into v_existing_max
  from public.projects
  where projects.region_id = p_region_id and projects.year = p_fiscal_year;

  insert into public.financial_project_code_sequences(fiscal_year, region_id, last_number)
  values (p_fiscal_year, p_region_id, v_existing_max + 1)
  on conflict (fiscal_year, region_id) do update
    set last_number = greatest(
      public.financial_project_code_sequences.last_number,
      excluded.last_number - 1
    ) + 1,
    updated_at = clock_timestamp()
  returning last_number into v_number;

  loop
    v_code := format('%s-%s-%s', p_fiscal_year, v_region_code, lpad(v_number::text, 4, '0'));
    exit when not exists (
      select 1 from public.projects
      where project_code = v_code or project_id = v_code
    ) and not exists (
      select 1 from public.financial_new_project_requests
      where official_project_code = v_code
    );
    update public.financial_project_code_sequences
    set last_number = last_number + 1, updated_at = clock_timestamp()
    where fiscal_year = p_fiscal_year and region_id = p_region_id
    returning last_number into v_number;
  end loop;
  return v_code;
end;
$$;

create table public.financial_direct_processing_transitions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('NEW_PROJECT', 'FUNDING_LINK')),
  entity_id uuid not null,
  region_id uuid not null references public.regions(id) on delete restrict,
  before_status text not null,
  after_status text not null,
  result text not null check (result in ('COMPLETED', 'ALREADY_COMPLETED', 'NEEDS_INPUT', 'SKIPPED')),
  details jsonb not null default '{}'::jsonb,
  processed_by uuid references public.profiles(id) on delete restrict,
  processed_at timestamptz not null default clock_timestamp(),
  unique (entity_type, entity_id)
);

-- The existing apply functions remain the only materializers. Direct entry is
-- available only through the signed-in completion RPC; direct calls are revoked below.
do $patch$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef('public.financial_apply_new_project_request(uuid)'::regprocedure)
    into v_definition;
  v_original := v_definition;
  v_definition := replace(v_definition,
    '  v_actor_id := public.financial_require_admin();',
    '  if current_setting(''app.financial_direct_new_project_request_id'', true) = p_request_id::text then
    select actor.actor_id into v_actor_id
    from public.financial_require_actor() as actor;
  else
    v_actor_id := public.financial_require_admin();
  end if;');
  v_definition := replace(v_definition,
    'if v_request.status <> ''APPROVED'' or v_request.requested_by = v_actor_id then',
    'if v_request.status <> ''APPROVED'' or (
      v_request.requested_by = v_actor_id and not (
        v_request.processing_mode = ''DIRECT''
        and current_setting(''app.financial_direct_new_project_request_id'', true) = p_request_id::text
      )
    ) then');
  v_definition := replace(v_definition,
    '''Approved new-project waiting-fund allocation''',
    '''Direct new-project waiting-fund allocation''');
  if v_definition = v_original
     or position('app.financial_direct_new_project_request_id' in v_definition) = 0
     or position('v_request.processing_mode = ''DIRECT''' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      '신규사업 적용 함수의 직접 처리 안전 패치를 적용하지 못했습니다.';
  end if;
  execute v_definition;
end;
$patch$;

create or replace function public.financial_apply_new_project_request_v2(p_request_id uuid)
returns table (
  request_id uuid,
  project_id uuid,
  project_code text,
  movement_id uuid,
  budget_year_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_applied record;
  v_request public.financial_new_project_requests%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_link public.financial_pending_new_project_link_requests%rowtype;
  v_link_result record;
begin
  select applied.* into v_applied
  from public.financial_apply_new_project_request(p_request_id) as applied;
  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.id = p_request_id for update;

  select pending.* into v_pending
  from public.financial_pending_new_project_funds as pending
  where pending.lot_id = v_request.source_lot_id
  for update;

  if not found then
    return query select v_applied.request_id, v_applied.project_id,
      v_applied.project_code, v_applied.movement_id, v_applied.budget_year_id;
    return;
  end if;

  select links.* into v_link
  from public.financial_pending_new_project_link_requests as links
  where links.pending_fund_id = v_pending.id
    and links.destination_project_id = v_applied.project_id
  order by links.requested_at desc
  limit 1 for update;
  if not found then
    raise exception using errcode = '55000', message =
      '신규사업과 예정재원의 직접 연결 요청을 찾을 수 없습니다.';
  end if;
  if v_link.status = 'SUBMITTED' then
    update public.financial_pending_new_project_link_requests as links
    set status = 'APPROVED', approval_mode = 'AUTO', processing_mode = 'DIRECT',
        approved_by = links.requested_by, approved_at = clock_timestamp()
    where links.id = v_link.id
    returning * into v_link;
  end if;
  if v_link.status = 'APPROVED' then
    perform set_config('app.financial_pending_link_auto_request_id', v_link.id::text, true);
    select applied.* into v_link_result
    from public.financial_apply_pending_new_project_link(v_link.id) as applied;
    select links.* into v_link
    from public.financial_pending_new_project_link_requests as links
    where links.id = v_link.id;
  end if;
  if v_link.status <> 'APPLIED' or v_link.materialized_movement_id is null then
    raise exception using errcode = '55000', message =
      '신규사업 예정재원 직접 연결을 완료하지 못했습니다.';
  end if;
  update public.financial_pending_new_project_link_requests as links
  set approved_by = null, approved_at = null
  where links.id = v_link.id and links.processing_mode = 'DIRECT';
  update public.financial_new_project_requests as requests
  set materialized_movement_id = v_link.materialized_movement_id
  where requests.id = v_request.id;
  return query select v_request.id, v_applied.project_id,
    v_applied.project_code, v_link.materialized_movement_id,
    v_applied.budget_year_id;
end;
$$;

create or replace function public.financial_complete_new_project_request(p_request_id uuid)
returns table (
  request_id uuid,
  status text,
  project_id uuid,
  project_code text,
  movement_id uuid,
  budget_year_id uuid
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
  v_before_status text;
  v_code text;
  v_applied record;
  v_enabled boolean;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select settings.direct_processing_enabled into v_enabled
  from public.financial_direct_workflow_settings as settings
  where settings.singleton = true;
  if not coalesce(v_enabled, false) then
    raise exception using errcode = '55000', message =
      '신규사업 직접 처리가 일시 중단되어 있습니다.';
  end if;
  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '신규사업 요청을 찾을 수 없습니다.';
  end if;
  if v_role = 'local_user' and (
      v_request.region_id <> v_actor_region_id or v_request.requested_by <> v_actor_id
    ) then
    raise exception using errcode = '42501', message =
      '본인 지자체의 신규사업 요청만 완료할 수 있습니다.';
  end if;
  if v_request.status = 'APPLIED' then
    insert into public.financial_direct_processing_transitions(
      entity_type, entity_id, region_id, before_status, after_status,
      result, details, processed_by
    ) values (
      'NEW_PROJECT', v_request.id, v_request.region_id, 'APPLIED', 'APPLIED',
      'ALREADY_COMPLETED', jsonb_build_object(
        'project_id', v_request.materialized_project_id,
        'movement_id', v_request.materialized_movement_id
      ), v_actor_id
    ) on conflict (entity_type, entity_id) do nothing;
    return query select v_request.id, v_request.status,
      v_request.materialized_project_id, v_request.official_project_code,
      v_request.materialized_movement_id,
      (select wallets.id from public.project_budget_years as wallets
       where wallets.project_id = v_request.materialized_project_id
       order by wallets.created_at desc limit 1);
    return;
  end if;
  if v_request.status not in ('SUBMITTED', 'APPROVED') then
    raise exception using errcode = '23514', message =
      '제출된 신규사업 요청만 직접 완료할 수 있습니다.';
  end if;
  if v_request.source_lot_id is null or v_request.requested_amount <= 0
     or coalesce(btrim(v_request.project_name), '') = ''
     or v_request.business_type not in ('HW', 'SW', 'COMPOSITE') then
    raise exception using errcode = '23514', message =
      '신규사업 필수 입력과 연결 재원을 모두 입력해 주세요.';
  end if;
  v_before_status := v_request.status;
  v_code := coalesce(v_request.official_project_code,
    public.financial_next_project_code(v_request.fiscal_year, v_request.region_id));
  update public.financial_new_project_requests as requests
  set processing_mode = 'DIRECT', status = 'APPROVED',
      official_project_code = v_code,
      approved_by = requests.requested_by, approved_at = clock_timestamp()
  where requests.id = v_request.id;
  perform set_config('app.financial_direct_new_project_request_id', v_request.id::text, true);
  select applied.* into v_applied
  from public.financial_apply_new_project_request_v2(v_request.id) as applied;
  update public.financial_new_project_requests as requests
  set approved_by = null, approved_at = null
  where requests.id = v_request.id and requests.processing_mode = 'DIRECT';
  insert into public.financial_direct_processing_transitions(
    entity_type, entity_id, region_id, before_status, after_status,
    result, details, processed_by
  ) values (
    'NEW_PROJECT', v_request.id, v_request.region_id, v_before_status, 'APPLIED',
    'COMPLETED', jsonb_build_object(
      'project_id', v_applied.project_id,
      'project_code', v_applied.project_code,
      'movement_id', v_applied.movement_id,
      'amount', v_request.requested_amount
    ), v_actor_id
  ) on conflict (entity_type, entity_id) do nothing;
  perform public.financial_write_audit(
    v_applied.project_id, v_request.region_id,
    'NEW_PROJECT_DIRECT_COMPLETED', 'financial_new_project_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('before_status', v_before_status, 'after_status', 'APPLIED',
      'project_code', v_applied.project_code, 'amount', v_request.requested_amount,
      'approval_required', false)
  );
  return query select v_request.id, 'APPLIED'::text, v_applied.project_id,
    v_applied.project_code, v_applied.movement_id, v_applied.budget_year_id;
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
  v_completed record;
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
      '요청자 본인의 신규사업 초안만 완료할 수 있습니다.';
  end if;
  v_reason := public.financial_normalize_execution_status_reason(
    v_request.project_status, v_request.execution_status_reason
  );
  update public.financial_new_project_requests as requests
  set execution_status_reason = v_reason
  where requests.id = v_request.id;
  perform 1 from public.financial_submit_new_project_request(v_request.id);
  select completed.* into v_completed
  from public.financial_complete_new_project_request(v_request.id) as completed;
  return query select v_completed.request_id, v_completed.status;
end;
$$;

-- Budget changes that contain an existing- or new-project destination now use
-- the same atomic submit/apply transaction. New project codes are generated here.
create or replace function public.financial_submit_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
  v_new_request public.financial_new_project_requests%rowtype;
  v_applied record;
  v_auto_apply boolean;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT'
     or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message =
      '요청자만 작성 중인 예산조정을 완료할 수 있습니다.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_request.adjustment_fingerprint, 0));
  if exists (
    select 1 from public.financial_budget_change_requests as requests
    where requests.id <> v_request.id
      and requests.adjustment_fingerprint = v_request.adjustment_fingerprint
      and requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
      and requests.duplicate_of_request_id is null
  ) then
    raise exception using errcode = '23505', message =
      '동일 예산조정이 이미 제출되었거나 적용되었습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  update public.financial_new_project_requests as new_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where new_requests.source_budget_change_request_id = v_request.id
    and new_requests.status = 'DRAFT'
    and exists (
      select 1 from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_request.id
        and lines.new_project_request_id = new_requests.id
        and not lines.unlinked_funding_only
    );
  update public.financial_budget_change_requests as requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);

  select settings.direct_processing_enabled into v_auto_apply
  from public.financial_direct_workflow_settings as settings
  where settings.singleton = true;
  if not coalesce(v_auto_apply, false) then
    return query select v_request.id, v_request.status;
    return;
  end if;

  for v_new_request in
    select new_requests.*
    from public.financial_new_project_requests as new_requests
    join public.financial_budget_change_request_lines as lines
      on lines.new_project_request_id = new_requests.id
    where lines.request_id = v_request.id
      and not lines.unlinked_funding_only
    order by new_requests.id for update of new_requests
  loop
    update public.financial_new_project_requests as new_requests
    set processing_mode = 'DIRECT', status = 'APPROVED',
        official_project_code = coalesce(new_requests.official_project_code,
          public.financial_next_project_code(new_requests.fiscal_year, new_requests.region_id)),
        approved_by = new_requests.requested_by,
        approved_at = clock_timestamp()
    where new_requests.id = v_new_request.id;
  end loop;
  update public.financial_budget_change_requests as requests
  set status = 'APPROVED', approval_mode = 'AUTO',
      approved_by = v_actor_id, approved_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_AUTO_APPROVED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('amount', v_request.total_amount,
      'approval_mode', 'AUTO', 'monetary_effect', 0,
      'new_project_approval_required', false)
  );
  perform set_config('app.financial_budget_change_auto_request_id', v_request.id::text, true);
  select applied.* into v_applied
  from public.financial_apply_budget_change_request(v_request.id) as applied;
  update public.financial_new_project_requests as new_requests
  set approved_by = null, approved_at = null
  where new_requests.source_budget_change_request_id = v_request.id
    and new_requests.processing_mode = 'DIRECT'
    and new_requests.status = 'APPLIED';
  return query select v_applied.request_id, v_applied.status;
end;
$$;

-- Preserve the budget-exception approval entry point, but do not let it approve
-- a new-project registration that belongs to the direct workflow.
do $patch$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef(
    'public.financial_approve_budget_change_request_group(uuid,jsonb)'::regprocedure
  ) into v_definition;
  v_original := v_definition;
  v_definition := replace(v_definition,
    '  perform public.financial_validate_budget_change_request(v_request.id);',
    '  if exists (
    select 1 from public.financial_budget_change_request_lines as direct_lines
    where direct_lines.request_id = v_request.id
      and direct_lines.new_project_request_id is not null
      and not direct_lines.unlinked_funding_only
  ) then
    raise exception using errcode = ''42501'', message =
      ''신규사업 등록이 포함된 예산연결은 관리자 승인 대상이 아닙니다.'';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);');
  if v_definition = v_original
     or position('신규사업 등록이 포함된 예산연결은 관리자 승인 대상이 아닙니다.' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      '예산조정 승인 함수에 신규사업 직접 처리 보호를 적용하지 못했습니다.';
  end if;
  execute v_definition;
end;
$patch$;

create or replace function public.financial_request_pending_new_project_link(
  p_pending_fund_id uuid,
  p_destination_project_id uuid,
  p_idempotency_key uuid
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_destination_region uuid;
  v_destination_year integer;
  v_fingerprint text;
  v_request public.financial_pending_new_project_link_requests%rowtype;
  v_applied record;
  v_enabled boolean;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select settings.direct_processing_enabled into v_enabled
  from public.financial_direct_workflow_settings as settings
  where settings.singleton = true;
  if not coalesce(v_enabled, false) then
    raise exception using errcode = '55000', message = '예정재원 직접 연결이 일시 중단되어 있습니다.';
  end if;
  select requests.* into v_request
  from public.financial_pending_new_project_link_requests as requests
  where requests.idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id
       or v_request.pending_fund_id <> p_pending_fund_id
       or v_request.destination_project_id <> p_destination_project_id then
      raise exception using errcode = '42501', message =
        '요청 식별키가 다른 요청 또는 사용자에게 속해 있습니다.';
    end if;
    return query select v_request.id, v_request.status;
    return;
  end if;
  select pending.* into v_pending
  from public.financial_pending_new_project_funds as pending
  where pending.id = p_pending_fund_id for update;
  if not found or v_pending.status <> 'WAITING' then
    raise exception using errcode = '23514', message = '연결 가능한 신규사업 예정재원이 아닙니다.';
  end if;
  select projects.region_id, projects.year into v_destination_region, v_destination_year
  from public.projects as projects where projects.id = p_destination_project_id;
  if not found or v_destination_region <> v_pending.region_id
     or v_destination_year <> v_pending.planned_project_year then
    raise exception using errcode = '23514', message =
      '예정연도와 지자체가 같은 실제 사업에만 연결할 수 있습니다.';
  end if;
  if v_role = 'local_user' and v_pending.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '다른 지자체의 예정재원을 연결할 수 없습니다.';
  end if;
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'pending_fund_id', p_pending_fund_id,
    'destination_project_id', p_destination_project_id,
    'amount', v_pending.amount
  ));
  insert into public.financial_pending_new_project_link_requests (
    pending_fund_id, region_id, destination_project_id, amount, status,
    idempotency_key, request_fingerprint, requested_by,
    approval_mode, processing_mode
  ) values (
    v_pending.id, v_pending.region_id, p_destination_project_id, v_pending.amount,
    'SUBMITTED', p_idempotency_key, v_fingerprint, v_actor_id,
    'AUTO', 'DIRECT'
  ) returning * into v_request;
  perform public.financial_write_audit(
    p_destination_project_id, v_pending.region_id,
    'PENDING_NEW_PROJECT_LINK_DIRECT_STARTED',
    'financial_pending_new_project_link_requests', v_request.id, v_actor_id,
    jsonb_build_object('pending_fund_id', v_pending.id, 'amount', v_pending.amount,
      'approval_required', false)
  );
  update public.financial_pending_new_project_link_requests as requests
  set status = 'APPROVED', approved_by = requests.requested_by,
      approved_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform set_config('app.financial_pending_link_auto_request_id', v_request.id::text, true);
  select applied.* into v_applied
  from public.financial_apply_pending_new_project_link(v_request.id) as applied;
  update public.financial_pending_new_project_link_requests as requests
  set approved_by = null, approved_at = null
  where requests.id = v_request.id
  returning * into v_request;
  insert into public.financial_direct_processing_transitions(
    entity_type, entity_id, region_id, before_status, after_status,
    result, details, processed_by
  ) values (
    'FUNDING_LINK', v_request.id, v_request.region_id, 'SUBMITTED', 'APPLIED',
    'COMPLETED', jsonb_build_object('pending_fund_id', v_pending.id,
      'destination_project_id', p_destination_project_id,
      'movement_id', v_request.materialized_movement_id,
      'amount', v_pending.amount), v_actor_id
  ) on conflict (entity_type, entity_id) do nothing;
  return query select v_request.id, v_request.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Post-completion check requests and durable in-app notifications
-- ---------------------------------------------------------------------------
create table public.financial_post_check_requests (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('PROJECT', 'FUNDING_LINK', 'BUDGET_CHANGE')),
  subject_id uuid not null,
  project_id uuid references public.projects(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  status text not null default 'REQUESTED'
    check (status in ('REQUESTED', 'REPLIED', 'COMPLETED')),
  message text not null check (char_length(btrim(message)) between 1 and 2000),
  due_date date,
  parent_request_id uuid references public.financial_post_check_requests(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  replied_by uuid references public.profiles(id) on delete restrict,
  replied_at timestamptz,
  reply_message text check (reply_message is null or char_length(btrim(reply_message)) between 1 and 2000),
  completed_by uuid references public.profiles(id) on delete restrict,
  completed_at timestamptz,
  constraint financial_post_check_state_shape check (
    (status = 'REQUESTED' and replied_by is null and replied_at is null
      and reply_message is null and completed_by is null and completed_at is null)
    or (status = 'REPLIED' and replied_by is not null and replied_at is not null
      and reply_message is not null and completed_by is null and completed_at is null)
    or (status = 'COMPLETED' and replied_by is not null and replied_at is not null
      and reply_message is not null and completed_by is not null and completed_at is not null)
  )
);

create unique index financial_post_check_one_open_subject_uidx
  on public.financial_post_check_requests(subject_type, subject_id)
  where status = 'REQUESTED';
create index financial_post_checks_region_status_idx
  on public.financial_post_check_requests(region_id, status, requested_at desc);
create index financial_post_checks_parent_idx
  on public.financial_post_check_requests(parent_request_id, requested_at);

create table public.system_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles(id) on delete restrict,
  region_id uuid references public.regions(id) on delete restrict,
  notification_type text not null check (
    notification_type in ('POST_CHECK_REQUEST', 'POST_CHECK_REPLY')
  ),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  action_href text not null check (char_length(btrim(action_href)) between 1 and 1000),
  related_post_check_id uuid not null references public.financial_post_check_requests(id) on delete restrict,
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (recipient_user_id, notification_type, related_post_check_id)
);

create index system_notifications_recipient_idx
  on public.system_notifications(recipient_user_id, read_at, created_at desc);

create or replace function public.financial_create_post_check_request(
  p_subject_type text,
  p_subject_id uuid,
  p_message text,
  p_due_date date default null,
  p_parent_request_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_subject_type text;
  v_region_id uuid;
  v_project_id uuid;
  v_project_name text;
  v_request_id uuid;
  v_enabled boolean;
begin
  v_actor_id := public.financial_require_admin();
  select settings.post_check_enabled into v_enabled
  from public.financial_direct_workflow_settings as settings
  where settings.singleton = true;
  if not coalesce(v_enabled, false) then
    raise exception using errcode = '55000', message = '확인요청 기능이 일시 중단되어 있습니다.';
  end if;
  v_subject_type := upper(btrim(coalesce(p_subject_type, '')));
  if v_subject_type = 'PROJECT' then
    select projects.region_id, projects.id, projects.project_name
      into v_region_id, v_project_id, v_project_name
    from public.projects where projects.id = p_subject_id;
  elsif v_subject_type = 'FUNDING_LINK' then
    select links.region_id, links.destination_project_id, projects.project_name
      into v_region_id, v_project_id, v_project_name
    from public.financial_pending_new_project_link_requests as links
    join public.projects on projects.id = links.destination_project_id
    where links.id = p_subject_id and links.status = 'APPLIED';
  elsif v_subject_type = 'BUDGET_CHANGE' then
    select requests.region_id, requests.source_project_id, projects.project_name
      into v_region_id, v_project_id, v_project_name
    from public.financial_budget_change_requests as requests
    join public.projects on projects.id = requests.source_project_id
    where requests.id = p_subject_id and requests.status = 'APPLIED';
  else
    raise exception using errcode = '22023', message = '확인요청 대상을 확인해 주세요.';
  end if;
  if not found then
    raise exception using errcode = 'P0002', message = '완료된 확인요청 대상을 찾을 수 없습니다.';
  end if;
  if coalesce(char_length(btrim(p_message)), 0) = 0 then
    raise exception using errcode = '23514', message = '확인요청 내용을 입력해 주세요.';
  end if;
  if p_parent_request_id is not null and not exists (
    select 1 from public.financial_post_check_requests as parents
    where parents.id = p_parent_request_id
      and parents.subject_type = v_subject_type
      and parents.subject_id = p_subject_id
      and parents.region_id = v_region_id
      and parents.status in ('REPLIED', 'COMPLETED')
  ) then
    raise exception using errcode = '23514', message = '재확인할 이전 요청을 확인해 주세요.';
  end if;
  insert into public.financial_post_check_requests(
    subject_type, subject_id, project_id, region_id, message, due_date,
    parent_request_id, requested_by
  ) values (
    v_subject_type, p_subject_id, v_project_id, v_region_id, btrim(p_message),
    p_due_date, p_parent_request_id, v_actor_id
  ) returning id into v_request_id;
  insert into public.system_notifications(
    recipient_user_id, region_id, notification_type, title, body,
    action_href, related_post_check_id
  )
  select profiles.id, v_region_id, 'POST_CHECK_REQUEST',
    '확인요청 · ' || coalesce(v_project_name, '사업'), btrim(p_message),
    '/confirmations?request=' || v_request_id::text, v_request_id
  from public.profiles
  where profiles.role = 'local_user' and profiles.region_id = v_region_id;
  perform public.financial_write_audit(
    v_project_id, v_region_id, 'POST_CHECK_REQUESTED',
    'financial_post_check_requests', v_request_id, v_actor_id,
    jsonb_build_object('subject_type', v_subject_type, 'subject_id', p_subject_id,
      'due_date', p_due_date, 'monetary_effect', 0)
  );
  return v_request_id;
end;
$$;

create or replace function public.financial_reply_post_check_request(
  p_request_id uuid,
  p_reply_message text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_post_check_requests%rowtype;
  v_project_name text;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  if v_role <> 'local_user' then
    raise exception using errcode = '42501', message = '지자체 사용자만 확인요청에 회신할 수 있습니다.';
  end if;
  select requests.* into v_request
  from public.financial_post_check_requests as requests
  where requests.id = p_request_id for update;
  if not found or v_request.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '다른 지자체의 확인요청에 회신할 수 없습니다.';
  end if;
  if v_request.status <> 'REQUESTED' then
    raise exception using errcode = '23514', message = '회신 가능한 확인요청 상태가 아닙니다.';
  end if;
  if coalesce(char_length(btrim(p_reply_message)), 0) = 0 then
    raise exception using errcode = '23514', message = '조치내용 또는 설명을 입력해 주세요.';
  end if;
  update public.financial_post_check_requests as requests
  set status = 'REPLIED', replied_by = v_actor_id,
      replied_at = clock_timestamp(), reply_message = btrim(p_reply_message)
  where requests.id = v_request.id;
  select projects.project_name into v_project_name
  from public.projects where id = v_request.project_id;
  insert into public.system_notifications(
    recipient_user_id, region_id, notification_type, title, body,
    action_href, related_post_check_id
  )
  select profiles.id, v_request.region_id, 'POST_CHECK_REPLY',
    '확인요청 회신 · ' || coalesce(v_project_name, '사업'), btrim(p_reply_message),
    '/confirmations?request=' || v_request.id::text, v_request.id
  from public.profiles where profiles.role = 'admin';
  perform public.financial_write_audit(
    v_request.project_id, v_request.region_id, 'POST_CHECK_REPLIED',
    'financial_post_check_requests', v_request.id, v_actor_id,
    jsonb_build_object('monetary_effect', 0)
  );
  return 'REPLIED';
end;
$$;

create or replace function public.financial_complete_post_check_request(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_post_check_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select requests.* into v_request
  from public.financial_post_check_requests as requests
  where requests.id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '확인요청을 찾을 수 없습니다.';
  end if;
  if v_request.status = 'COMPLETED' then return 'COMPLETED'; end if;
  if v_request.status <> 'REPLIED' then
    raise exception using errcode = '23514', message = '회신된 요청만 확인완료할 수 있습니다.';
  end if;
  update public.financial_post_check_requests as requests
  set status = 'COMPLETED', completed_by = v_actor_id,
      completed_at = clock_timestamp()
  where requests.id = v_request.id;
  perform public.financial_write_audit(
    v_request.project_id, v_request.region_id, 'POST_CHECK_COMPLETED',
    'financial_post_check_requests', v_request.id, v_actor_id,
    jsonb_build_object('monetary_effect', 0)
  );
  return 'COMPLETED';
end;
$$;

create or replace function public.financial_mark_notification_read(p_notification_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_read_at timestamptz;
begin
  select actor.actor_id into v_actor_id from public.financial_require_actor() as actor;
  update public.system_notifications as notifications
  set read_at = coalesce(notifications.read_at, clock_timestamp())
  where notifications.id = p_notification_id
    and notifications.recipient_user_id = v_actor_id
  returning notifications.read_at into v_read_at;
  if not found then
    raise exception using errcode = '42501', message = '본인의 알림만 조회 처리할 수 있습니다.';
  end if;
  return v_read_at;
end;
$$;

create or replace function public.get_financial_post_check_requests(p_status text default null)
returns table (
  id uuid,
  subject_type text,
  subject_id uuid,
  project_id uuid,
  project_name text,
  region_id uuid,
  region_name text,
  fiscal_year integer,
  amount bigint,
  status text,
  message text,
  due_date date,
  parent_request_id uuid,
  requested_by uuid,
  requested_at timestamptz,
  replied_by uuid,
  replied_at timestamptz,
  reply_message text,
  completed_by uuid,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_actor_region_id uuid;
begin
  select actor.actor_role, actor.actor_region_id
    into v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  return query
  select checks.id, checks.subject_type, checks.subject_id,
    checks.project_id, projects.project_name, checks.region_id,
    regions.display_name::text,
    case
      when checks.subject_type = 'BUDGET_CHANGE' then budget_requests.fiscal_year
      else projects.year
    end,
    case
      when checks.subject_type = 'FUNDING_LINK' then links.amount
      when checks.subject_type = 'BUDGET_CHANGE' then budget_requests.total_amount
      else projects.total_budget::bigint
    end,
    checks.status, checks.message, checks.due_date, checks.parent_request_id,
    checks.requested_by, checks.requested_at, checks.replied_by,
    checks.replied_at, checks.reply_message, checks.completed_by, checks.completed_at
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

create or replace function public.get_financial_notifications(p_unread_only boolean default false)
returns table (
  id uuid,
  notification_type text,
  title text,
  body text,
  action_href text,
  related_post_check_id uuid,
  read_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
begin
  select actor.actor_id into v_actor_id from public.financial_require_actor() as actor;
  return query
  select notifications.id, notifications.notification_type,
    notifications.title, notifications.body, notifications.action_href,
    notifications.related_post_check_id, notifications.read_at,
    notifications.created_at
  from public.system_notifications as notifications
  where notifications.recipient_user_id = v_actor_id
    and (not coalesce(p_unread_only, false) or notifications.read_at is null)
  order by notifications.created_at desc;
end;
$$;

alter table public.financial_direct_workflow_settings enable row level security;
alter table public.financial_project_code_sequences enable row level security;
alter table public.financial_direct_processing_transitions enable row level security;
alter table public.financial_post_check_requests enable row level security;
alter table public.system_notifications enable row level security;
alter table public.financial_direct_workflow_settings force row level security;
alter table public.financial_project_code_sequences force row level security;
alter table public.financial_direct_processing_transitions force row level security;
alter table public.financial_post_check_requests force row level security;
alter table public.system_notifications force row level security;

create policy financial_direct_settings_admin_select
  on public.financial_direct_workflow_settings for select to authenticated
  using (exists (select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'));
create policy financial_direct_transitions_region_select
  on public.financial_direct_processing_transitions for select to authenticated
  using (exists (select 1 from public.profiles
    where id = (select auth.uid())
      and (role = 'admin' or region_id = financial_direct_processing_transitions.region_id)));
create policy financial_post_checks_region_select
  on public.financial_post_check_requests for select to authenticated
  using (exists (select 1 from public.profiles
    where id = (select auth.uid())
      and (role = 'admin' or region_id = financial_post_check_requests.region_id)));
create policy system_notifications_recipient_select
  on public.system_notifications for select to authenticated
  using (recipient_user_id = (select auth.uid()));

revoke all on table public.financial_direct_workflow_settings from public, anon, authenticated;
revoke all on table public.financial_project_code_sequences from public, anon, authenticated;
revoke all on table public.financial_direct_processing_transitions from public, anon, authenticated;
revoke all on table public.financial_post_check_requests from public, anon, authenticated;
revoke all on table public.system_notifications from public, anon, authenticated;
grant select on table public.financial_direct_processing_transitions to authenticated;
grant select on table public.financial_post_check_requests to authenticated;
grant select on table public.system_notifications to authenticated;

revoke all on function public.financial_next_project_code(integer,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_apply_new_project_request(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_apply_new_project_request_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_submit_new_project_request(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_create_new_project_request(
  uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,boolean
) from public, anon, authenticated, service_role;
revoke all on function public.financial_approve_new_project_request(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_reject_new_project_request(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_review_pending_new_project_link(uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_apply_pending_new_project_link(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_reject_budget_change_request(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.financial_apply_budget_change_request_dispatch(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.financial_complete_new_project_request(uuid) from public, anon;
grant execute on function public.financial_complete_new_project_request(uuid) to authenticated;
revoke all on function public.financial_submit_new_project_request_v2(uuid) from public, anon;
grant execute on function public.financial_submit_new_project_request_v2(uuid) to authenticated;
revoke all on function public.financial_submit_budget_change_request(uuid) from public, anon;
grant execute on function public.financial_submit_budget_change_request(uuid) to authenticated;
revoke all on function public.financial_request_pending_new_project_link(uuid,uuid,uuid) from public, anon;
grant execute on function public.financial_request_pending_new_project_link(uuid,uuid,uuid) to authenticated;
revoke all on function public.financial_create_post_check_request(text,uuid,text,date,uuid) from public, anon;
grant execute on function public.financial_create_post_check_request(text,uuid,text,date,uuid) to authenticated;
revoke all on function public.financial_reply_post_check_request(uuid,text) from public, anon;
grant execute on function public.financial_reply_post_check_request(uuid,text) to authenticated;
revoke all on function public.financial_complete_post_check_request(uuid) from public, anon;
grant execute on function public.financial_complete_post_check_request(uuid) to authenticated;
revoke all on function public.financial_mark_notification_read(uuid) from public, anon;
grant execute on function public.financial_mark_notification_read(uuid) to authenticated;
revoke all on function public.get_financial_post_check_requests(text) from public, anon;
grant execute on function public.get_financial_post_check_requests(text) to authenticated;
revoke all on function public.get_financial_notifications(boolean) from public, anon;
grant execute on function public.get_financial_notifications(boolean) to authenticated;

do $$
declare
  v_before direct_workflow_install_snapshot%rowtype;
  v_after direct_workflow_install_snapshot%rowtype;
begin
  select * into v_before from direct_workflow_install_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select count(*) from public.project_fund_transfers)::bigint,
    (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '직접 처리·확인요청 설치 중 기존 사업 또는 원장 금액이 변경되었습니다.';
  end if;
  if has_function_privilege('authenticated', 'public.financial_approve_new_project_request(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_submit_new_project_request(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_apply_new_project_request_v2(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_review_pending_new_project_link(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_apply_pending_new_project_link(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_approve_budget_change_request_group(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_reject_budget_change_request(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.financial_apply_budget_change_request_dispatch(uuid)', 'EXECUTE') then
    raise exception using errcode = '55000', message =
      '사용하지 않는 승인·적용 RPC 실행 권한이 남아 있습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
