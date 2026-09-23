-- TEST-only UAT hotfix:
-- 1. A next-year new-project request validates against the pending plan year,
--    not the source lot's fiscal year.
-- 2. Applying a funded new-project request registers the project first and
--    creates a maker-checker pending-fund link request. Funding moves only
--    after the link request is approved and applied.
-- 3. Immutable raw-won before/after snapshots support admin change history.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      'Admin budget workflow UAT hotfix is pinned to the approved TEST project.';
  end if;
end;
$$;

-- A funded next-year project can be registered before its separate link
-- request is applied, so APPLIED may temporarily have no movement reference.
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
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and official_project_code is null
      and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and official_project_code is not null
      and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null
      and materialized_project_id is not null)
  );

create table public.financial_budget_workflow_amount_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('BUDGET_CHANGE', 'PENDING_LINK')),
  event_id uuid not null,
  budget_request_id uuid not null references public.financial_budget_change_requests(id) on delete restrict,
  pending_fund_id uuid references public.financial_pending_new_project_funds(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  project_role text not null check (project_role in ('SOURCE', 'DESTINATION')),
  amount bigint not null check (amount > 0),
  capture_kind text not null check (capture_kind in ('EXACT_AT_APPLY', 'DERIVED_CURRENT')),
  original_before bigint not null,
  increase_before bigint not null,
  decrease_before bigint not null,
  adjusted_before bigint not null,
  execution_before bigint not null,
  unexecuted_before bigint not null,
  original_after bigint not null,
  increase_after bigint not null,
  decrease_after bigint not null,
  adjusted_after bigint not null,
  execution_after bigint not null,
  unexecuted_after bigint not null,
  captured_at timestamptz not null default clock_timestamp(),
  constraint financial_budget_workflow_snapshot_before_formula check (
    adjusted_before = original_before + increase_before - decrease_before
    and unexecuted_before = adjusted_before - execution_before
  ),
  constraint financial_budget_workflow_snapshot_after_formula check (
    adjusted_after = original_after + increase_after - decrease_after
    and unexecuted_after = adjusted_after - execution_after
  ),
  unique (event_type, event_id, project_id, project_role)
);

create index financial_budget_workflow_snapshots_request_idx
  on public.financial_budget_workflow_amount_snapshots(budget_request_id, captured_at, id);

create or replace function public.financial_capture_budget_change_amount_snapshots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_position record;
  v_destination record;
  v_destination_year integer;
  v_before_adjusted bigint;
  v_after_adjusted bigint;
