-- TEST-only duplicate-submit and request state-machine hardening.
-- Monetary rows are neither inserted, updated, nor deleted by this migration.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select runtime.* into v_runtime
  from public.financial_ledger_runtime as runtime
  where runtime.singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regprocedure('public.financial_reject_budget_change_request(uuid,text)') is null
     or to_regprocedure('public.get_financial_budget_change_requests(uuid,text,integer,uuid)') is null then
    raise exception using errcode = '55000', message =
      'Budget-adjustment idempotency hotfix is pinned to the approved TEST engine.';
  end if;
  if exists (
    select 1 from information_schema.columns as columns
    where columns.table_schema = 'public'
      and columns.table_name = 'financial_budget_change_requests'
      and columns.column_name = 'adjustment_fingerprint'
  ) then
    raise exception using errcode = '55000', message =
      'Budget-adjustment idempotency hotfix columns already exist.';
  end if;
end;
$$;

create temporary table financial_budget_adjustment_hotfix_snapshot on commit drop as
select
  (select count(*) from public.financial_budget_change_requests)::bigint as request_count,
  (select count(*) from public.financial_budget_change_request_lines)::bigint as line_count,
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select coalesce(sum(transfers.amount), 0) from public.project_fund_transfers as transfers)::numeric as transfer_amount,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select coalesce(sum(movements.amount), 0) from public.financial_unallocated_fund_movements as movements)::numeric as movement_amount,
  (select count(*) from public.projects)::bigint as project_count,
  (select coalesce(sum(projects.alloc), 0) from public.projects)::numeric as project_allocation,
  (select coalesce(sum(projects.exec), 0) from public.projects)::numeric as project_execution;

alter table public.financial_budget_change_requests
  add column source_adjustment_revision bigint,
  add column draft_revision_id uuid,
  add column adjustment_fingerprint text,
  add column duplicate_of_request_id uuid
    references public.financial_budget_change_requests(id) on delete restrict;

create or replace function public.financial_budget_change_canonical_destinations(
  p_destinations jsonb
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(canonical.item order by canonical.item::text), '[]'::jsonb)
  from (
    select jsonb_strip_nulls(case
      when upper(destination.value ->> 'destination_type') = 'EXISTING_PROJECT' then
        jsonb_build_object(
          'destination_type', 'EXISTING_PROJECT',
          'destination_project_id', lower(destination.value ->> 'destination_project_id'),
          'amount', ((destination.value ->> 'amount')::numeric)::text
        )
      else
        jsonb_build_object(
          'destination_type', 'PENDING_NEW_PROJECT',
          'amount', ((destination.value ->> 'amount')::numeric)::text,
          'planned_project_name', lower(btrim(destination.value ->> 'planned_project_name')),
          'planned_project_year', (destination.value ->> 'planned_project_year')::integer,
          'planned_fund_project_name', lower(nullif(btrim(destination.value ->> 'planned_fund_project_name'), '')),
          'planned_detail_project_name', lower(nullif(btrim(destination.value ->> 'planned_detail_project_name'), '')),
          'planned_project_period', nullif(btrim(destination.value ->> 'planned_project_period'), ''),
          'planned_project_start_year', (destination.value ->> 'planned_project_start_year')::integer,
          'planned_project_end_year', (destination.value ->> 'planned_project_end_year')::integer,
          'planned_project_status', nullif(btrim(destination.value ->> 'planned_project_status'), ''),
          'planned_business_type', upper(nullif(btrim(destination.value ->> 'planned_business_type'), '')),
          'planned_large_category_id', lower(nullif(destination.value ->> 'planned_large_category_id', '')),
          'planned_middle_category_id', lower(nullif(destination.value ->> 'planned_middle_category_id', '')),
          'registered_project_reference', case
            when coalesce(destination.value ->> 'note', '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
              then lower(substring(destination.value ->> 'note' from 30))
            else null end
        )
      end) as item
    from jsonb_array_elements(p_destinations) as destination(value)
  ) as canonical;
$$;

create or replace function public.financial_budget_change_adjustment_fingerprint(
  p_source_project_id uuid,
  p_source_budget_year_id uuid,
  p_source_adjustment_revision bigint,
  p_total_amount bigint,
  p_destinations jsonb,
  p_effective_date date
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.financial_request_fingerprint(jsonb_build_object(
    'request_context', 'BUDGET_CHANGE_V2',
    'source_project_id', p_source_project_id,
    'source_budget_year_id', p_source_budget_year_id,
    'source_adjustment_revision', p_source_adjustment_revision,
    'total_amount', p_total_amount,
    'effective_date', p_effective_date,
    'destinations', public.financial_budget_change_canonical_destinations(p_destinations)
  ));
$$;

create or replace function public.financial_budget_change_request_adjustment_fingerprint(
  p_request_id uuid
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.financial_budget_change_adjustment_fingerprint(
    requests.source_project_id,
    requests.source_budget_year_id,
    requests.decrease_amount_before,
    requests.total_amount,
    coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'destination_type', lines.destination_type,
        'destination_project_id', lines.destination_project_id,
        'amount', lines.amount::text,
        'planned_project_name', lines.planned_project_name,
        'planned_project_year', lines.planned_project_year,
        'planned_fund_project_name', lines.planned_fund_project_name,
        'planned_detail_project_name', lines.planned_detail_project_name,
        'planned_project_period', lines.planned_project_period,
        'planned_project_start_year', lines.planned_project_start_year,
        'planned_project_end_year', lines.planned_project_end_year,
        'planned_project_status', lines.planned_project_status,
        'planned_business_type', lines.planned_business_type,
        'planned_large_category_id', lines.planned_large_category_id,
        'planned_middle_category_id', lines.planned_middle_category_id,
        'note', lines.note
      )) order by lines.line_no)
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = requests.id
    ), '[]'::jsonb),
    requests.effective_date
  )
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id;
$$;

