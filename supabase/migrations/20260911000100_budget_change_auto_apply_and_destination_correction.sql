-- Reversible automatic budget-change application and append-only destination
-- correction. Existing confirmed ledger rows are never updated or deleted.

begin;

do $$
begin
  if to_regclass('public.financial_budget_change_requests') is null
     or to_regclass('public.financial_budget_change_request_lines') is null
     or to_regclass('public.financial_pending_new_project_link_requests') is null
     or to_regprocedure('public.financial_apply_budget_change_request(uuid)') is null
     or to_regprocedure('public.financial_apply_pending_new_project_link(uuid)') is null then
    raise exception using errcode = '55000', message =
      '예산조정 자동반영 선행 객체를 찾을 수 없습니다.';
  end if;
end;
$$;

create temporary table budget_change_auto_apply_install_snapshot on commit drop as
select
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric as transfer_amount,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric as movement_amount,
  (select count(*) from public.financial_project_decrease_classifications)::bigint as classification_count,
  (select coalesce(sum(amount), 0) from public.financial_project_decrease_classifications)::numeric as classification_amount;

-- A singleton setting is intentionally kept even though there is no settings UI
-- yet. Operations can immediately return to maker-checker mode without reverting
-- schema or ledger data.
create table public.financial_workflow_settings (
  singleton boolean primary key default true check (singleton),
  budget_change_auto_apply boolean not null default true,
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  reason text not null default '예산조정 자동승인 초기 적용'
    check (char_length(btrim(reason)) between 1 and 1000)
);

insert into public.financial_workflow_settings (
  singleton, budget_change_auto_apply, changed_by, reason
) values (true, true, null, '예산조정 자동승인 초기 적용');

create table public.financial_workflow_setting_events (
  id uuid primary key default gen_random_uuid(),
  setting_name text not null check (setting_name = 'BUDGET_CHANGE_AUTO_APPLY'),
  previous_value boolean not null,
  next_value boolean not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  changed_by uuid not null references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);

create or replace function public.financial_set_budget_change_auto_apply(
  p_enabled boolean,
  p_reason text
)
returns table (auto_approval_enabled boolean, changed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_previous boolean;
  v_changed_at timestamptz;
begin
  v_actor_id := public.financial_require_admin();
  if p_enabled is null
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '설정 변경 사유를 입력해 주세요.';
  end if;
  select settings.budget_change_auto_apply into v_previous
  from public.financial_workflow_settings as settings
  where settings.singleton = true for update;
  v_changed_at := clock_timestamp();
  if v_previous is distinct from p_enabled then
    update public.financial_workflow_settings as settings
    set budget_change_auto_apply = p_enabled,
        changed_by = v_actor_id,
        changed_at = v_changed_at,
        reason = btrim(p_reason)
    where settings.singleton = true;
    insert into public.financial_workflow_setting_events (
      setting_name, previous_value, next_value, reason, changed_by, changed_at
    ) values (
      'BUDGET_CHANGE_AUTO_APPLY', v_previous, p_enabled,
      btrim(p_reason), v_actor_id, v_changed_at
    );
  end if;
  return query select p_enabled, v_changed_at;
end;
$$;

create or replace function public.get_financial_budget_change_workflow_mode()
returns table (auto_approval_enabled boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.financial_require_actor();
  return query
  select settings.budget_change_auto_apply
  from public.financial_workflow_settings as settings
  where settings.singleton = true;
end;
$$;

alter table public.financial_budget_change_requests
  add column approval_mode text not null default 'MANUAL'
    check (approval_mode in ('MANUAL', 'AUTO'));

alter table public.financial_budget_change_requests
  drop constraint if exists financial_budget_change_state_shape;
alter table public.financial_budget_change_requests
  add constraint financial_budget_change_state_shape check (
    (status = 'DRAFT' and submitted_by is null and approved_by is null
      and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and rejected_by is null and applied_by is null
      and ((approval_mode = 'MANUAL' and approved_by <> requested_by)
        or (approval_mode = 'AUTO' and approved_by = requested_by)))
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and approved_by is not null and applied_by is not null
      and applied_at is not null
      and ((approval_mode = 'MANUAL'
          and approved_by <> requested_by and applied_by <> requested_by)
        or (approval_mode = 'AUTO'
          and approved_by = requested_by and applied_by = requested_by)))
  );

alter table public.financial_pending_new_project_link_requests
  add column approval_mode text not null default 'MANUAL'
    check (approval_mode in ('MANUAL', 'AUTO'));

alter table public.financial_pending_new_project_link_requests
  drop constraint if exists financial_pending_link_state_shape;
alter table public.financial_pending_new_project_link_requests
  add constraint financial_pending_link_state_shape check (
    (status = 'SUBMITTED' and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and rejected_by is null and applied_by is null
      and ((approval_mode = 'MANUAL' and approved_by <> requested_by)
        or (approval_mode = 'AUTO' and approved_by = requested_by)))
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and approved_by is not null and applied_by is not null
      and applied_at is not null and materialized_movement_id is not null
      and ((approval_mode = 'MANUAL'
          and approved_by <> requested_by and applied_by <> requested_by)
        or (approval_mode = 'AUTO'
          and approved_by = requested_by and applied_by = requested_by)))
  );