begin
  if new.status <> 'APPLIED' or old.status = 'APPLIED' then return new; end if;

  select * into v_position
  from public.get_financial_budget_change_project_position(new.source_project_id);
  if not found then
    raise exception using errcode = '55000', message = 'Source amount snapshot position is missing.';
  end if;
  v_before_adjusted := v_position.original_allocation + v_position.increase_amount - new.decrease_amount_before;
  v_after_adjusted := v_position.original_allocation + v_position.increase_amount - new.decrease_amount_after;
  insert into public.financial_budget_workflow_amount_snapshots (
    event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
    project_role, amount, capture_kind,
    original_before, increase_before, decrease_before, adjusted_before, execution_before, unexecuted_before,
    original_after, increase_after, decrease_after, adjusted_after, execution_after, unexecuted_after
  ) values (
    'BUDGET_CHANGE', new.id, new.id, new.source_project_id, new.region_id, new.fiscal_year,
    'SOURCE', new.total_amount, 'EXACT_AT_APPLY',
    v_position.original_allocation, v_position.increase_amount, new.decrease_amount_before,
    v_before_adjusted, v_position.execution_amount, v_before_adjusted - v_position.execution_amount,
    v_position.original_allocation, v_position.increase_amount, new.decrease_amount_after,
    v_after_adjusted, v_position.execution_amount, v_after_adjusted - v_position.execution_amount
  ) on conflict do nothing;

  for v_destination in
    select lines.destination_project_id as project_id, sum(lines.amount)::bigint as amount
    from public.financial_budget_change_request_lines as lines
    where lines.request_id = new.id and lines.destination_type = 'EXISTING_PROJECT'
    group by lines.destination_project_id
  loop
    select * into v_position
    from public.get_financial_budget_change_project_position(v_destination.project_id);
    select year into v_destination_year from public.projects where id = v_destination.project_id;
    if not found or v_position.increase_amount < v_destination.amount then
      raise exception using errcode = '55000', message = 'Destination amount snapshot position is invalid.';
    end if;
    insert into public.financial_budget_workflow_amount_snapshots (
      event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
      project_role, amount, capture_kind,
      original_before, increase_before, decrease_before, adjusted_before, execution_before, unexecuted_before,
      original_after, increase_after, decrease_after, adjusted_after, execution_after, unexecuted_after
    ) values (
      'BUDGET_CHANGE', new.id, new.id, v_destination.project_id, new.region_id, v_destination_year,
      'DESTINATION', v_destination.amount, 'EXACT_AT_APPLY',
      v_position.original_allocation, v_position.increase_amount - v_destination.amount,
      v_position.decrease_amount, v_position.adjusted_allocation - v_destination.amount,
      v_position.execution_amount, v_position.unexecuted_amount - v_destination.amount,
      v_position.original_allocation, v_position.increase_amount,
      v_position.decrease_amount, v_position.adjusted_allocation,
      v_position.execution_amount, v_position.unexecuted_amount
    ) on conflict do nothing;
  end loop;
  return new;
end;
$$;

create trigger financial_capture_budget_change_amount_snapshots
after update of status on public.financial_budget_change_requests
for each row execute function public.financial_capture_budget_change_amount_snapshots();

create or replace function public.financial_capture_pending_link_amount_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_pending public.financial_pending_new_project_funds%rowtype; v_position record; v_destination_year integer;
begin
  if new.status <> 'APPLIED' or old.status = 'APPLIED' then return new; end if;
  select * into v_pending from public.financial_pending_new_project_funds where id = new.pending_fund_id;
  select * into v_position from public.get_financial_budget_change_project_position(new.destination_project_id);
  select year into v_destination_year from public.projects where id = new.destination_project_id;
  if not found or v_position.increase_amount < new.amount then
    raise exception using errcode = '55000', message = 'Pending-link amount snapshot position is invalid.';
  end if;
  insert into public.financial_budget_workflow_amount_snapshots (
    event_type, event_id, budget_request_id, pending_fund_id,
    project_id, region_id, fiscal_year, project_role, amount, capture_kind,
    original_before, increase_before, decrease_before, adjusted_before, execution_before, unexecuted_before,
    original_after, increase_after, decrease_after, adjusted_after, execution_after, unexecuted_after
  ) values (
    'PENDING_LINK', new.id, v_pending.source_request_id, v_pending.id,
    new.destination_project_id, new.region_id, v_destination_year, 'DESTINATION', new.amount, 'EXACT_AT_APPLY',
    v_position.original_allocation, v_position.increase_amount - new.amount,
    v_position.decrease_amount, v_position.adjusted_allocation - new.amount,
    v_position.execution_amount, v_position.unexecuted_amount - new.amount,
    v_position.original_allocation, v_position.increase_amount,
    v_position.decrease_amount, v_position.adjusted_allocation,
    v_position.execution_amount, v_position.unexecuted_amount
  ) on conflict do nothing;
  return new;
end;
$$;

create trigger financial_capture_pending_link_amount_snapshot
after update of status on public.financial_pending_new_project_link_requests
for each row execute function public.financial_capture_pending_link_amount_snapshot();