update public.financial_budget_change_requests as requests
set source_adjustment_revision = requests.decrease_amount_before,
    draft_revision_id = requests.idempotency_key,
    adjustment_fingerprint =
      public.financial_budget_change_request_adjustment_fingerprint(requests.id),
    duplicate_of_request_id = null;

with ranked as (
  select requests.id,
    first_value(requests.id) over (
      partition by requests.adjustment_fingerprint
      order by case requests.status
        when 'APPLIED' then 1 when 'APPROVED' then 2 when 'SUBMITTED' then 3 else 4 end,
        requests.requested_at, requests.id
    ) as canonical_id,
    row_number() over (
      partition by requests.adjustment_fingerprint
      order by case requests.status
        when 'APPLIED' then 1 when 'APPROVED' then 2 when 'SUBMITTED' then 3 else 4 end,
        requests.requested_at, requests.id
    ) as duplicate_rank
  from public.financial_budget_change_requests as requests
  where requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
)
update public.financial_budget_change_requests as requests
set duplicate_of_request_id = ranked.canonical_id
from ranked
where ranked.id = requests.id and ranked.duplicate_rank > 1;

alter table public.financial_budget_change_requests
  alter column source_adjustment_revision set not null,
  alter column draft_revision_id set not null,
  alter column adjustment_fingerprint set not null,
  add constraint financial_budget_change_source_revision_check
    check (source_adjustment_revision >= 0),
  add constraint financial_budget_change_adjustment_fingerprint_check
    check (adjustment_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint financial_budget_change_duplicate_not_self_check
    check (duplicate_of_request_id is null or duplicate_of_request_id <> id);

create unique index financial_budget_change_active_adjustment_uidx
  on public.financial_budget_change_requests(adjustment_fingerprint)
  where status in ('SUBMITTED', 'APPROVED', 'APPLIED')
    and duplicate_of_request_id is null;

create index financial_budget_change_duplicate_of_idx
  on public.financial_budget_change_requests(duplicate_of_request_id)
  where duplicate_of_request_id is not null;

create or replace function public.financial_guard_budget_change_state_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('DRAFT', 'SUBMITTED') then
      raise exception using errcode = '23514', message =
        '새 예산조정 요청은 작성 중 또는 승인대기 상태로만 생성할 수 있습니다.';
    end if;
    return new;
  end if;
  if new.status = old.status then return new; end if;
  if new.duplicate_of_request_id is not null and new.status in ('APPROVED', 'APPLIED') then
    raise exception using errcode = '23505', message =
      '동일 예산조정이 이미 적용되었거나 처리 중입니다. 중복 요청은 반려해 주세요.';
  end if;
  if not (
    (old.status = 'DRAFT' and new.status = 'SUBMITTED')
    or (old.status = 'SUBMITTED' and new.status in ('APPROVED', 'REJECTED'))
    or (old.status = 'APPROVED' and new.status in ('APPLIED', 'REJECTED'))
  ) then
    raise exception using errcode = '23514', message =
      '허용되지 않은 예산조정 상태 변경입니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists financial_budget_change_state_transition_guard
  on public.financial_budget_change_requests;
create trigger financial_budget_change_state_transition_guard
before insert or update of status, duplicate_of_request_id
on public.financial_budget_change_requests
for each row execute function public.financial_guard_budget_change_state_transition();

create or replace function public.financial_test_uat_create_budget_change_request(
  p_source_project_id uuid,
  p_source_budget_year_id uuid,
  p_destinations jsonb,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_submit boolean default true
)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_bootstrap record;
  v_source_budget_year_id uuid;
  v_source_revision bigint;
  v_total bigint;
  v_adjustment_fingerprint text;
  v_existing public.financial_budget_change_requests%rowtype;
  v_created_id uuid;
  v_created_status text;
  v_gap bigint;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor.actor_id into v_actor_id
  from public.financial_require_actor() as actor;
  if p_idempotency_key is null or p_effective_date is null
     or jsonb_typeof(p_destinations) <> 'array'
     or jsonb_array_length(p_destinations) not between 1 and 20 then
    raise exception using errcode = '22023', message =
      '예산 조정 입력값과 요청 식별키를 확인해 주세요.';
  end if;
  select * into v_bootstrap
  from public.financial_test_uat_bootstrap_project(p_source_project_id);
  if p_source_budget_year_id is not null then
    select wallets.id into v_source_budget_year_id
    from public.project_budget_years as wallets
    where wallets.id = p_source_budget_year_id
      and wallets.project_id = p_source_project_id;
    if not found then
      raise exception using errcode = '23514', message =
        '선택한 출처 재원이 해당 사업과 일치하지 않습니다.';
    end if;
  else
    v_source_budget_year_id := v_bootstrap.source_budget_year_id;
  end if;
  if v_source_budget_year_id is null then
    raise exception using errcode = '23514', message =
      '이 사업에는 감액 가능한 미집행액이 없습니다.';
  end if;
  select coalesce(sum((destination.value ->> 'amount')::bigint), 0)::bigint
    into v_total
  from jsonb_array_elements(p_destinations) as destination(value);
  v_source_revision := public.financial_budget_change_visible_decrease(p_source_project_id);
  v_adjustment_fingerprint := public.financial_budget_change_adjustment_fingerprint(
    p_source_project_id, v_source_budget_year_id, v_source_revision,
    v_total, p_destinations, p_effective_date
  );
  perform pg_advisory_xact_lock(hashtextextended(v_adjustment_fingerprint, 0));

  select requests.* into v_existing
  from public.financial_budget_change_requests as requests
  where requests.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message =
        '요청 식별키가 다른 사용자에게 속해 있습니다.';
    end if;
    if v_existing.adjustment_fingerprint <> v_adjustment_fingerprint then
      raise exception using errcode = '23505', message =
        '같은 작성본 식별키를 다른 예산조정에 재사용할 수 없습니다.';
    end if;
    if v_existing.status = 'DRAFT' and p_submit then
      return query
      select submitted.request_id, submitted.status, 0::bigint
      from public.financial_submit_budget_change_request(v_existing.id) as submitted;
      return;
    end if;
    raise exception using errcode = '23505', message =
      '이미 승인 요청된 예산조정입니다.';
  end if;

  if p_submit and exists (
    select 1
    from public.financial_budget_change_requests as requests
    where requests.adjustment_fingerprint = v_adjustment_fingerprint
      and requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
  ) then
    raise exception using errcode = '23505', message =
      '동일 예산조정이 이미 승인 요청되었거나 적용되었습니다.';
  end if;

  select created.request_id, created.status, created.gap_amount
    into v_created_id, v_created_status, v_gap
  from public.financial_create_budget_change_request(
    v_source_budget_year_id, p_destinations, p_effective_date,
    p_reason, p_idempotency_key, p_submit
  ) as created;
  update public.financial_budget_change_requests as requests
  set source_adjustment_revision = v_source_revision,
      draft_revision_id = p_idempotency_key,
      adjustment_fingerprint = v_adjustment_fingerprint,
      duplicate_of_request_id = null
  where requests.id = v_created_id;
  return query select v_created_id, v_created_status, coalesce(v_gap, 0)::bigint;
end;
$$;

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
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id
  for update;
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
  ) then
    raise exception using errcode = '23505', message =
      '동일 예산조정이 이미 승인 요청되었거나 적용되었습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  update public.financial_budget_change_requests as requests
  set status = 'SUBMITTED', submitted_by = v_actor_id,
      submitted_at = clock_timestamp()
  where requests.id = v_request.id
  returning requests.* into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_reject_budget_change_request(
  p_request_id uuid,
  p_reason text
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
  v_previous_status text;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '반려 사유를 입력해 주세요.';
  end if;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '예산조정 요청을 찾을 수 없습니다.';
  end if;
  v_previous_status := v_request.status;
  if v_request.status not in ('SUBMITTED', 'APPROVED')
     or v_request.requested_by = v_actor_id
     or exists (
       select 1
       from public.financial_budget_change_request_lines as lines
       where lines.request_id = v_request.id
         and (lines.materialized_transfer_id is not null
           or lines.materialized_lot_id is not null
           or lines.pending_fund_id is not null)
     ) then
    raise exception using errcode = '42501', message =
      '적용 전인 승인대기·승인 예산조정만 요청자와 다른 관리자가 반려할 수 있습니다.';
  end if;
  update public.financial_new_project_requests as new_requests
  set status = 'REJECTED', official_project_code = null,
      rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where new_requests.source_budget_change_request_id = v_request.id
    and new_requests.status in ('SUBMITTED', 'APPROVED');
  update public.financial_budget_change_requests as requests
  set status = 'REJECTED', rejected_by = v_actor_id,
      rejected_at = clock_timestamp(), rejection_reason = btrim(p_reason)
  where requests.id = v_request.id
  returning requests.* into v_request;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_REJECTED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object(
      'reason', v_request.rejection_reason,
      'previous_status', v_previous_status,
      'duplicate_of_request_id', v_request.duplicate_of_request_id,
      'monetary_effect', 0
    )
  );
  return query select v_request.id, v_request.status;