-- The existing, heavily validated apply functions remain the only materializers.
-- They recognize an unforgeable-in-the-API transaction-local request id set by
-- the submission RPC, while direct calls continue to require an administrator.
do $patch$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef(
    'public.financial_apply_budget_change_request(uuid)'::regprocedure
  ) into v_definition;
  v_original := v_definition;
  v_definition := replace(v_definition,
    '  v_actor_id := public.financial_require_admin();',
    '  if current_setting(''app.financial_budget_change_auto_request_id'', true) = p_request_id::text then
    select actor.actor_id into v_actor_id
    from public.financial_require_actor() as actor;
  else
    v_actor_id := public.financial_require_admin();
  end if;');
  v_definition := replace(v_definition,
    'if v_request.status <> ''APPROVED'' or v_request.requested_by = v_actor_id then',
    'if v_request.status <> ''APPROVED''
     or (v_request.requested_by = v_actor_id and not (
       v_request.approval_mode = ''AUTO''
       and current_setting(''app.financial_budget_change_auto_request_id'', true) = p_request_id::text
     )) then');
  if v_definition = v_original
     or position('app.financial_budget_change_auto_request_id' in v_definition) = 0
     or position('v_request.approval_mode = ''AUTO''' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      '예산조정 적용 함수의 자동승인 안전 패치를 적용하지 못했습니다.';
  end if;
  execute v_definition;

  select pg_get_functiondef(
    'public.financial_apply_pending_new_project_link(uuid)'::regprocedure
  ) into v_definition;
  v_original := v_definition;
  v_definition := replace(v_definition,
    '  v_actor_id := public.financial_require_admin();',
    '  if current_setting(''app.financial_pending_link_auto_request_id'', true) = p_request_id::text then
    select actor.actor_id into v_actor_id
    from public.financial_require_actor() as actor;
  else
    v_actor_id := public.financial_require_admin();
  end if;');
  v_definition := replace(v_definition,
    'if v_request.status <> ''APPROVED'' or v_request.requested_by = v_actor_id then',
    'if v_request.status <> ''APPROVED''
     or (v_request.requested_by = v_actor_id and not (
       v_request.approval_mode = ''AUTO''
       and current_setting(''app.financial_pending_link_auto_request_id'', true) = p_request_id::text
     )) then');
  if v_definition = v_original
     or position('app.financial_pending_link_auto_request_id' in v_definition) = 0
     or position('v_request.approval_mode = ''AUTO''' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      '예정재원 연결 함수의 자동승인 안전 패치를 적용하지 못했습니다.';
  end if;
  execute v_definition;
end;
$patch$;

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
  v_applied record;
  v_auto_apply boolean;
  v_requires_project_registration boolean;
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
      '요청자만 작성 중인 예산조정을 제출할 수 있습니다.';
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
      '동일 예산조정이 이미 승인 요청되었거나 적용되었습니다.';
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

  select settings.budget_change_auto_apply into v_auto_apply
  from public.financial_workflow_settings as settings
  where settings.singleton = true;
  select exists (
    select 1
    from public.financial_budget_change_request_lines as lines
    where lines.request_id = v_request.id
      and lines.new_project_request_id is not null
      and not lines.unlinked_funding_only
  ) into v_requires_project_registration;

  -- A human must still provide an official project code when the request also
  -- creates a project. That is project registration, not a budget approval.
  if coalesce(v_auto_apply, false) and not v_requires_project_registration then
    update public.financial_budget_change_requests as requests
    set status = 'APPROVED', approval_mode = 'AUTO',
        approved_by = v_actor_id, approved_at = clock_timestamp()
    where requests.id = v_request.id returning requests.* into v_request;
    perform public.financial_write_audit(
      v_request.source_project_id, v_request.region_id,
      'BUDGET_REALLOCATION_AUTO_APPROVED', 'financial_budget_change_requests',
      v_request.id, v_actor_id,
      jsonb_build_object('amount', v_request.total_amount,
        'approval_mode', 'AUTO', 'monetary_effect', 0)
    );
    perform set_config(
      'app.financial_budget_change_auto_request_id', v_request.id::text, true
    );
    select applied.* into v_applied
    from public.financial_apply_budget_change_request(v_request.id) as applied;
    return query select v_applied.request_id, v_applied.status;
    return;
  end if;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_budget_change_request_group(
  p_request_id uuid,
  p_new_project_codes jsonb default '{}'::jsonb
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
  v_new_request public.financial_new_project_requests%rowtype;
  v_code text;
  v_auto_apply boolean;
  v_applied record;
begin
  v_actor_id := public.financial_require_admin();
  if jsonb_typeof(coalesce(p_new_project_codes, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message =
      '신규사업 공식 사업코드 목록을 확인해 주세요.';
  end if;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message =
      '다른 관리자가 제출된 예산 조정만 승인할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  for v_new_request in
    select new_requests.*
    from public.financial_new_project_requests as new_requests
    join public.financial_budget_change_request_lines as lines
      on lines.new_project_request_id = new_requests.id
    where lines.request_id = v_request.id
      and not lines.unlinked_funding_only
    order by new_requests.id for update of new_requests
  loop
    v_code := btrim(coalesce(p_new_project_codes ->> v_new_request.id::text, ''));
    if char_length(v_code) not between 3 and 100
       or v_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$' then
      raise exception using errcode = '22023', message =
        format('%s 신규사업의 공식 사업코드를 입력해 주세요.', v_new_request.project_name);
    end if;
    if exists (select 1 from public.projects where project_code = v_code or project_id = v_code)
       or exists (
         select 1 from public.financial_new_project_requests as other
         where other.id <> v_new_request.id and other.official_project_code = v_code
       ) then
      raise exception using errcode = '23505', message =
        '공식 사업코드가 기존 사업 또는 다른 요청과 중복됩니다.';
    end if;
    update public.financial_new_project_requests as new_requests
    set status = 'APPROVED', official_project_code = v_code,
        approved_by = v_actor_id, approved_at = clock_timestamp()
    where new_requests.id = v_new_request.id;
  end loop;
  update public.financial_budget_change_requests as requests
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);

  select settings.budget_change_auto_apply into v_auto_apply
  from public.financial_workflow_settings as settings
  where settings.singleton = true;
  if coalesce(v_auto_apply, false) then
    select applied.* into v_applied
    from public.financial_apply_budget_change_request(v_request.id) as applied;
    return query select v_applied.request_id, v_applied.status;
    return;
  end if;
  return query select v_request.id, v_request.status;
end;
$$;

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
  v_auto_apply boolean;
  v_applied record;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
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
    raise exception using errcode = '23514', message =
      '연결 가능한 신규사업 예정재원이 아닙니다.';
  end if;
  select projects.region_id, projects.year into v_destination_region, v_destination_year
  from public.projects as projects where projects.id = p_destination_project_id;
  if not found or v_destination_region <> v_pending.region_id
     or v_destination_year <> v_pending.planned_project_year then
    raise exception using errcode = '23514', message =
      '예정연도와 지자체가 같은 실제 사업에만 연결할 수 있습니다.';
  end if;
  if v_role = 'local_user' and v_pending.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message =
      '다른 지자체의 예정재원을 연결할 수 없습니다.';
  end if;
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'pending_fund_id', p_pending_fund_id,
    'destination_project_id', p_destination_project_id,
    'amount', v_pending.amount
  ));
  insert into public.financial_pending_new_project_link_requests (
    pending_fund_id, region_id, destination_project_id, amount, status,
    idempotency_key, request_fingerprint, requested_by
  ) values (
    v_pending.id, v_pending.region_id, p_destination_project_id, v_pending.amount,
    'SUBMITTED', p_idempotency_key, v_fingerprint, v_actor_id
  ) returning * into v_request;
  perform public.financial_write_audit(
    p_destination_project_id, v_pending.region_id,
    'PENDING_NEW_PROJECT_LINK_SUBMITTED',
    'financial_pending_new_project_link_requests', v_request.id, v_actor_id,
    jsonb_build_object('pending_fund_id', v_pending.id, 'amount', v_pending.amount)
  );

  select settings.budget_change_auto_apply into v_auto_apply
  from public.financial_workflow_settings as settings
  where settings.singleton = true;
  if coalesce(v_auto_apply, false) then
    update public.financial_pending_new_project_link_requests as requests
    set status = 'APPROVED', approval_mode = 'AUTO',
        approved_by = v_actor_id, approved_at = clock_timestamp()
    where requests.id = v_request.id returning requests.* into v_request;
    perform set_config(
      'app.financial_pending_link_auto_request_id', v_request.id::text, true
    );
    select applied.* into v_applied
    from public.financial_apply_pending_new_project_link(v_request.id) as applied;
    return query select v_applied.request_id, v_applied.status;
    return;
  end if;
  return query select v_request.id, v_request.status;
end;
$$;

-- Corrections are append-only links between the original materialization, its
-- reversal, and the replacement materialization.
create table public.financial_budget_change_destination_corrections (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.financial_budget_change_requests(id) on delete restrict,
  line_id uuid not null references public.financial_budget_change_request_lines(id) on delete restrict,
  sequence_no integer not null check (sequence_no between 1 and 100),
  original_destination_project_id uuid not null references public.projects(id) on delete restrict,
  replacement_destination_project_id uuid not null references public.projects(id) on delete restrict,
  amount bigint not null check (amount > 0),
  original_materialization_kind text not null
    check (original_materialization_kind in ('TRANSFER', 'UNALLOCATED_MOVEMENT')),
  original_materialization_id uuid not null,
  reversal_materialization_id uuid not null,
  replacement_materialization_kind text not null
    check (replacement_materialization_kind in ('TRANSFER', 'UNALLOCATED_MOVEMENT')),
  replacement_materialization_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  effective_date date not null,
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (line_id, sequence_no),
  unique (original_materialization_kind, original_materialization_id),
  constraint financial_budget_change_correction_destination_check check (
    original_destination_project_id <> replacement_destination_project_id
  ),
  constraint financial_budget_change_correction_kind_check check (
    original_materialization_kind = replacement_materialization_kind
  )
);

create index financial_budget_change_corrections_request_idx
  on public.financial_budget_change_destination_corrections(request_id, line_id, sequence_no desc);
create index financial_budget_change_corrections_destination_idx
  on public.financial_budget_change_destination_corrections(replacement_destination_project_id, created_at desc);

create or replace function public.financial_prevent_budget_change_correction_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message =
    '적용된 예산이관 정정 기록은 수정하거나 삭제할 수 없습니다. 새 정정 기록을 추가해 주세요.';
end;
$$;

create trigger financial_budget_change_corrections_immutable
before update or delete on public.financial_budget_change_destination_corrections
for each row execute function public.financial_prevent_budget_change_correction_mutation();

-- A budget-change transfer is also the canonical record for a decrease
-- classification. Reversing only the transfer would violate the deferred
-- classification-link guard and would make the source decrease disappear.
-- Replace the old classification with an equal classification linked to the
-- replacement transfer so the source decrease total remains unchanged.
create or replace function public.financial_reclassify_budget_change_destination_transfer(
  p_original_transfer_id uuid,
  p_reversal_transfer_id uuid,
  p_replacement_transfer_id uuid,
  p_actor_id uuid,
  p_correction_idempotency_key uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_classification public.financial_project_decrease_classifications%rowtype;
  v_original public.project_fund_transfers%rowtype;
  v_reversal public.project_fund_transfers%rowtype;
  v_replacement public.project_fund_transfers%rowtype;
  v_current_decrease bigint;
  v_reversal_classification_id uuid;
begin
  select classifications.* into v_classification
  from public.financial_project_decrease_classifications as classifications
  where classifications.transfer_id = p_original_transfer_id
  for update;
  if not found then
    raise exception using errcode = '23514', message =
      '원 예산이관의 감액 분류를 찾을 수 없습니다.';
  end if;
  select transfers.* into v_original
  from public.project_fund_transfers as transfers
  where transfers.id = p_original_transfer_id;
  select transfers.* into v_reversal
  from public.project_fund_transfers as transfers
  where transfers.id = p_reversal_transfer_id;
  select transfers.* into v_replacement
  from public.project_fund_transfers as transfers
  where transfers.id = p_replacement_transfer_id;
  if v_original.id is null or v_reversal.id is null or v_replacement.id is null
     or v_reversal.transaction_kind <> 'REVERSAL'
     or v_reversal.reversal_of <> v_original.id
     or v_replacement.transaction_kind <> 'NORMAL'
     or v_original.source_budget_year_id <> v_replacement.source_budget_year_id
     or v_original.amount <> v_reversal.amount
     or v_original.amount <> v_replacement.amount
     or v_original.record_origin <> v_reversal.record_origin
     or v_original.record_origin <> v_replacement.record_origin
     or v_original.evidence_id is distinct from v_reversal.evidence_id
     or v_original.evidence_id is distinct from v_replacement.evidence_id then
    raise exception using errcode = '23514', message =
      '목적지 정정 이관과 감액 분류의 연결 정보가 일치하지 않습니다.';
  end if;
  select coalesce(sum(effects.classification_effect), 0)::bigint
    into v_current_decrease
  from public.financial_project_decrease_classification_effects as effects
  where effects.source_project_id = v_classification.source_project_id;
  if v_current_decrease < v_classification.amount then
    raise exception using errcode = '23514', message =
      '목적지 정정 전 현재 감액 분류 금액을 확인할 수 없습니다.';
  end if;

  insert into public.financial_project_decrease_classification_reversals (
    classification_id, region_id, fiscal_year, budget_cohort_id,
    source_project_id, source_budget_year_id, amount,
    decrease_amount_before, decrease_amount_after,
    canonical_table, canonical_record_id, transfer_id,
    record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
  ) values (
    v_classification.id, v_classification.region_id, v_classification.fiscal_year,
    v_classification.budget_cohort_id, v_classification.source_project_id,
    v_classification.source_budget_year_id, v_classification.amount,
    v_current_decrease, v_current_decrease - v_classification.amount,
    'project_fund_transfers', v_reversal.id, v_reversal.id,
    v_reversal.record_origin, v_reversal.evidence_id, gen_random_uuid(),
    public.financial_request_fingerprint(jsonb_build_object(
      'correction_idempotency_key', p_correction_idempotency_key,
      'phase', 'CLASSIFICATION_REVERSAL',
      'classification_id', v_classification.id,
      'transfer_id', v_reversal.id
    )), p_actor_id
  ) returning id into v_reversal_classification_id;

  insert into public.financial_project_decrease_classifications (
    region_id, fiscal_year, budget_cohort_id, source_project_id,
    source_budget_year_id, outcome_type, amount,
    decrease_amount_before, decrease_amount_after,
    canonical_table, canonical_record_id, transfer_id,
    record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
  ) values (
    v_classification.region_id, v_classification.fiscal_year,
    v_classification.budget_cohort_id, v_classification.source_project_id,
    v_classification.source_budget_year_id, 'EXISTING_PROJECT_TRANSFER',
    v_classification.amount,
    v_current_decrease - v_classification.amount, v_current_decrease,
    'project_fund_transfers', v_replacement.id, v_replacement.id,
    v_replacement.record_origin, v_replacement.evidence_id, gen_random_uuid(),
    public.financial_request_fingerprint(jsonb_build_object(
      'correction_idempotency_key', p_correction_idempotency_key,
      'phase', 'REPLACEMENT_CLASSIFICATION',
      'reversed_classification_id', v_classification.id,
      'reversal_classification_id', v_reversal_classification_id,
      'transfer_id', v_replacement.id
    )), p_actor_id
  );
end;
$$;

create or replace function public.financial_correct_budget_change_destination(
  p_line_id uuid,
  p_replacement_project_id uuid,
  p_reason text,
  p_effective_date date,
  p_idempotency_key uuid
)
returns table (
  correction_id uuid,
  request_id uuid,
  line_id uuid,
  destination_project_id uuid,
  status text
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
  v_request public.financial_budget_change_requests%rowtype;
  v_line public.financial_budget_change_request_lines%rowtype;
  v_previous public.financial_budget_change_destination_corrections%rowtype;
  v_existing public.financial_budget_change_destination_corrections%rowtype;
  v_transfer public.project_fund_transfers%rowtype;
  v_movement public.financial_unallocated_fund_movements%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_current_project_id uuid;
  v_current_project_year integer;
  v_replacement_region_id uuid;
  v_replacement_year integer;
  v_replacement_budget_year_id uuid;
  v_materialization_kind text;
  v_materialization_id uuid;
  v_reversed_amount bigint;
  v_reversal_id uuid;
  v_replacement_id uuid;
  v_sequence_no integer;
  v_fingerprint text;
  v_correction public.financial_budget_change_destination_corrections%rowtype;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  if p_line_id is null or p_replacement_project_id is null
     or p_idempotency_key is null or p_effective_date is null
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      '변경할 사업, 변경일, 변경 사유를 모두 입력해 주세요.';
  end if;
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'budget_change_line_id', p_line_id,
    'replacement_project_id', p_replacement_project_id,
    'reason', btrim(p_reason),
    'effective_date', p_effective_date
  ));
  select corrections.* into v_existing
  from public.financial_budget_change_destination_corrections as corrections
  where corrections.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message =
        '요청 식별키가 다른 사용자에게 속해 있습니다.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_existing.request_fingerprint, v_fingerprint,
      'financial_budget_change_destination_corrections'
    );
    return query select v_existing.id, v_existing.request_id, v_existing.line_id,
      v_existing.replacement_destination_project_id, 'APPLIED'::text;
    return;
  end if;

  select lines.* into v_line
  from public.financial_budget_change_request_lines as lines
  where lines.id = p_line_id
  for update;
  if not found then
    raise exception using errcode = '23514', message =
      '반영 완료된 예산이관 목적지만 변경할 수 있습니다.';
  end if;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = v_line.request_id
  for update;
  if not found or v_request.status <> 'APPLIED' then
    raise exception using errcode = '23514', message =
      '반영 완료된 예산이관 목적지만 변경할 수 있습니다.';
  end if;
  if v_role = 'local_user' and v_request.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message =
      '다른 지자체의 예산이관을 변경할 수 없습니다.';
  end if;
  perform public.financial_assert_funding_origin_evidence(
    v_request.region_id, 'SYSTEM_NATIVE', p_effective_date, null
  );

  select corrections.* into v_previous
  from public.financial_budget_change_destination_corrections as corrections
  where corrections.line_id = v_line.id
  order by corrections.sequence_no desc
  limit 1 for update;
  if found then
    v_sequence_no := v_previous.sequence_no + 1;
    v_current_project_id := v_previous.replacement_destination_project_id;
    v_materialization_kind := v_previous.replacement_materialization_kind;
    v_materialization_id := v_previous.replacement_materialization_id;
  elsif v_line.materialized_transfer_id is not null then
    v_sequence_no := 1;
    v_current_project_id := v_line.destination_project_id;
    v_materialization_kind := 'TRANSFER';
    v_materialization_id := v_line.materialized_transfer_id;
  elsif v_line.materialized_lot_id is not null then
    v_sequence_no := 1;
    select movements.* into v_movement
    from public.financial_unallocated_fund_movements as movements
    where movements.lot_id = v_line.materialized_lot_id
      and movements.transaction_kind = 'NORMAL'
      and movements.movement_type in ('ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT')
      and movements.amount - coalesce((
        select sum(reversals.amount)
        from public.financial_unallocated_fund_movements as reversals
        where reversals.reversal_of = movements.id
          and reversals.transaction_kind = 'REVERSAL'
      ), 0) = v_line.amount
    order by movements.created_at desc, movements.id desc
    limit 1 for update of movements;
    if found then
      v_current_project_id := v_movement.destination_project_id;
      v_materialization_kind := 'UNALLOCATED_MOVEMENT';
      v_materialization_id := v_movement.id;
    end if;
  end if;
  if v_materialization_id is null or v_current_project_id is null then
    raise exception using errcode = '23514', message =
      '아직 사업에 연결되지 않은 예정재원은 목적지 변경 대상이 아닙니다.';
  end if;
  if v_current_project_id = p_replacement_project_id
     or v_request.source_project_id = p_replacement_project_id then
    raise exception using errcode = '23514', message =
      '현재 목적지나 출처 사업으로는 변경할 수 없습니다.';
  end if;
  select projects.year into v_current_project_year
  from public.projects as projects where projects.id = v_current_project_id;
  select projects.region_id, projects.year into v_replacement_region_id, v_replacement_year
  from public.projects as projects
  where projects.id = p_replacement_project_id and projects.project_code is not null;
  if not found or v_replacement_region_id <> v_request.region_id
     or v_replacement_year is distinct from v_current_project_year then
    raise exception using errcode = '23514', message =
      '현재 목적지와 지자체 및 사업연도가 같은 등록 사업으로만 변경할 수 있습니다.';
  end if;

  if (select environment_kind = 'TEST' from public.financial_ledger_runtime where singleton = true) then
    perform public.financial_test_uat_bootstrap_project(p_replacement_project_id);
  end if;

  if v_materialization_kind = 'TRANSFER' then
    select transfers.* into v_transfer
    from public.project_fund_transfers as transfers
    where transfers.id = v_materialization_id
      and transfers.status = 'CONFIRMED'
      and transfers.transaction_kind = 'NORMAL'
    for update;
    if not found or v_transfer.amount <> v_line.amount then
      raise exception using errcode = '23514', message =
        '원 이관금액과 변경 대상 금액이 일치하지 않습니다.';
    end if;
    select coalesce(sum(reversals.amount), 0)::bigint into v_reversed_amount
    from public.project_fund_transfers as reversals
    where reversals.reversal_of = v_transfer.id
      and reversals.transaction_kind = 'REVERSAL'
      and reversals.status = 'CONFIRMED';
    if v_reversed_amount <> 0 then
      raise exception using errcode = '23514', message =
        '이미 취소되거나 일부 정정된 이관은 다시 변경할 수 없습니다.';
    end if;
    -- The cohort and fiscal year come from the original source wallet. Keeping
    -- them here prevents a correction from changing accounting lineage.
    select public.financial_get_or_create_budget_year(
      p_replacement_project_id, source_wallet.budget_cohort_id,
      source_wallet.fiscal_year, v_actor_id
    ) into v_replacement_budget_year_id
    from public.project_budget_years as source_wallet
    where source_wallet.id = v_transfer.source_budget_year_id;
    perform 1 from public.project_budget_years as wallets
    where wallets.id = any(array[
      v_transfer.source_budget_year_id,
      v_transfer.destination_budget_year_id,
      v_replacement_budget_year_id
    ]) order by wallets.id for update;
    perform public.financial_require_available_amount(
      v_transfer.destination_budget_year_id, v_line.amount,
      '기존 목적지 사업이 이관받은 금액을 이미 집행하거나 사용하여 변경할 수 없습니다.'
    );
    insert into public.project_fund_transfers (
      source_budget_year_id, destination_budget_year_id, amount, status,
      transaction_kind, reversal_of, reason_code, memo, effective_date,
      idempotency_key, created_by, submitted_at, confirmed_by, confirmed_at,
      record_origin, evidence_id, request_fingerprint
    ) values (
      v_transfer.destination_budget_year_id, v_transfer.source_budget_year_id,
      v_line.amount, 'CONFIRMED', 'REVERSAL', v_transfer.id,
      'BUDGET_REALLOCATION_CORRECTION', btrim(p_reason), p_effective_date,
      gen_random_uuid(), v_actor_id, clock_timestamp(), v_actor_id, clock_timestamp(),
      'SYSTEM_NATIVE', null,
      public.financial_request_fingerprint(jsonb_build_object(
        'correction_idempotency_key', p_idempotency_key,
        'phase', 'REVERSAL', 'original_transfer_id', v_transfer.id
      ))
    ) returning id into v_reversal_id;
    insert into public.project_fund_transfers (
      source_budget_year_id, destination_budget_year_id, amount, status,
      transaction_kind, reason_code, memo, effective_date,
      idempotency_key, created_by, submitted_at, confirmed_by, confirmed_at,
      record_origin, evidence_id, request_fingerprint
    ) values (
      v_transfer.source_budget_year_id, v_replacement_budget_year_id,
      v_line.amount, 'CONFIRMED', 'NORMAL',
      'BUDGET_REALLOCATION_CORRECTION', btrim(p_reason), p_effective_date,
      gen_random_uuid(), v_actor_id, clock_timestamp(), v_actor_id, clock_timestamp(),
      'SYSTEM_NATIVE', null,
      public.financial_request_fingerprint(jsonb_build_object(
        'correction_idempotency_key', p_idempotency_key,
        'phase', 'REPLACEMENT', 'replacement_project_id', p_replacement_project_id
      ))
    ) returning id into v_replacement_id;
    perform public.financial_reclassify_budget_change_destination_transfer(
      v_transfer.id, v_reversal_id, v_replacement_id,
      v_actor_id, p_idempotency_key
    );
  else
    select movements.* into v_movement
    from public.financial_unallocated_fund_movements as movements
    where movements.id = v_materialization_id
      and movements.transaction_kind = 'NORMAL'
      and movements.movement_type in ('ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT')
    for update;
    if not found or v_movement.amount <> v_line.amount then
      raise exception using errcode = '23514', message =
        '원 예정재원 배분액과 변경 대상 금액이 일치하지 않습니다.';
    end if;
    select coalesce(sum(reversals.amount), 0)::bigint into v_reversed_amount
    from public.financial_unallocated_fund_movements as reversals
    where reversals.reversal_of = v_movement.id
      and reversals.transaction_kind = 'REVERSAL';
    if v_reversed_amount <> 0 then
      raise exception using errcode = '23514', message =
        '이미 취소되거나 일부 정정된 예정재원 배분은 다시 변경할 수 없습니다.';
    end if;
    select lots.* into v_lot
    from public.financial_unallocated_fund_lots as lots
    where lots.id = v_movement.lot_id for update;
    v_replacement_budget_year_id := public.financial_get_or_create_budget_year(
      p_replacement_project_id, v_lot.budget_cohort_id, v_lot.fiscal_year, v_actor_id
    );
    perform 1 from public.project_budget_years as wallets
    where wallets.id = any(array[
      v_movement.destination_budget_year_id, v_replacement_budget_year_id
    ]) order by wallets.id for update;
    perform public.financial_require_available_amount(
      v_movement.destination_budget_year_id, v_line.amount,
      '기존 목적지 사업이 이관받은 금액을 이미 집행하거나 사용하여 변경할 수 없습니다.'
    );
    insert into public.financial_unallocated_fund_movements (
      lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
      reversal_of, destination_project_id, destination_budget_year_id,
      new_project_request_id, amount, effective_date, record_origin, evidence_id,
      memo, idempotency_key, request_fingerprint, created_by, confirmed_by
    ) values (
      v_movement.lot_id, v_movement.region_id, v_movement.budget_cohort_id,
      v_movement.movement_type, 'REVERSAL', v_movement.id,
      v_movement.destination_project_id, v_movement.destination_budget_year_id,
      v_movement.new_project_request_id, v_line.amount, p_effective_date,
      'SYSTEM_NATIVE', null, btrim(p_reason), gen_random_uuid(),
      public.financial_request_fingerprint(jsonb_build_object(
        'correction_idempotency_key', p_idempotency_key,
        'phase', 'REVERSAL', 'original_movement_id', v_movement.id
      )), v_actor_id, v_actor_id
    ) returning id into v_reversal_id;
    if public.financial_lock_unallocated_lot_remaining(v_lot.id) < v_line.amount then
      raise exception using errcode = '23514', message =
        '취소 후 예정재원 잔액이 변경금액보다 작습니다.';
    end if;
    insert into public.financial_unallocated_fund_movements (
      lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
      destination_project_id, destination_budget_year_id,
      amount, effective_date, record_origin, evidence_id, memo,
      idempotency_key, request_fingerprint, created_by, confirmed_by
    ) values (
      v_lot.id, v_lot.region_id, v_lot.budget_cohort_id,
      'ALLOCATE_EXISTING_PROJECT', 'NORMAL', p_replacement_project_id,
      v_replacement_budget_year_id, v_line.amount, p_effective_date,
      'SYSTEM_NATIVE', null, btrim(p_reason), gen_random_uuid(),
      public.financial_request_fingerprint(jsonb_build_object(
        'correction_idempotency_key', p_idempotency_key,
        'phase', 'REPLACEMENT', 'replacement_project_id', p_replacement_project_id
      )), v_actor_id, v_actor_id
    ) returning id into v_replacement_id;
    if v_line.pending_fund_id is not null then
      update public.financial_pending_new_project_funds as pending
      set status = 'LINKED', linked_project_id = p_replacement_project_id,
          linked_movement_id = v_replacement_id, linked_by = v_actor_id,
          linked_at = clock_timestamp()
      where pending.id = v_line.pending_fund_id;
    end if;
  end if;

  insert into public.financial_budget_change_destination_corrections (
    request_id, line_id, sequence_no,
    original_destination_project_id, replacement_destination_project_id,
    amount, original_materialization_kind, original_materialization_id,
    reversal_materialization_id, replacement_materialization_kind,
    replacement_materialization_id, reason, effective_date,
    idempotency_key, request_fingerprint, requested_by
  ) values (
    v_request.id, v_line.id, v_sequence_no,
    v_current_project_id, p_replacement_project_id,
    v_line.amount, v_materialization_kind, v_materialization_id,
    v_reversal_id, v_materialization_kind,
    v_replacement_id, btrim(p_reason), p_effective_date,
    p_idempotency_key, v_fingerprint, v_actor_id
  ) returning * into v_correction;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_DESTINATION_CORRECTED',
    'financial_budget_change_destination_corrections',
    v_correction.id, v_actor_id,
    jsonb_build_object(
      'request_id', v_request.id, 'line_id', v_line.id,
      'sequence_no', v_sequence_no, 'amount', v_line.amount,
      'from_project_id', v_current_project_id,
      'to_project_id', p_replacement_project_id,
      'materialization_kind', v_materialization_kind,
      'reversal_id', v_reversal_id,
      'replacement_id', v_replacement_id,
      'reason', btrim(p_reason)
    )
  );
  return query select v_correction.id, v_request.id, v_line.id,
    p_replacement_project_id, 'APPLIED'::text;
end;
$$;

create or replace function public.get_financial_budget_change_destination_states(
  p_project_id uuid
)
returns table (
  request_id uuid,
  line_id uuid,
  current_destination_project_id uuid,
  current_destination_project_code text,
  current_destination_project_name text,
  correction_count bigint,
  correction_allowed boolean,
  correction_block_reason text,
  last_correction_reason text,
  last_corrected_at timestamptz
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
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  if not exists (
    select 1 from public.projects as projects
    where projects.id = p_project_id
      and (v_role = 'admin' or projects.region_id = v_actor_region_id)
  ) then
    raise exception using errcode = '42501', message = '조회할 수 없는 사업입니다.';
  end if;
  return query
  with line_states as (
    select requests.id as request_id,
      requests.source_project_id,
      requests.region_id,
      requests.status as request_status,
      lines.id as line_id,
      lines.amount,
      lines.destination_project_id as original_destination_project_id,
      coalesce(latest.replacement_destination_project_id,
        transfers_destination.project_id,
        movements.destination_project_id) as current_destination_project_id,
      coalesce(latest.correction_count, 0)::bigint as correction_count,
      latest.reason as last_correction_reason,
      latest.created_at as last_corrected_at,
      coalesce(transfers.destination_budget_year_id,
        movements.destination_budget_year_id) as current_budget_year_id,
      coalesce(transfers.amount, movements.amount, 0)::bigint as materialized_amount,
      coalesce(transfer_reversals.reversed_amount,
        movement_reversals.reversed_amount, 0)::bigint as reversed_amount
    from public.financial_budget_change_requests as requests
    join public.financial_budget_change_request_lines as lines
      on lines.request_id = requests.id
    left join lateral (
      select corrections.replacement_destination_project_id,
        corrections.replacement_materialization_kind,
        corrections.replacement_materialization_id,
        corrections.reason, corrections.created_at,
        count(*) over ()::bigint as correction_count
      from public.financial_budget_change_destination_corrections as corrections
      where corrections.line_id = lines.id
      order by corrections.sequence_no desc
      limit 1
    ) as latest on true
    left join public.project_fund_transfers as transfers
      on transfers.id = case
        when latest.replacement_materialization_kind = 'TRANSFER'
          then latest.replacement_materialization_id
        when latest.replacement_materialization_kind is null
          then lines.materialized_transfer_id
        else null
      end
    left join public.project_budget_years as transfers_destination
      on transfers_destination.id = transfers.destination_budget_year_id
    left join lateral (
      select candidate.*
      from public.financial_unallocated_fund_movements as candidate
      where candidate.id = case
          when latest.replacement_materialization_kind = 'UNALLOCATED_MOVEMENT'
            then latest.replacement_materialization_id
          else null
        end
        or (latest.replacement_materialization_kind is null
          and candidate.lot_id = lines.materialized_lot_id
          and candidate.transaction_kind = 'NORMAL'
          and candidate.movement_type in ('ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT'))
      order by case when candidate.id = latest.replacement_materialization_id then 0 else 1 end,
        candidate.created_at desc, candidate.id desc
      limit 1
    ) as movements on true
    left join lateral (
      select coalesce(sum(reversals.amount), 0)::bigint as reversed_amount
      from public.project_fund_transfers as reversals
      where reversals.reversal_of = transfers.id
        and reversals.transaction_kind = 'REVERSAL'
        and reversals.status = 'CONFIRMED'
    ) as transfer_reversals on true
    left join lateral (
      select coalesce(sum(reversals.amount), 0)::bigint as reversed_amount
      from public.financial_unallocated_fund_movements as reversals
      where reversals.reversal_of = movements.id
        and reversals.transaction_kind = 'REVERSAL'
    ) as movement_reversals on true
    where v_role = 'admin' or requests.region_id = v_actor_region_id
  ), states_with_balance as (
    select states.*,
      case when states.current_budget_year_id is null then 0::bigint
        else coalesce((
          select balance.accounting_balance::bigint
          from public.financial_get_budget_year_balance(
            states.current_budget_year_id
          ) as balance
        ), 0)::bigint
      end as available_amount
    from line_states as states
  ), matched_requests as (
    select distinct states.request_id
    from states_with_balance as states
    where states.source_project_id = p_project_id
       or states.original_destination_project_id = p_project_id
       or states.current_destination_project_id = p_project_id
  )
  select states.request_id, states.line_id,
    states.current_destination_project_id,
    projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''),
      nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null
        then '사업명 확인 필요 (' || projects.project_code || ')'
        else '사업명 확인 필요' end)::text,
    states.correction_count,
    (states.request_status = 'APPLIED'
      and states.current_destination_project_id is not null
      and states.materialized_amount - states.reversed_amount = states.amount
      and states.available_amount >= states.amount) as correction_allowed,
    case
      when states.request_status <> 'APPLIED'
        then '반영 완료 후 목적지를 변경할 수 있습니다.'
      when states.current_destination_project_id is null
        then '아직 실제 사업에 연결되지 않은 예정재원입니다.'
      when states.materialized_amount - states.reversed_amount <> states.amount
        then '이미 취소되거나 일부 정정된 이관입니다.'
      when states.available_amount < states.amount
        then '목적지 사업이 이관받은 금액을 이미 집행하거나 사용했습니다.'
      else null
    end::text,
    states.last_correction_reason,
    states.last_corrected_at
  from states_with_balance as states
  join matched_requests on matched_requests.request_id = states.request_id
  left join public.projects as projects
    on projects.id = states.current_destination_project_id
  order by states.request_id, states.line_id;
end;
$$;

alter table public.financial_workflow_settings enable row level security;
alter table public.financial_workflow_setting_events enable row level security;
alter table public.financial_budget_change_destination_corrections enable row level security;

create policy financial_workflow_settings_select_authenticated
  on public.financial_workflow_settings for select to authenticated using (true);
create policy financial_workflow_setting_events_select_admin
  on public.financial_workflow_setting_events for select to authenticated using (
    exists (
      select 1 from public.profiles as profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );
create policy financial_budget_change_corrections_select_region_or_admin
  on public.financial_budget_change_destination_corrections
  for select to authenticated using (
    exists (
      select 1
      from public.financial_budget_change_requests as requests
      join public.profiles as profiles on profiles.id = auth.uid()
      where requests.id = financial_budget_change_destination_corrections.request_id
        and (profiles.role = 'admin' or profiles.region_id = requests.region_id)
    )
  );

revoke all on table public.financial_workflow_settings,
  public.financial_workflow_setting_events,
  public.financial_budget_change_destination_corrections
  from public, anon, authenticated;
grant select on table public.financial_workflow_settings,
  public.financial_workflow_setting_events,
  public.financial_budget_change_destination_corrections
  to authenticated;

revoke all on function public.financial_set_budget_change_auto_apply(boolean,text)
  from public, anon;
grant execute on function public.financial_set_budget_change_auto_apply(boolean,text)
  to authenticated;
revoke all on function public.get_financial_budget_change_workflow_mode()
  from public, anon;
grant execute on function public.get_financial_budget_change_workflow_mode()
  to authenticated;
revoke all on function public.financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)
  from public, anon;
grant execute on function public.financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)
  to authenticated;
revoke all on function public.get_financial_budget_change_destination_states(uuid)
  from public, anon;
grant execute on function public.get_financial_budget_change_destination_states(uuid)
  to authenticated;
revoke all on function public.financial_prevent_budget_change_correction_mutation()
  from public, anon, authenticated;
revoke all on function public.financial_reclassify_budget_change_destination_transfer(
  uuid,uuid,uuid,uuid,uuid
) from public, anon, authenticated, service_role;

-- Preserve the existing grants for the replaced public workflow entry points.
revoke all on function public.financial_submit_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_submit_budget_change_request(uuid)
  to authenticated;
revoke all on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  from public, anon;
grant execute on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  to authenticated;
revoke all on function public.financial_request_pending_new_project_link(uuid,uuid,uuid)
  from public, anon;
grant execute on function public.financial_request_pending_new_project_link(uuid,uuid,uuid)
  to authenticated;

do $$
declare
  v_before budget_change_auto_apply_install_snapshot%rowtype;
  v_after budget_change_auto_apply_install_snapshot%rowtype;
begin
  select * into v_before from budget_change_auto_apply_install_snapshot;
  select
    (select count(*) from public.project_fund_transfers)::bigint,
    (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric,
    (select count(*) from public.financial_project_decrease_classifications)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_project_decrease_classifications)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '자동승인 설치 중 기존 원장 행 또는 금액이 변경되었습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