-- Existing TEST history remains raw-won and receives a clearly marked current
-- Ledger derivation. All subsequent APPLY events are captured exactly.
insert into public.financial_budget_workflow_amount_snapshots (
  event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
  project_role, amount, capture_kind,
  original_before, increase_before, decrease_before, adjusted_before, execution_before, unexecuted_before,
  original_after, increase_after, decrease_after, adjusted_after, execution_after, unexecuted_after
)
select 'BUDGET_CHANGE', requests.id, requests.id, requests.source_project_id,
  requests.region_id, requests.fiscal_year, 'SOURCE', requests.total_amount, 'DERIVED_CURRENT',
  positions.ledger_original_allocation, positions.ledger_increase_amount,
  requests.decrease_amount_before,
  positions.ledger_original_allocation + positions.ledger_increase_amount - requests.decrease_amount_before,
  positions.ledger_execution_amount,
  positions.ledger_original_allocation + positions.ledger_increase_amount
    - requests.decrease_amount_before - positions.ledger_execution_amount,
  positions.ledger_original_allocation, positions.ledger_increase_amount,
  requests.decrease_amount_after,
  positions.ledger_original_allocation + positions.ledger_increase_amount - requests.decrease_amount_after,
  positions.ledger_execution_amount,
  positions.ledger_original_allocation + positions.ledger_increase_amount
    - requests.decrease_amount_after - positions.ledger_execution_amount
from public.financial_budget_change_requests as requests
join public.financial_project_funding_positions as positions
  on positions.project_id = requests.source_project_id
where requests.status = 'APPLIED'
on conflict do nothing;

insert into public.financial_budget_workflow_amount_snapshots (
  event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
  project_role, amount, capture_kind,
  original_before, increase_before, decrease_before, adjusted_before, execution_before, unexecuted_before,
  original_after, increase_after, decrease_after, adjusted_after, execution_after, unexecuted_after
)
select 'BUDGET_CHANGE', grouped.request_id, grouped.request_id, grouped.destination_project_id,
  requests.region_id, positions.fiscal_year, 'DESTINATION', grouped.amount, 'DERIVED_CURRENT',
  positions.ledger_original_allocation, positions.ledger_increase_amount - grouped.amount,
  positions.ledger_decrease_amount, positions.ledger_adjusted_allocation - grouped.amount,
  positions.ledger_execution_amount, positions.current_wallet_balance - grouped.amount,
  positions.ledger_original_allocation, positions.ledger_increase_amount,
  positions.ledger_decrease_amount, positions.ledger_adjusted_allocation,
  positions.ledger_execution_amount, positions.current_wallet_balance
from (
  select lines.request_id, lines.destination_project_id, sum(lines.amount)::bigint as amount
  from public.financial_budget_change_request_lines as lines
  where lines.destination_type = 'EXISTING_PROJECT' and lines.materialized_transfer_id is not null
  group by lines.request_id, lines.destination_project_id
) as grouped
join public.financial_budget_change_requests as requests on requests.id = grouped.request_id
join public.financial_project_funding_positions as positions on positions.project_id = grouped.destination_project_id
where requests.status = 'APPLIED' and positions.ledger_increase_amount >= grouped.amount
on conflict do nothing;

insert into public.financial_budget_workflow_amount_snapshots (
  event_type, event_id, budget_request_id, pending_fund_id,
  project_id, region_id, fiscal_year, project_role, amount, capture_kind,
  original_before, increase_before, decrease_before, adjusted_before, execution_before, unexecuted_before,
  original_after, increase_after, decrease_after, adjusted_after, execution_after, unexecuted_after
)
select 'PENDING_LINK', links.id, pending.source_request_id, pending.id,
  links.destination_project_id, links.region_id, positions.fiscal_year,
  'DESTINATION', links.amount, 'DERIVED_CURRENT',
  positions.ledger_original_allocation, positions.ledger_increase_amount - links.amount,
  positions.ledger_decrease_amount, positions.ledger_adjusted_allocation - links.amount,
  positions.ledger_execution_amount, positions.current_wallet_balance - links.amount,
  positions.ledger_original_allocation, positions.ledger_increase_amount,
  positions.ledger_decrease_amount, positions.ledger_adjusted_allocation,
  positions.ledger_execution_amount, positions.current_wallet_balance