end;
$$;

-- Keep the existing return signature while projecting legacy duplicates as a
-- non-actionable status for local history and the admin rejection queue.
create or replace function public.get_financial_budget_change_requests(
  p_project_id uuid default null,
  p_status text default null,
  p_year integer default null,
  p_region_id uuid default null
)
returns table (
  id uuid, region_id uuid, fiscal_year integer,
  source_project_id uuid, source_project_code text, source_project_name text,
  total_amount bigint, decrease_amount_before bigint, decrease_amount_after bigint,
  effective_date date, reason text, status text, requested_by uuid,
  requested_at timestamptz, rejection_reason text, destinations jsonb
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
  if v_role = 'local_user' and p_region_id is not null
     and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message =
      '다른 지역의 예산 조정은 조회할 수 없습니다.';
  end if;
  return query
  select requests.id, requests.region_id, requests.fiscal_year,
    requests.source_project_id, source.project_code::text,
    coalesce(nullif(btrim(source.detail_project_name), ''),
      nullif(btrim(source.fund_project_name), ''),
      nullif(btrim(source.project_name), ''),
      case when source.project_code is not null
        then '사업명 확인 필요 (' || source.project_code || ')'
        else '사업명 확인 필요' end)::text,
    requests.total_amount, requests.decrease_amount_before,
    requests.decrease_amount_after, requests.effective_date, requests.reason,
    case when requests.duplicate_of_request_id is not null
          and requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
      then 'DUPLICATE'::text else requests.status end,
    requests.requested_by, requests.requested_at, requests.rejection_reason,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_id', lines.id, 'line_no', lines.line_no,
        'destination_type', lines.destination_type,
        'destination_project_id', lines.destination_project_id,
        'destination_project_code', destination.project_code,
        'destination_project_name', coalesce(
          nullif(btrim(destination.detail_project_name), ''),
          nullif(btrim(destination.fund_project_name), ''),
          nullif(btrim(destination.project_name), ''),
          case when destination.project_code is not null
            then '사업명 확인 필요 (' || destination.project_code || ')' else null end),
        'planned_project_name', lines.planned_project_name,
        'planned_project_year', lines.planned_project_year,
        'planned_fund_project_name', lines.planned_fund_project_name,
        'planned_detail_project_name', lines.planned_detail_project_name,
        'planned_project_period', lines.planned_project_period,
        'planned_project_start_year', lines.planned_project_start_year,
        'planned_project_end_year', lines.planned_project_end_year,
        'planned_project_status', lines.planned_project_status,
        'planned_business_type', lines.planned_business_type,
        'planned_large_category_id', lines.planned_large_category_id,
        'planned_middle_category_id', lines.planned_middle_category_id,
        'amount', lines.amount, 'note', lines.note,
        'pending_fund_id', lines.pending_fund_id,
        'new_project_request_id', new_requests.id,
        'new_project_request_status', new_requests.status,
        'official_project_code', coalesce(
          new_requests.official_project_code, materialized.project_code),
        'materialized_project_id', materialized.id,
        'materialized_project_code', materialized.project_code,
        'materialized_project_name', coalesce(
          nullif(btrim(materialized.detail_project_name), ''),
          nullif(btrim(materialized.fund_project_name), ''),
          nullif(btrim(materialized.project_name), ''),
          case when materialized.project_code is not null
            then '사업명 확인 필요 (' || materialized.project_code || ')' else null end)
      ) order by lines.line_no)
      from public.financial_budget_change_request_lines as lines
      left join public.projects as destination
        on destination.id = lines.destination_project_id
      left join public.financial_new_project_requests as new_requests
        on new_requests.id = lines.new_project_request_id
      left join public.projects as materialized
        on materialized.id = case
          when lines.destination_type = 'EXISTING_PROJECT'
            then lines.destination_project_id
          when coalesce(lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
            then substring(lines.note from 30)::uuid
          else new_requests.materialized_project_id
        end
      where lines.request_id = requests.id
    ), '[]'::jsonb)
  from public.financial_budget_change_requests as requests
  join public.projects as source on source.id = requests.source_project_id
  where (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_region_id is null or requests.region_id = p_region_id)
    and (p_year is null or requests.fiscal_year = p_year)
    and (p_status is null
      or (p_status = 'DUPLICATE' and requests.duplicate_of_request_id is not null
        and requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED'))
      or (p_status <> 'DUPLICATE' and requests.status = p_status))
    and (p_project_id is null or requests.source_project_id = p_project_id
      or exists (
        select 1
        from public.financial_budget_change_request_lines as project_lines
        left join public.financial_new_project_requests as project_new_requests
          on project_new_requests.id = project_lines.new_project_request_id
        where project_lines.request_id = requests.id
          and (project_lines.destination_project_id = p_project_id
            or project_new_requests.materialized_project_id = p_project_id
            or (coalesce(project_lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
              and substring(project_lines.note from 30)::uuid = p_project_id)))
      or exists (
        select 1 from public.financial_pending_new_project_funds as pending
        where pending.source_request_id = requests.id
          and pending.linked_project_id = p_project_id))
  order by requests.requested_at desc;
end;
$$;

revoke all on function public.financial_budget_change_canonical_destinations(jsonb)
  from public, anon, authenticated;
revoke all on function public.financial_budget_change_adjustment_fingerprint(uuid,uuid,bigint,bigint,jsonb,date)
  from public, anon, authenticated;
revoke all on function public.financial_budget_change_request_adjustment_fingerprint(uuid)
  from public, anon, authenticated;
revoke all on function public.financial_guard_budget_change_state_transition()
  from public, anon, authenticated;
revoke all on function public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)
  from public, anon, authenticated;
revoke all on function public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)
  from public, anon;