from public.financial_pending_new_project_link_requests as links
join public.financial_pending_new_project_funds as pending on pending.id = links.pending_fund_id
join public.financial_project_funding_positions as positions on positions.project_id = links.destination_project_id
where links.status = 'APPLIED' and positions.ledger_increase_amount >= links.amount
on conflict do nothing;

create or replace function public.get_financial_budget_workflow_amount_snapshots(
  p_region_id uuid default null
)
returns table (
  event_type text, event_id uuid, budget_request_id uuid, pending_fund_id uuid,
  project_id uuid, fiscal_year integer, project_code text, project_name text,
  project_role text, amount bigint, capture_kind text,
  original_before bigint, increase_before bigint, decrease_before bigint,
  adjusted_before bigint, execution_before bigint, unexecuted_before bigint,
  original_after bigint, increase_after bigint, decrease_after bigint,
  adjusted_after bigint, execution_after bigint, unexecuted_after bigint,
  captured_at timestamptz
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
  if v_role = 'local_user' and p_region_id is not null and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '다른 지역의 예산 금액 이력은 조회할 수 없습니다.';
  end if;
  return query
  select snapshots.event_type, snapshots.event_id, snapshots.budget_request_id,
    snapshots.pending_fund_id, snapshots.project_id, snapshots.fiscal_year,
    projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''), nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null
        then '사업명 확인 필요 (' || projects.project_code || ')' else '사업명 확인 필요' end)::text,
    snapshots.project_role, snapshots.amount, snapshots.capture_kind,
    snapshots.original_before, snapshots.increase_before, snapshots.decrease_before,
    snapshots.adjusted_before, snapshots.execution_before, snapshots.unexecuted_before,
    snapshots.original_after, snapshots.increase_after, snapshots.decrease_after,
    snapshots.adjusted_after, snapshots.execution_after, snapshots.unexecuted_after,
    snapshots.captured_at
  from public.financial_budget_workflow_amount_snapshots as snapshots
  join public.projects on projects.id = snapshots.project_id
  where (v_role = 'admin' or snapshots.region_id = v_actor_region_id)
    and (p_region_id is null or snapshots.region_id = p_region_id)
  order by snapshots.captured_at desc, snapshots.id;
end;
$$;

create or replace function public.financial_create_new_project_request(
  p_region_id uuid, p_fiscal_year integer, p_project_name text,
  p_fund_project_name text, p_detail_project_name text, p_project_period text,
  p_project_start_year integer, p_project_end_year integer, p_status text,
  p_business_type text, p_large_category_id uuid, p_middle_category_id uuid,
  p_source_lot_id uuid, p_requested_amount bigint, p_idempotency_key uuid,
  p_submit boolean default false
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_payload jsonb; v_fingerprint text;
  v_request public.financial_new_project_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_lot from public.financial_unallocated_fund_lots where id = p_source_lot_id;
  select * into v_pending from public.financial_pending_new_project_funds
  where lot_id = p_source_lot_id;
  if not found then v_pending := null; end if;
  if v_lot.id is null or v_lot.region_id <> p_region_id
     or (v_pending.id is null and v_lot.fiscal_year <> p_fiscal_year)
     or (v_pending.id is not null and (
       v_pending.region_id <> p_region_id or v_pending.planned_project_year <> p_fiscal_year
       or v_pending.status <> 'WAITING' or v_pending.amount <> p_requested_amount
     )) then
    raise exception using errcode = '23514', message =
      '신규사업의 지역·계획연도·요청액이 예정재원과 일치해야 합니다.';
  end if;
  if v_role = 'local_user' and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '해당 지역의 신규사업만 요청할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_requested_amount is null or p_requested_amount <= 0
     or p_fiscal_year not between 2000 and 2200
     or char_length(btrim(coalesce(p_project_name, ''))) not between 1 and 500
     or (p_business_type is not null and p_business_type not in ('HW', 'SW', 'COMPOSITE'))
     or ((p_large_category_id is null) <> (p_middle_category_id is null))
     or (p_project_start_year is not null and p_project_end_year is not null
       and p_project_start_year > p_project_end_year) then
    raise exception using errcode = '22023', message = '신규사업 요청 내용을 확인해 주세요.';
  end if;
  v_payload := jsonb_build_object(
    'region_id', p_region_id, 'fiscal_year', p_fiscal_year,
    'project_name', btrim(p_project_name),
    'fund_project_name', nullif(btrim(p_fund_project_name), ''),
    'detail_project_name', nullif(btrim(p_detail_project_name), ''),
    'project_period', nullif(btrim(p_project_period), ''),
    'project_start_year', p_project_start_year, 'project_end_year', p_project_end_year,
    'project_status', nullif(btrim(p_status), ''), 'business_type', p_business_type,
    'large_category_id', p_large_category_id, 'middle_category_id', p_middle_category_id,
    'source_lot_id', p_source_lot_id, 'requested_amount', p_requested_amount
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_request from public.financial_new_project_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message = '요청 식별키의 소유자가 다릅니다.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_request.request_fingerprint, v_fingerprint, 'financial_new_project_requests');
    return query select v_request.id, v_request.status;
    return;
  end if;
  if exists (select 1 from public.financial_new_project_requests as existing
    where existing.source_lot_id = p_source_lot_id and existing.status <> 'REJECTED') then
    raise exception using errcode = '23505', message = '이 예정재원에 대한 신규사업 요청이 이미 있습니다.';
  end if;
  insert into public.financial_new_project_requests (
    region_id, fiscal_year, project_name, fund_project_name, detail_project_name,
    project_period, project_start_year, project_end_year, project_status, business_type,
    large_category_id, middle_category_id, source_lot_id, requested_amount,
    status, idempotency_key, request_fingerprint, requested_by, submitted_by, submitted_at
  ) values (
    p_region_id, p_fiscal_year, btrim(p_project_name), nullif(btrim(p_fund_project_name), ''),
    nullif(btrim(p_detail_project_name), ''), nullif(btrim(p_project_period), ''),
    p_project_start_year, p_project_end_year, nullif(btrim(p_status), ''), p_business_type,
    p_large_category_id, p_middle_category_id, p_source_lot_id, p_requested_amount,
    case when p_submit then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when p_submit then v_actor_id else null end,
    case when p_submit then clock_timestamp() else null end
  ) returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_update_new_project_request_draft(
  p_request_id uuid, p_project_name text, p_fund_project_name text,
  p_detail_project_name text, p_project_period text, p_project_start_year integer,
  p_project_end_year integer, p_status text, p_business_type text,
  p_large_category_id uuid, p_middle_category_id uuid,
  p_source_lot_id uuid, p_requested_amount bigint
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_payload jsonb;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_new_project_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '작성자만 신규사업 초안을 수정할 수 있습니다.';
  end if;
  select * into v_lot from public.financial_unallocated_fund_lots where id = p_source_lot_id;
  select * into v_pending from public.financial_pending_new_project_funds where lot_id = p_source_lot_id;
  if not found then v_pending := null; end if;
  if v_lot.id is null or v_lot.region_id <> v_request.region_id
     or (v_pending.id is null and v_lot.fiscal_year <> v_request.fiscal_year)
     or (v_pending.id is not null and (
       v_pending.planned_project_year <> v_request.fiscal_year or v_pending.status <> 'WAITING'
       or v_pending.amount <> p_requested_amount
     )) then
    raise exception using errcode = '23514', message = '변경한 재원이 신규사업의 지역·계획연도·금액과 일치하지 않습니다.';
  end if;
  if exists (select 1 from public.financial_new_project_requests as existing
    where existing.source_lot_id = p_source_lot_id and existing.id <> v_request.id
      and existing.status <> 'REJECTED') then
    raise exception using errcode = '23505', message = '이 예정재원에 대한 신규사업 요청이 이미 있습니다.';
  end if;
  if p_requested_amount is null or p_requested_amount <= 0
     or char_length(btrim(coalesce(p_project_name, ''))) not between 1 and 500
     or ((p_large_category_id is null) <> (p_middle_category_id is null))
     or (p_business_type is not null and p_business_type not in ('HW', 'SW', 'COMPOSITE'))
     or (p_project_start_year is not null and p_project_end_year is not null
       and p_project_start_year > p_project_end_year) then
    raise exception using errcode = '22023', message = '신규사업 초안 내용을 확인해 주세요.';
  end if;
  v_payload := jsonb_build_object(
    'region_id', v_request.region_id, 'fiscal_year', v_request.fiscal_year,
    'project_name', btrim(p_project_name),
    'fund_project_name', nullif(btrim(p_fund_project_name), ''),
    'detail_project_name', nullif(btrim(p_detail_project_name), ''),
    'project_period', nullif(btrim(p_project_period), ''),
    'project_start_year', p_project_start_year, 'project_end_year', p_project_end_year,
    'project_status', nullif(btrim(p_status), ''), 'business_type', p_business_type,
    'large_category_id', p_large_category_id, 'middle_category_id', p_middle_category_id,
    'source_lot_id', p_source_lot_id, 'requested_amount', p_requested_amount
  );
  update public.financial_new_project_requests set
    project_name = btrim(p_project_name),
    fund_project_name = nullif(btrim(p_fund_project_name), ''),
    detail_project_name = nullif(btrim(p_detail_project_name), ''),
    project_period = nullif(btrim(p_project_period), ''),
    project_start_year = p_project_start_year, project_end_year = p_project_end_year,
    project_status = nullif(btrim(p_status), ''), business_type = p_business_type,
    large_category_id = p_large_category_id, middle_category_id = p_middle_category_id,
    source_lot_id = p_source_lot_id, requested_amount = p_requested_amount,
    request_fingerprint = public.financial_request_fingerprint(v_payload)
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_apply_new_project_request(p_request_id uuid)
returns table (
  request_id uuid, project_id uuid, project_code text,
  movement_id uuid, budget_year_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_project_id uuid; v_budget_year_id uuid; v_movement_id uuid; v_link_request_id uuid;
  v_remaining bigint; v_fingerprint text;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_new_project_requests
  where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = '신규사업 요청을 찾을 수 없습니다.'; end if;
  select * into v_lot from public.financial_unallocated_fund_lots where id = v_request.source_lot_id;
  if not found then raise exception using errcode = 'P0002', message = '신규사업의 원천 재원을 찾을 수 없습니다.'; end if;
  select * into v_pending from public.financial_pending_new_project_funds where lot_id = v_lot.id;
  if not found then v_pending := null; end if;

  if v_request.status = 'APPLIED' then
    if v_request.materialized_project_id is null then
      raise exception using errcode = '55000', message = '적용된 신규사업의 생성 결과가 없습니다.';
    end if;
    if v_request.materialized_movement_id is not null then
      select movements.destination_budget_year_id into v_budget_year_id
      from public.financial_unallocated_fund_movements as movements
      where movements.id = v_request.materialized_movement_id;
    else
      select wallets.id into v_budget_year_id from public.project_budget_years as wallets
      where wallets.project_id = v_request.materialized_project_id
        and wallets.budget_cohort_id = v_lot.budget_cohort_id
      order by wallets.created_at desc limit 1;
    end if;
    return query select v_request.id, v_request.materialized_project_id,
      v_request.official_project_code, v_request.materialized_movement_id, v_budget_year_id;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '요청자와 다른 관리자가 승인된 신규사업만 적용할 수 있습니다.';
  end if;
  if exists (select 1 from public.projects as existing
    where existing.project_code = v_request.official_project_code
       or existing.project_id = v_request.official_project_code) then
    raise exception using errcode = '23505', message = '공식 사업코드가 기존 사업과 중복됩니다.';
  end if;
  if v_lot.region_id <> v_request.region_id
     or (v_pending.id is null and v_lot.fiscal_year <> v_request.fiscal_year)
     or (v_pending.id is not null and (
       v_pending.region_id <> v_request.region_id
       or v_pending.planned_project_year <> v_request.fiscal_year
       or v_pending.amount <> v_request.requested_amount or v_pending.status <> 'WAITING'
     )) then
    raise exception using errcode = '23514', message = '승인된 신규사업과 예정재원의 지역·계획연도·금액이 일치하지 않습니다.';
  end if;
  v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot.id);
  if v_request.requested_amount > v_remaining then
    raise exception using errcode = '23514', message = '신규사업 요청액이 예정재원 잔액을 초과합니다.';
  end if;
  perform public.financial_assert_funding_origin_evidence(
    v_lot.region_id, v_lot.record_origin, v_lot.effective_date, v_lot.evidence_id);

  insert into public.projects (
    project_id, project_code, region_id, year, project_name, fund_project_name, detail_project_name,
    project_period, project_start_year, project_end_year, status, business_type,
    large_category_id, middle_category_id, total_budget,
    original_alloc, increase_amount, decrease_amount, alloc, exec, rate
  ) values (
    v_request.official_project_code, v_request.official_project_code,
    v_request.region_id, v_request.fiscal_year,
    v_request.project_name, v_request.fund_project_name, v_request.detail_project_name,
    v_request.project_period, v_request.project_start_year, v_request.project_end_year,
    v_request.project_status, v_request.business_type, v_request.large_category_id,
    v_request.middle_category_id, v_request.requested_amount,
    0, case when v_pending.id is null then v_request.requested_amount else 0 end, 0,
    case when v_pending.id is null then v_request.requested_amount else 0 end, 0, 0
  ) returning id into v_project_id;
  v_budget_year_id := public.financial_get_or_create_budget_year(
    v_project_id, v_lot.budget_cohort_id, v_lot.fiscal_year, v_actor_id);

  if v_pending.id is not null then
    v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'new_project_request_id', v_request.id, 'pending_fund_id', v_pending.id,
      'destination_project_id', v_project_id, 'amount', v_pending.amount));
    insert into public.financial_pending_new_project_link_requests (
      pending_fund_id, region_id, destination_project_id, amount, status,
      idempotency_key, request_fingerprint, requested_by, requested_at
    ) values (
      v_pending.id, v_pending.region_id, v_project_id, v_pending.amount, 'SUBMITTED',
      v_request.id, v_fingerprint, v_request.requested_by, clock_timestamp()
    ) returning id into v_link_request_id;
    update public.financial_new_project_requests
    set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
        materialized_project_id = v_project_id, materialized_movement_id = null
    where id = v_request.id;
    perform public.financial_write_audit(
      v_project_id, v_request.region_id, 'NEW_PROJECT_REGISTERED',
      'financial_new_project_requests', v_request.id, v_actor_id,
      jsonb_build_object('project_code', v_request.official_project_code,
        'source_lot_id', v_lot.id, 'pending_fund_id', v_pending.id,
        'link_request_id', v_link_request_id, 'amount', v_request.requested_amount,
        'financial_amount_effect', 0));
    return query select v_request.id, v_project_id, v_request.official_project_code,
      null::uuid, v_budget_year_id;
    return;
  end if;

  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'request_id', v_request.id, 'source_lot_id', v_lot.id,
    'destination_project_id', v_project_id, 'amount', v_request.requested_amount,
    'record_origin', v_lot.record_origin, 'evidence_id', v_lot.evidence_id));
  insert into public.financial_unallocated_fund_movements (
    lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
    destination_project_id, destination_budget_year_id, new_project_request_id,
    amount, effective_date, record_origin, evidence_id, memo,
    idempotency_key, request_fingerprint, created_by, confirmed_by
  ) values (
    v_lot.id, v_lot.region_id, v_lot.budget_cohort_id,
    'ALLOCATE_NEW_PROJECT', 'NORMAL', v_project_id, v_budget_year_id, v_request.id,
    v_request.requested_amount, v_lot.effective_date, v_lot.record_origin,
    v_lot.evidence_id, 'Approved new-project waiting-fund allocation',
    v_request.idempotency_key, v_fingerprint, v_request.requested_by, v_actor_id
  ) returning id into v_movement_id;
  update public.financial_new_project_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
      materialized_project_id = v_project_id, materialized_movement_id = v_movement_id
  where id = v_request.id;
  perform public.financial_write_audit(v_project_id, v_request.region_id,
    'NEW_PROJECT_APPLIED', 'financial_new_project_requests', v_request.id, v_actor_id,
    jsonb_build_object('project_code', v_request.official_project_code,
      'source_lot_id', v_lot.id, 'amount', v_request.requested_amount,
      'budget_cohort_id', v_lot.budget_cohort_id,
      'destination_budget_year_id', v_budget_year_id, 'movement_id', v_movement_id));
  return query select v_request.id, v_project_id, v_request.official_project_code,
    v_movement_id, v_budget_year_id;