grant execute on function public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)
  to authenticated;
revoke all on function public.financial_submit_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_submit_budget_change_request(uuid)
  to authenticated;
revoke all on function public.financial_reject_budget_change_request(uuid,text)
  from public, anon;
grant execute on function public.financial_reject_budget_change_request(uuid,text)
  to authenticated;
revoke all on function public.get_financial_budget_change_requests(uuid,text,integer,uuid)
  from public, anon;
grant execute on function public.get_financial_budget_change_requests(uuid,text,integer,uuid)
  to authenticated;

do $$
declare
  v_snapshot financial_budget_adjustment_hotfix_snapshot%rowtype;
  v_current financial_budget_adjustment_hotfix_snapshot%rowtype;
  v_reject_definition text;
begin
  select snapshot.* into v_snapshot
  from financial_budget_adjustment_hotfix_snapshot as snapshot;
  select
    (select count(*) from public.financial_budget_change_requests)::bigint,
    (select count(*) from public.financial_budget_change_request_lines)::bigint,
    (select count(*) from public.project_fund_transfers)::bigint,
    (select coalesce(sum(transfers.amount), 0) from public.project_fund_transfers as transfers)::numeric,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint,
    (select coalesce(sum(movements.amount), 0) from public.financial_unallocated_fund_movements as movements)::numeric,
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(projects.alloc), 0) from public.projects)::numeric,
    (select coalesce(sum(projects.exec), 0) from public.projects)::numeric
  into v_current;
  if row(v_snapshot.*) is distinct from row(v_current.*) then
    raise exception using errcode = '55000', message =
      'Idempotency hotfix changed request, monetary, project, or execution totals.';
  end if;
  if exists (
    select 1
    from public.financial_budget_change_requests as requests
    where requests.source_adjustment_revision is null
       or requests.draft_revision_id is null
       or requests.adjustment_fingerprint is null
  ) then
    raise exception using errcode = '55000', message =
      'Budget-adjustment fingerprint backfill is incomplete.';
  end if;
  if exists (
    select requests.adjustment_fingerprint
    from public.financial_budget_change_requests as requests
    where requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
      and requests.duplicate_of_request_id is null
    group by requests.adjustment_fingerprint
    having count(*) > 1
  ) then
    raise exception using errcode = '55000', message =
      'Canonical active budget-adjustment fingerprints are not unique.';
  end if;
  if exists (
    select 1
    from public.financial_budget_change_requests as duplicates
    left join public.financial_budget_change_requests as canonical
      on canonical.id = duplicates.duplicate_of_request_id
    where duplicates.duplicate_of_request_id is not null
      and (canonical.id is null
        or canonical.adjustment_fingerprint <> duplicates.adjustment_fingerprint)
  ) then
    raise exception using errcode = '55000', message =
      'Legacy duplicate linkage does not preserve the economic fingerprint.';
  end if;
  if exists (
    select 1
    from public.financial_budget_change_requests as requests
    left join lateral (
      select coalesce(sum(lines.amount), 0)::bigint as line_amount
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = requests.id
    ) as totals on true
    where requests.total_amount <> totals.line_amount
  ) then
    raise exception using errcode = '55000', message =
      'Budget-adjustment monetary GAP is not 0.';
  end if;
  select lower(pg_get_functiondef(
    'public.financial_reject_budget_change_request(uuid,text)'::regprocedure))
    into v_reject_definition;
  if position('#variable_conflict use_column' in v_reject_definition) = 0
     or position('requests.status' in v_reject_definition) = 0
     or position('new_requests.status' in v_reject_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Reject function ambiguity guard is incomplete.';
  end if;
end;
$$;

commit;