end;
$$;

alter table public.financial_budget_workflow_amount_snapshots enable row level security;
alter table public.financial_budget_workflow_amount_snapshots force row level security;
create policy financial_budget_workflow_snapshots_select_region_or_admin
  on public.financial_budget_workflow_amount_snapshots for select to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and (profiles.role = 'admin'
        or profiles.region_id = financial_budget_workflow_amount_snapshots.region_id)
  ));
revoke all on table public.financial_budget_workflow_amount_snapshots from public, anon, authenticated;
grant select on table public.financial_budget_workflow_amount_snapshots to authenticated;
revoke all on function public.financial_capture_budget_change_amount_snapshots() from public, anon, authenticated;
revoke all on function public.financial_capture_pending_link_amount_snapshot() from public, anon, authenticated;
revoke all on function public.get_financial_budget_workflow_amount_snapshots(uuid) from public, anon;
grant execute on function public.get_financial_budget_workflow_amount_snapshots(uuid) to authenticated;
revoke all on function public.financial_create_new_project_request(uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,boolean) from public, anon;
grant execute on function public.financial_create_new_project_request(uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,boolean) to authenticated;
revoke all on function public.financial_update_new_project_request_draft(uuid,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint) from public, anon;
grant execute on function public.financial_update_new_project_request_draft(uuid,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint) to authenticated;
revoke all on function public.financial_apply_new_project_request(uuid) from public, anon;
grant execute on function public.financial_apply_new_project_request(uuid) to authenticated;

do $$
declare v_definition text;
begin
  select lower(pg_get_functiondef('public.financial_apply_new_project_request(uuid)'::regprocedure))
    into v_definition;
  if position('financial_pending_new_project_link_requests' in v_definition) = 0
     or position('planned_project_year <> v_request.fiscal_year' in v_definition) = 0 then
    raise exception using errcode = '55000', message = 'Next-year new-project/link workflow definition check failed.';
  end if;
  if exists (select 1 from public.financial_budget_workflow_amount_snapshots
    where adjusted_before <> original_before + increase_before - decrease_before
       or unexecuted_before <> adjusted_before - execution_before
       or adjusted_after <> original_after + increase_after - decrease_after
       or unexecuted_after <> adjusted_after - execution_after) then
    raise exception using errcode = '55000', message = 'Budget workflow amount snapshot formula check failed.';
  end if;
end;
$$;

commit;
