-- TEST-only delta: atomic budget reallocation with multiple destinations and
-- traceable pending funds for projects that do not exist yet.
-- Existing RETURN and carryover objects remain untouched and read-only in the
-- new application workflow.

begin;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      'Budget-change delta is pinned to the approved TEST project.';
  end if;
  if to_regclass('public.financial_budget_change_requests') is not null
     or to_regclass('public.financial_pending_new_project_funds') is not null then
    raise exception using errcode = '55000', message =
      'Budget-change delta objects already exist.';
  end if;
end;
$$;

create table public.financial_budget_change_requests (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  source_project_id uuid not null references public.projects(id) on delete restrict,
  source_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  total_amount bigint not null check (total_amount > 0),
  decrease_amount_before bigint not null check (decrease_amount_before >= 0),
  decrease_amount_after bigint not null check (decrease_amount_after >= 0),
  effective_date date not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  status text not null check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED')),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  submitted_by uuid references public.profiles(id) on delete restrict,
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  applied_by uuid references public.profiles(id) on delete restrict,
  applied_at timestamptz,
  constraint financial_budget_change_amount_delta_check check (
    decrease_amount_after - decrease_amount_before = total_amount
  ),
  constraint financial_budget_change_state_shape check (
    (status = 'DRAFT' and submitted_by is null and approved_by is null
      and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null)
  )
);

create table public.financial_budget_change_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.financial_budget_change_requests(id) on delete restrict,
  line_no integer not null check (line_no between 1 and 20),
  destination_type text not null check (destination_type in ('EXISTING_PROJECT', 'PENDING_NEW_PROJECT')),
  destination_project_id uuid references public.projects(id) on delete restrict,
  planned_project_name text,
  planned_project_year integer check (planned_project_year is null or planned_project_year between 2000 and 2200),
  amount bigint not null check (amount > 0),
  note text check (note is null or char_length(note) <= 1000),
  materialized_transfer_id uuid references public.project_fund_transfers(id) on delete restrict,
  materialized_lot_id uuid references public.financial_unallocated_fund_lots(id) on delete restrict,
  pending_fund_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  constraint financial_budget_change_line_shape check (
    (destination_type = 'EXISTING_PROJECT' and destination_project_id is not null
      and planned_project_name is null and planned_project_year is null)
    or (destination_type = 'PENDING_NEW_PROJECT' and destination_project_id is null
      and char_length(btrim(planned_project_name)) between 1 and 500
      and planned_project_year is not null)
  ),
  constraint financial_budget_change_line_materialized_shape check (
    not (materialized_transfer_id is not null and materialized_lot_id is not null)
  ),
  unique (request_id, line_no)
);

create table public.financial_pending_new_project_funds (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  planned_project_name text not null check (char_length(btrim(planned_project_name)) between 1 and 500),
  planned_project_year integer not null check (planned_project_year between 2000 and 2200),
  amount bigint not null check (amount > 0),
  lot_id uuid not null unique references public.financial_unallocated_fund_lots(id) on delete restrict,
  source_request_id uuid not null references public.financial_budget_change_requests(id) on delete restrict,
  source_line_id uuid not null unique references public.financial_budget_change_request_lines(id) on delete restrict,
  status text not null default 'WAITING' check (status in ('WAITING', 'LINKED')),
  linked_project_id uuid references public.projects(id) on delete restrict,
  linked_movement_id uuid unique references public.financial_unallocated_fund_movements(id) on delete restrict,
  linked_by uuid references public.profiles(id) on delete restrict,
  linked_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint financial_pending_new_project_fund_state_shape check (
    (status = 'WAITING' and linked_project_id is null and linked_movement_id is null
      and linked_by is null and linked_at is null)
    or (status = 'LINKED' and linked_project_id is not null and linked_movement_id is not null
      and linked_by is not null and linked_at is not null)
  )
);

alter table public.financial_budget_change_request_lines
  add constraint financial_budget_change_request_lines_pending_fkey
  foreign key (pending_fund_id)
  references public.financial_pending_new_project_funds(id) on delete restrict;

create table public.financial_pending_new_project_link_requests (
  id uuid primary key default gen_random_uuid(),
  pending_fund_id uuid not null references public.financial_pending_new_project_funds(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  destination_project_id uuid not null references public.projects(id) on delete restrict,
  amount bigint not null check (amount > 0),
  status text not null check (status in ('SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED')),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  applied_by uuid references public.profiles(id) on delete restrict,
  applied_at timestamptz,
  materialized_movement_id uuid references public.financial_unallocated_fund_movements(id) on delete restrict,
  constraint financial_pending_link_state_shape check (
    (status = 'SUBMITTED' and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null
      and materialized_movement_id is not null)
  )
);

create index financial_budget_change_requests_region_status_idx
  on public.financial_budget_change_requests(region_id, status, fiscal_year, requested_at desc);
create index financial_budget_change_lines_destination_idx
  on public.financial_budget_change_request_lines(destination_project_id, destination_type);
create index financial_pending_new_project_funds_region_status_idx
  on public.financial_pending_new_project_funds(region_id, status, planned_project_year, created_at desc);
create index financial_pending_new_project_links_region_status_idx
  on public.financial_pending_new_project_link_requests(region_id, status, requested_at desc);
create unique index financial_pending_new_project_one_open_link_uidx
  on public.financial_pending_new_project_link_requests(pending_fund_id)
  where status in ('SUBMITTED', 'APPROVED');

create or replace function public.financial_budget_change_visible_decrease(p_project_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(projects.decrease_amount, 0)::bigint
    + coalesce((
      select sum(requests.total_amount)::bigint
      from public.financial_budget_change_requests as requests
      where requests.source_project_id = projects.id and requests.status = 'APPLIED'
    ), 0)::bigint
  from public.projects
  where projects.id = p_project_id;
$$;

create or replace function public.financial_validate_budget_change_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.financial_budget_change_requests%rowtype;
  v_line record;
  v_sum bigint;
  v_region_id uuid;
  v_year integer;
  v_visible_decrease bigint;
begin
  select * into v_request
  from public.financial_budget_change_requests
  where id = p_request_id;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  select coalesce(sum(amount), 0)::bigint into v_sum
  from public.financial_budget_change_request_lines
  where request_id = v_request.id;
  if v_sum <> v_request.total_amount then
    raise exception using errcode = '23514', message = '감액액과 목적지 배분 합계의 차액은 0원이어야 합니다.';
  end if;
  select projects.region_id, projects.year
    into v_region_id, v_year
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = v_request.source_budget_year_id
    and projects.id = v_request.source_project_id;
  if not found or v_region_id <> v_request.region_id or v_year <> v_request.fiscal_year then
    raise exception using errcode = '23514', message = '출처 사업의 지역 또는 연도가 변경되었습니다.';
  end if;
  v_visible_decrease := public.financial_budget_change_visible_decrease(v_request.source_project_id);
  if v_visible_decrease <> v_request.decrease_amount_before then
    raise exception using errcode = '40001', message = '출처 사업의 감액액이 변경되었습니다. 새로고침 후 다시 요청해 주세요.';
  end if;
  for v_line in
    select * from public.financial_budget_change_request_lines
    where request_id = v_request.id order by line_no
  loop
    if v_line.destination_type = 'EXISTING_PROJECT' then
      select region_id, year into v_region_id, v_year
      from public.projects where id = v_line.destination_project_id;
      if not found or v_region_id <> v_request.region_id
         or v_year > v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업 목적지는 같은 지역의 현재연도 또는 과거연도 다른 사업이어야 합니다.';
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.financial_create_budget_change_request(
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
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_source_project_id uuid;
  v_region_id uuid;
  v_fiscal_year integer;
  v_total bigint;
  v_before bigint;
  v_fingerprint text;
  v_request public.financial_budget_change_requests%rowtype;
  v_item jsonb;
  v_kind text;
  v_amount bigint;
  v_destination_project_id uuid;
  v_planned_name text;
  v_planned_year integer;
  v_line_no integer := 0;
  v_existing_region uuid;
  v_existing_year integer;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null or p_effective_date is null
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000
     or jsonb_typeof(p_destinations) <> 'array'
     or jsonb_array_length(p_destinations) not between 1 and 20 then
    raise exception using errcode = '22023', message =
      '예산 조정 사유와 1~20개의 목적지를 입력해 주세요.';
  end if;
  select wallets.project_id, projects.region_id, projects.year
    into v_source_project_id, v_region_id, v_fiscal_year
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = p_source_budget_year_id;
  if not found then
    raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.';
  end if;
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '자기 지역 사업만 예산 조정을 요청할 수 있습니다.';
  end if;
  if exists (
    select 1 from public.financial_unclassified_project_decreases
    where project_id = v_source_project_id and unclassified_amount > 0
  ) then
    raise exception using errcode = '23514', message =
      '기존 감액의 재원 연결을 먼저 완료한 뒤 새 예산 조정을 요청해 주세요.';
  end if;

  v_total := 0;
  for v_item in select value from jsonb_array_elements(p_destinations)
  loop
    v_line_no := v_line_no + 1;
    v_kind := v_item ->> 'destination_type';
    v_amount := (v_item ->> 'amount')::bigint;
    if v_amount <= 0 or v_kind not in ('EXISTING_PROJECT', 'PENDING_NEW_PROJECT') then
      raise exception using errcode = '22023', message = '모든 목적지 금액은 0보다 큰 원 단위 정수여야 합니다.';
    end if;
    v_total := v_total + v_amount;
    if v_kind = 'EXISTING_PROJECT' then
      v_destination_project_id := (v_item ->> 'destination_project_id')::uuid;
      select region_id, year into v_existing_region, v_existing_year
      from public.projects where id = v_destination_project_id;
      if not found or v_existing_region <> v_region_id or v_existing_year > v_fiscal_year
         or v_destination_project_id = v_source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업은 같은 지역의 현재연도 또는 과거연도 다른 사업만 선택할 수 있습니다.';
      end if;
    else
      v_planned_name := btrim(coalesce(v_item ->> 'planned_project_name', ''));
      v_planned_year := (v_item ->> 'planned_project_year')::integer;
      if char_length(v_planned_name) not between 1 and 500
         or v_planned_year not between 2000 and 2200 then
        raise exception using errcode = '22023', message = '신규사업 예정명과 예정연도를 확인해 주세요.';
      end if;
    end if;
  end loop;
  if v_total <= 0 then
    raise exception using errcode = '22023', message = '감액액은 0보다 커야 합니다.';
  end if;

  perform 1 from public.project_budget_years where id = p_source_budget_year_id for update;
  perform public.financial_require_available_amount(
    p_source_budget_year_id, v_total, '감액액이 현재 미집행액을 초과합니다.'
  );
  v_before := public.financial_budget_change_visible_decrease(v_source_project_id);
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'source_budget_year_id', p_source_budget_year_id,
    'destinations', p_destinations,
    'effective_date', p_effective_date,
    'reason', btrim(p_reason)
  ));
  select * into v_request
  from public.financial_budget_change_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message = '요청 식별키가 다른 사용자에게 속해 있습니다.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_request.request_fingerprint, v_fingerprint, 'financial_budget_change_requests'
    );
    return query select v_request.id, v_request.status, 0::bigint;
    return;
  end if;

  insert into public.financial_budget_change_requests (
    region_id, fiscal_year, source_project_id, source_budget_year_id,
    total_amount, decrease_amount_before, decrease_amount_after,
    effective_date, reason, status, idempotency_key, request_fingerprint,
    requested_by, submitted_by, submitted_at
  ) values (
    v_region_id, v_fiscal_year, v_source_project_id, p_source_budget_year_id,
    v_total, v_before, v_before + v_total, p_effective_date, btrim(p_reason),
    case when p_submit then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when p_submit then v_actor_id else null end,
    case when p_submit then clock_timestamp() else null end
  ) returning * into v_request;

  v_line_no := 0;
  for v_item in select value from jsonb_array_elements(p_destinations)
  loop
    v_line_no := v_line_no + 1;
    v_kind := v_item ->> 'destination_type';
    insert into public.financial_budget_change_request_lines (
      request_id, line_no, destination_type, destination_project_id,
      planned_project_name, planned_project_year, amount, note
    ) values (
      v_request.id, v_line_no, v_kind,
      case when v_kind = 'EXISTING_PROJECT' then (v_item ->> 'destination_project_id')::uuid else null end,
      case when v_kind = 'PENDING_NEW_PROJECT' then btrim(v_item ->> 'planned_project_name') else null end,
      case when v_kind = 'PENDING_NEW_PROJECT' then (v_item ->> 'planned_project_year')::integer else null end,
      (v_item ->> 'amount')::bigint,
      nullif(btrim(coalesce(v_item ->> 'note', '')), '')
    );
  end loop;
  perform public.financial_write_audit(
    v_source_project_id, v_region_id,
    case when p_submit then 'BUDGET_REALLOCATION_SUBMITTED' else 'BUDGET_REALLOCATION_DRAFTED' end,
    'financial_budget_change_requests', v_request.id, v_actor_id,
    jsonb_build_object('amount', v_total, 'destination_count', v_line_no, 'gap_amount', 0)
  );
  return query select v_request.id, v_request.status, 0::bigint;
exception
  when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed then
    raise exception using errcode = '22023', message = '사업 또는 금액 입력값을 확인해 주세요.';
end;
$$;

create or replace function public.financial_submit_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '요청자만 예산 조정 초안을 제출할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  update public.financial_budget_change_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_budget_change_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '다른 관리자가 제출된 예산 조정만 승인할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  update public.financial_budget_change_requests
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_reject_budget_change_request(p_request_id uuid, p_reason text)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_budget_change_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '반려 사유를 입력해 주세요.';
  end if;
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '다른 관리자가 제출된 예산 조정만 반려할 수 있습니다.';
  end if;
  update public.financial_budget_change_requests
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_apply_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
  v_line public.financial_budget_change_request_lines%rowtype;
  v_source_wallet public.project_budget_years%rowtype;
  v_destination_budget_year_id uuid;
  v_destination_region uuid;
  v_destination_year integer;
  v_transfer_id uuid;
  v_lot_id uuid;
  v_pending_id uuid;
  v_classification_before bigint;
  v_classification_after bigint;
  v_line_key uuid;
  v_line_fingerprint text;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.id, v_request.status, 0::bigint;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '승인된 예산 조정만 요청자와 다른 관리자가 적용할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  perform public.financial_assert_funding_origin_evidence(
    v_request.region_id, 'SYSTEM_NATIVE', v_request.effective_date, null
  );
  select * into v_source_wallet from public.project_budget_years
  where id = v_request.source_budget_year_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.';
  end if;
  perform public.financial_require_available_amount(
    v_source_wallet.id, v_request.total_amount, '감액액이 현재 미집행액을 초과합니다.'
  );
  select coalesce(sum(classification_effect), 0)::bigint
    into v_classification_before
  from public.financial_project_decrease_classification_effects
  where source_project_id = v_request.source_project_id;
  perform 1 from public.financial_assert_decrease_delta_position(
    v_source_wallet.id, v_classification_before,
    v_classification_before + v_request.total_amount,
    v_request.total_amount, false
  );
  perform public.financial_assert_project_baseline_ready(
    v_request.source_project_id, -v_request.total_amount, 0,
    v_request.total_amount, 'SYSTEM_NATIVE', false
  );

  v_classification_after := v_classification_before;
  for v_line in
    select * from public.financial_budget_change_request_lines
    where request_id = v_request.id order by line_no for update
  loop
    v_line_key := gen_random_uuid();
    v_line_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'request_id', v_request.id, 'line_id', v_line.id,
      'destination_type', v_line.destination_type, 'amount', v_line.amount
    ));
    if v_line.destination_type = 'EXISTING_PROJECT' then
      select region_id, year into v_destination_region, v_destination_year
      from public.projects where id = v_line.destination_project_id;
      if not found or v_destination_region <> v_request.region_id
         or v_destination_year > v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message = '목적지 사업의 지역 또는 연도가 변경되었습니다.';
      end if;
      perform public.financial_assert_project_baseline_ready(
        v_line.destination_project_id, v_line.amount, 0, 0, 'SYSTEM_NATIVE', false
      );
      v_destination_budget_year_id := public.financial_get_or_create_budget_year(
        v_line.destination_project_id, v_source_wallet.budget_cohort_id,
        v_source_wallet.fiscal_year, v_actor_id
      );
      perform 1 from public.project_budget_years
      where id = any(array[v_source_wallet.id, v_destination_budget_year_id])
      order by id for update;
      insert into public.project_fund_transfers (
        source_budget_year_id, destination_budget_year_id, amount, status,
        transaction_kind, reason_code, memo, effective_date, idempotency_key,
        created_by, submitted_at, confirmed_by, confirmed_at,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_wallet.id, v_destination_budget_year_id, v_line.amount, 'CONFIRMED',
        'NORMAL', 'BUDGET_REALLOCATION', coalesce(v_line.note, v_request.reason),
        v_request.effective_date, v_line_key, v_request.requested_by,
        v_request.submitted_at, v_actor_id, clock_timestamp(),
        'SYSTEM_NATIVE', null, v_line_fingerprint
      ) returning id into v_transfer_id;
      insert into public.financial_project_decrease_classifications (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        outcome_type, amount, decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, transfer_id, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year, v_source_wallet.budget_cohort_id,
        v_request.source_project_id, v_source_wallet.id, 'EXISTING_PROJECT_TRANSFER',
        v_line.amount, v_classification_after, v_classification_after + v_line.amount,
        'project_fund_transfers', v_transfer_id, v_transfer_id, 'SYSTEM_NATIVE', null,
        gen_random_uuid(), v_line_fingerprint, v_request.requested_by
      );
      update public.financial_budget_change_request_lines
      set materialized_transfer_id = v_transfer_id
      where id = v_line.id;
    else
      insert into public.financial_unallocated_fund_lots (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        original_amount, reason, effective_date, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by, confirmed_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year, v_source_wallet.budget_cohort_id,
        v_request.source_project_id, v_source_wallet.id, v_line.amount,
        '신규사업 예정 · ' || v_line.planned_project_name,
        v_request.effective_date, 'SYSTEM_NATIVE', null, v_line_key,
        v_line_fingerprint, v_request.requested_by, v_actor_id
      ) returning id into v_lot_id;
      insert into public.financial_project_decrease_classifications (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        outcome_type, amount, decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, lot_id, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year, v_source_wallet.budget_cohort_id,
        v_request.source_project_id, v_source_wallet.id, 'UNALLOCATED_LOT',
        v_line.amount, v_classification_after, v_classification_after + v_line.amount,
        'financial_unallocated_fund_lots', v_lot_id, v_lot_id, 'SYSTEM_NATIVE', null,
        gen_random_uuid(), v_line_fingerprint, v_request.requested_by
      );
      insert into public.financial_pending_new_project_funds (
        region_id, fiscal_year, planned_project_name, planned_project_year,
        amount, lot_id, source_request_id, source_line_id, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year,
        v_line.planned_project_name, v_line.planned_project_year,
        v_line.amount, v_lot_id, v_request.id, v_line.id, v_request.requested_by
      ) returning id into v_pending_id;
      update public.financial_budget_change_request_lines
      set materialized_lot_id = v_lot_id, pending_fund_id = v_pending_id
      where id = v_line.id;
    end if;
    v_classification_after := v_classification_after + v_line.amount;
  end loop;
  if v_classification_after - v_classification_before <> v_request.total_amount then
    raise exception using errcode = '23514', message = '예산 조정 적용 차액이 0원이 아닙니다.';
  end if;
  update public.financial_budget_change_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_APPLIED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('amount', v_request.total_amount, 'gap_amount', 0)
  );
  return query select v_request.id, v_request.status, 0::bigint;
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
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_destination_region uuid; v_destination_year integer;
  v_fingerprint text;
  v_request public.financial_pending_new_project_link_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_pending from public.financial_pending_new_project_funds
  where id = p_pending_fund_id for update;
  if not found or v_pending.status <> 'WAITING' then
    raise exception using errcode = '23514', message = '연결 가능한 신규사업 예정재원이 아닙니다.';
  end if;
  select region_id, year into v_destination_region, v_destination_year
  from public.projects where id = p_destination_project_id;
  if not found or v_destination_region <> v_pending.region_id
     or v_destination_year <> v_pending.planned_project_year then
    raise exception using errcode = '23514', message = '예정연도와 지역이 같은 실제 사업만 연결할 수 있습니다.';
  end if;
  if v_role = 'local_user' and v_pending.region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '자기 지역 예정재원만 연결 요청할 수 있습니다.';
  end if;
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'pending_fund_id', p_pending_fund_id,
    'destination_project_id', p_destination_project_id,
    'amount', v_pending.amount
  ));
  select * into v_request from public.financial_pending_new_project_link_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message = '요청 식별키가 다른 사용자에게 속해 있습니다.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_request.request_fingerprint, v_fingerprint, 'financial_pending_new_project_link_requests'
    );
    return query select v_request.id, v_request.status;
    return;
  end if;
  insert into public.financial_pending_new_project_link_requests (
    pending_fund_id, region_id, destination_project_id, amount, status,
    idempotency_key, request_fingerprint, requested_by
  ) values (
    v_pending.id, v_pending.region_id, p_destination_project_id, v_pending.amount,
    'SUBMITTED', p_idempotency_key, v_fingerprint, v_actor_id
  ) returning * into v_request;
  perform public.financial_write_audit(
    p_destination_project_id, v_pending.region_id,
    'PENDING_NEW_PROJECT_LINK_SUBMITTED', 'financial_pending_new_project_link_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('pending_fund_id', v_pending.id, 'amount', v_pending.amount)
  );
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_review_pending_new_project_link(
  p_request_id uuid,
  p_decision text,
  p_reason text default null
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_pending_new_project_link_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception using errcode = '22023', message = '승인 또는 반려를 선택해 주세요.';
  end if;
  if p_decision = 'REJECT' and char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '반려 사유를 입력해 주세요.';
  end if;
  select * into v_request from public.financial_pending_new_project_link_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '다른 관리자가 제출된 연결 요청만 검토할 수 있습니다.';
  end if;
  update public.financial_pending_new_project_link_requests
  set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
      approved_by = case when p_decision = 'APPROVE' then v_actor_id else null end,
      approved_at = case when p_decision = 'APPROVE' then clock_timestamp() else null end,
      rejected_by = case when p_decision = 'REJECT' then v_actor_id else null end,
      rejected_at = case when p_decision = 'REJECT' then clock_timestamp() else null end,
      rejection_reason = case when p_decision = 'REJECT' then btrim(p_reason) else null end
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_apply_pending_new_project_link(p_request_id uuid)
returns table (request_id uuid, status text, pending_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_pending_new_project_link_requests%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_destination_region uuid;
  v_destination_year integer;
  v_destination_budget_year_id uuid;
  v_remaining bigint;
  v_movement_id uuid;
  v_fingerprint text;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_pending_new_project_link_requests
  where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = '연결 요청을 찾을 수 없습니다.'; end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.id, v_request.status, 0::bigint;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '승인된 연결 요청만 요청자와 다른 관리자가 적용할 수 있습니다.';
  end if;
  select * into v_pending from public.financial_pending_new_project_funds
  where id = v_request.pending_fund_id for update;
  if not found or v_pending.status <> 'WAITING' or v_pending.amount <> v_request.amount then
    raise exception using errcode = '23514', message = '예정재원 상태 또는 금액이 변경되었습니다.';
  end if;
  select region_id, year into v_destination_region, v_destination_year
  from public.projects where id = v_request.destination_project_id;
  if not found or v_destination_region <> v_pending.region_id
     or v_destination_year <> v_pending.planned_project_year then
    raise exception using errcode = '23514', message = '연결할 실제 사업의 지역 또는 연도가 변경되었습니다.';
  end if;
  select * into v_lot from public.financial_unallocated_fund_lots
  where id = v_pending.lot_id;
  v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot.id);
  if v_remaining <> v_pending.amount then
    raise exception using errcode = '23514', message = '예정재원 잔액이 원 요청금액과 일치하지 않습니다.';
  end if;
  perform public.financial_assert_project_baseline_ready(
    v_request.destination_project_id, v_pending.amount, 0, 0, v_lot.record_origin, false
  );
  v_destination_budget_year_id := public.financial_get_or_create_budget_year(
    v_request.destination_project_id, v_lot.budget_cohort_id, v_lot.fiscal_year, v_actor_id
  );
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'link_request_id', v_request.id, 'pending_fund_id', v_pending.id,
    'destination_project_id', v_request.destination_project_id,
    'amount', v_pending.amount
  ));
  insert into public.financial_unallocated_fund_movements (
    lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
    destination_project_id, destination_budget_year_id, amount,
    effective_date, record_origin, evidence_id, memo,
    idempotency_key, request_fingerprint, created_by, confirmed_by
  ) values (
    v_lot.id, v_lot.region_id, v_lot.budget_cohort_id,
    'ALLOCATE_EXISTING_PROJECT', 'NORMAL', v_request.destination_project_id,
    v_destination_budget_year_id, v_pending.amount, v_lot.effective_date,
    v_lot.record_origin, v_lot.evidence_id,
    '신규사업 예정재원 연결 · ' || v_pending.planned_project_name,
    v_request.idempotency_key, v_fingerprint, v_request.requested_by, v_actor_id
  ) returning id into v_movement_id;
  update public.financial_pending_new_project_funds
  set status = 'LINKED', linked_project_id = v_request.destination_project_id,
      linked_movement_id = v_movement_id, linked_by = v_actor_id,
      linked_at = clock_timestamp()
  where id = v_pending.id;
  update public.financial_pending_new_project_link_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
      materialized_movement_id = v_movement_id
  where id = v_request.id returning * into v_request;
  perform public.financial_write_audit(
    v_request.destination_project_id, v_pending.region_id,
    'PENDING_NEW_PROJECT_FUND_LINKED', 'financial_pending_new_project_funds',
    v_pending.id, v_actor_id,
    jsonb_build_object('amount', v_pending.amount, 'movement_id', v_movement_id,
      'source_request_id', v_pending.source_request_id)
  );
  return query select v_request.id, v_request.status, 0::bigint;
end;
$$;

create or replace function public.get_financial_budget_change_candidates(
  p_anchor_project_id uuid,
  p_search text default null,
  p_year integer default null,
  p_require_available boolean default false
)
returns table (
  project_id uuid, fiscal_year integer, project_code text, project_name text,
  source_budget_year_id uuid, available_amount bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_anchor_region uuid; v_anchor_year integer;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select region_id, year into v_anchor_region, v_anchor_year
  from public.projects where id = p_anchor_project_id;
  if not found or (v_role = 'local_user' and v_anchor_region <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '조회할 수 없는 사업입니다.';
  end if;
  return query
  select projects.id, projects.year, projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''),
      nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null
        then '사업명 확인 필요 (' || projects.project_code || ')'
        else '사업명 확인 필요' end)::text,
    source_wallet.id, coalesce(source_wallet.available_amount, 0)::bigint
  from public.projects
  left join lateral (
    select wallets.id, balance.accounting_balance::bigint as available_amount
    from public.project_budget_years as wallets
    cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
    where wallets.project_id = projects.id
    order by balance.accounting_balance desc, wallets.id
    limit 1
  ) as source_wallet on true
  where projects.region_id = v_anchor_region
    and projects.id <> p_anchor_project_id
    and projects.year <= v_anchor_year
    and (p_year is null or projects.year = p_year)
    and (nullif(btrim(coalesce(p_search, '')), '') is null
      or coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name, '')
        ilike '%' || btrim(p_search) || '%'
      or coalesce(projects.project_code, '') ilike '%' || btrim(p_search) || '%')
    and exists (
      select 1 from public.project_budget_years as candidate_wallets
      where candidate_wallets.project_id = projects.id
    )
    and (not p_require_available or coalesce(source_wallet.available_amount, 0) > 0)
  order by projects.year desc, project_name, projects.project_code;
end;
$$;

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
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' and p_region_id is not null and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '다른 지역의 예산 조정은 조회할 수 없습니다.';
  end if;
  return query
  select requests.id, requests.region_id, requests.fiscal_year,
    requests.source_project_id, source.project_code::text,
    coalesce(nullif(btrim(source.detail_project_name), ''),
      nullif(btrim(source.fund_project_name), ''), nullif(btrim(source.project_name), ''),
      case when source.project_code is not null then '사업명 확인 필요 (' || source.project_code || ')'
        else '사업명 확인 필요' end)::text,
    requests.total_amount, requests.decrease_amount_before, requests.decrease_amount_after,
    requests.effective_date, requests.reason, requests.status, requests.requested_by,
    requests.requested_at, requests.rejection_reason,
    coalesce((select jsonb_agg(jsonb_build_object(
      'line_id', lines.id, 'line_no', lines.line_no,
      'destination_type', lines.destination_type,
      'destination_project_id', lines.destination_project_id,
      'destination_project_code', destination.project_code,
      'destination_project_name', coalesce(nullif(btrim(destination.detail_project_name), ''),
        nullif(btrim(destination.fund_project_name), ''), nullif(btrim(destination.project_name), ''),
        case when destination.project_code is not null
          then '사업명 확인 필요 (' || destination.project_code || ')' else null end),
      'planned_project_name', lines.planned_project_name,
      'planned_project_year', lines.planned_project_year,
      'amount', lines.amount, 'note', lines.note,
      'pending_fund_id', lines.pending_fund_id
    ) order by lines.line_no)
    from public.financial_budget_change_request_lines as lines
    left join public.projects as destination on destination.id = lines.destination_project_id
    where lines.request_id = requests.id), '[]'::jsonb)
  from public.financial_budget_change_requests as requests
  join public.projects as source on source.id = requests.source_project_id
  where (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_region_id is null or requests.region_id = p_region_id)
    and (p_year is null or requests.fiscal_year = p_year)
    and (p_status is null or requests.status = p_status)
    and (p_project_id is null or requests.source_project_id = p_project_id
      or exists (select 1 from public.financial_budget_change_request_lines as project_lines
        where project_lines.request_id = requests.id
          and project_lines.destination_project_id = p_project_id)
      or exists (select 1 from public.financial_pending_new_project_funds as pending
        where pending.source_request_id = requests.id and pending.linked_project_id = p_project_id))
  order by requests.requested_at desc;
end;
$$;

create or replace function public.get_financial_pending_new_project_funds(
  p_status text default null,
  p_year integer default null,
  p_region_id uuid default null
)
returns table (
  id uuid, region_id uuid, fiscal_year integer,
  planned_project_name text, planned_project_year integer, amount bigint,
  status text, source_project_id uuid, source_project_code text,
  source_project_name text, source_request_id uuid,
  linked_project_id uuid, linked_project_code text, linked_project_name text,
  created_at timestamptz, linked_at timestamptz
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
    raise exception using errcode = '42501', message = '다른 지역의 예정재원은 조회할 수 없습니다.';
  end if;
  return query
  select pending.id, pending.region_id, pending.fiscal_year,
    pending.planned_project_name, pending.planned_project_year, pending.amount,
    pending.status, requests.source_project_id, source.project_code::text,
    coalesce(nullif(btrim(source.detail_project_name), ''),
      nullif(btrim(source.fund_project_name), ''), nullif(btrim(source.project_name), ''),
      case when source.project_code is not null then '사업명 확인 필요 (' || source.project_code || ')'
        else '사업명 확인 필요' end)::text,
    pending.source_request_id, pending.linked_project_id, linked.project_code::text,
    coalesce(nullif(btrim(linked.detail_project_name), ''),
      nullif(btrim(linked.fund_project_name), ''), nullif(btrim(linked.project_name), ''),
      case when linked.project_code is not null then '사업명 확인 필요 (' || linked.project_code || ')'
        else null end)::text,
    pending.created_at, pending.linked_at
  from public.financial_pending_new_project_funds as pending
  join public.financial_budget_change_requests as requests on requests.id = pending.source_request_id
  join public.projects as source on source.id = requests.source_project_id
  left join public.projects as linked on linked.id = pending.linked_project_id
  where (v_role = 'admin' or pending.region_id = v_actor_region_id)
    and (p_region_id is null or pending.region_id = p_region_id)
    and (p_year is null or pending.planned_project_year = p_year)
    and (p_status is null or pending.status = p_status)
  order by pending.created_at desc;
end;
$$;

create or replace function public.get_financial_pending_new_project_link_requests(p_status text default null)
returns table (
  id uuid, pending_fund_id uuid, region_id uuid,
  destination_project_id uuid, destination_project_code text,
  destination_project_name text, planned_project_name text,
  planned_project_year integer, amount bigint, status text,
  requested_by uuid, requested_at timestamptz, rejection_reason text
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
  return query
  select requests.id, requests.pending_fund_id, requests.region_id,
    requests.destination_project_id, projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''), nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null then '사업명 확인 필요 (' || projects.project_code || ')'
        else '사업명 확인 필요' end)::text,
    pending.planned_project_name, pending.planned_project_year, requests.amount,
    requests.status, requests.requested_by, requests.requested_at, requests.rejection_reason
  from public.financial_pending_new_project_link_requests as requests
  join public.financial_pending_new_project_funds as pending on pending.id = requests.pending_fund_id
  join public.projects on projects.id = requests.destination_project_id
  where (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_status is null or requests.status = p_status)
  order by requests.requested_at desc;
end;
$$;

create or replace function public.get_financial_budget_change_project_position(p_project_id uuid)
returns table (
  project_id uuid, original_allocation bigint, increase_amount bigint,
  decrease_amount bigint, adjusted_allocation bigint, execution_amount bigint,
  unexecuted_amount bigint, execution_rate numeric, valid_execution boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid; v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select region_id into v_region_id from public.projects where id = p_project_id;
  if not found or (v_role = 'local_user' and v_region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '조회할 수 없는 사업입니다.';
  end if;
  return query
  with base as (
    select projects.id,
      coalesce(projects.original_alloc,
        projects.alloc + coalesce(projects.decrease_amount, 0) - coalesce(projects.increase_amount, 0),
        projects.alloc, 0)::bigint as original_amount,
      coalesce(projects.increase_amount, 0)::bigint as base_increase,
      coalesce(projects.decrease_amount, 0)::bigint as base_decrease,
      coalesce(positions.ledger_execution_amount, projects.exec, 0)::bigint as execution_amount
    from public.projects
    left join public.financial_project_funding_positions as positions
      on positions.project_id = projects.id and positions.projection_ready
    where projects.id = p_project_id
  ), effects as (
    select
      coalesce((select sum(lines.amount)::bigint
        from public.financial_budget_change_request_lines as lines
        join public.financial_budget_change_requests as requests on requests.id = lines.request_id
        where requests.status = 'APPLIED' and lines.destination_type = 'EXISTING_PROJECT'
          and lines.destination_project_id = p_project_id), 0)::bigint
      + coalesce((select sum(pending.amount)::bigint
        from public.financial_pending_new_project_funds as pending
        where pending.status = 'LINKED' and pending.linked_project_id = p_project_id), 0)::bigint
        as inbound_amount,
      coalesce((select sum(requests.total_amount)::bigint
        from public.financial_budget_change_requests as requests
        where requests.status = 'APPLIED' and requests.source_project_id = p_project_id), 0)::bigint
        as outbound_amount
  )
  select base.id, base.original_amount,
    (base.base_increase + effects.inbound_amount)::bigint,
    (base.base_decrease + effects.outbound_amount)::bigint,
    (base.original_amount + base.base_increase + effects.inbound_amount
      - base.base_decrease - effects.outbound_amount)::bigint as adjusted,
    base.execution_amount,
    (base.original_amount + base.base_increase + effects.inbound_amount
      - base.base_decrease - effects.outbound_amount - base.execution_amount)::bigint,
    case when base.original_amount + base.base_increase + effects.inbound_amount
      - base.base_decrease - effects.outbound_amount > 0 then round(
        base.execution_amount::numeric * 100 /
        (base.original_amount + base.base_increase + effects.inbound_amount
          - base.base_decrease - effects.outbound_amount)::numeric, 2)
      else 0::numeric end,
    base.execution_amount <= base.original_amount + base.base_increase + effects.inbound_amount
      - base.base_decrease - effects.outbound_amount
  from base cross join effects;
end;
$$;

create or replace function public.get_financial_budget_change_statistics(
  p_year integer default null,
  p_region_id uuid default null
)
returns table (
  transfer_amount bigint, transfer_count bigint,
  new_project_allocated_amount bigint, new_project_allocated_count bigint,
  pending_new_project_amount bigint, pending_new_project_count bigint,
  applied_request_count bigint, transaction_gap_amount bigint
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
  if v_role = 'local_user' then
    if p_region_id is not null and p_region_id <> v_actor_region_id then
      raise exception using errcode = '42501', message = '다른 지역의 통계는 조회할 수 없습니다.';
    end if;
    p_region_id := v_actor_region_id;
  end if;
  return query
  select
    coalesce((select sum(lines.amount)::bigint
      from public.financial_budget_change_request_lines as lines
      join public.financial_budget_change_requests as requests on requests.id = lines.request_id
      where requests.status = 'APPLIED' and lines.destination_type = 'EXISTING_PROJECT'
        and (p_year is null or requests.fiscal_year = p_year)
        and (p_region_id is null or requests.region_id = p_region_id)), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_budget_change_request_lines as lines
      join public.financial_budget_change_requests as requests on requests.id = lines.request_id
      where requests.status = 'APPLIED' and lines.destination_type = 'EXISTING_PROJECT'
        and (p_year is null or requests.fiscal_year = p_year)
        and (p_region_id is null or requests.region_id = p_region_id)), 0)::bigint,
    coalesce((select sum(pending.amount)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'LINKED'
        and (p_year is null or pending.planned_project_year = p_year)
        and (p_region_id is null or pending.region_id = p_region_id)), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'LINKED'
        and (p_year is null or pending.planned_project_year = p_year)
        and (p_region_id is null or pending.region_id = p_region_id)), 0)::bigint,
    coalesce((select sum(pending.amount)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (p_region_id is null or pending.region_id = p_region_id)), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (p_region_id is null or pending.region_id = p_region_id)), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_budget_change_requests as requests
      where requests.status = 'APPLIED'
        and (p_year is null or requests.fiscal_year = p_year)
        and (p_region_id is null or requests.region_id = p_region_id)), 0)::bigint,
    0::bigint;
end;
$$;

create or replace function public.get_financial_budget_change_statistics_filtered(
  p_year integer default null,
  p_sido text default null,
  p_sigungu text default null
)
returns table (
  transfer_amount bigint, transfer_count bigint,
  new_project_allocated_amount bigint, new_project_allocated_count bigint,
  pending_new_project_amount bigint, pending_new_project_count bigint,
  applied_request_count bigint, transaction_gap_amount bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_region_ids uuid[];
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' then
    select array_agg(regions.id) into v_region_ids
    from public.regions
    where regions.id = v_actor_region_id
      and (p_sido is null or regions.sido = p_sido)
      and (p_sigungu is null or regions.sigungu = p_sigungu);
    v_region_ids := coalesce(v_region_ids, array[]::uuid[]);
  elsif p_sido is not null or p_sigungu is not null then
    select array_agg(regions.id) into v_region_ids
    from public.regions
    where (p_sido is null or regions.sido = p_sido)
      and (p_sigungu is null or regions.sigungu = p_sigungu);
    v_region_ids := coalesce(v_region_ids, array[]::uuid[]);
  else
    v_region_ids := null;
  end if;
  return query
  select
    coalesce((select sum(lines.amount)::bigint
      from public.financial_budget_change_request_lines as lines
      join public.financial_budget_change_requests as requests on requests.id = lines.request_id
      where requests.status = 'APPLIED' and lines.destination_type = 'EXISTING_PROJECT'
        and (p_year is null or requests.fiscal_year = p_year)
        and (v_region_ids is null or requests.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_budget_change_request_lines as lines
      join public.financial_budget_change_requests as requests on requests.id = lines.request_id
      where requests.status = 'APPLIED' and lines.destination_type = 'EXISTING_PROJECT'
        and (p_year is null or requests.fiscal_year = p_year)
        and (v_region_ids is null or requests.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select sum(pending.amount)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'LINKED'
        and (p_year is null or pending.planned_project_year = p_year)
        and (v_region_ids is null or pending.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'LINKED'
        and (p_year is null or pending.planned_project_year = p_year)
        and (v_region_ids is null or pending.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select sum(pending.amount)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (v_region_ids is null or pending.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (v_region_ids is null or pending.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_budget_change_requests as requests
      where requests.status = 'APPLIED'
        and (p_year is null or requests.fiscal_year = p_year)
        and (v_region_ids is null or requests.region_id = any(v_region_ids))), 0)::bigint,
    0::bigint;
end;
$$;

alter table public.financial_budget_change_requests enable row level security;
alter table public.financial_budget_change_request_lines enable row level security;
alter table public.financial_pending_new_project_funds enable row level security;
alter table public.financial_pending_new_project_link_requests enable row level security;
alter table public.financial_budget_change_requests force row level security;
alter table public.financial_budget_change_request_lines force row level security;
alter table public.financial_pending_new_project_funds force row level security;
alter table public.financial_pending_new_project_link_requests force row level security;

create policy financial_budget_change_requests_select_region_or_admin
  on public.financial_budget_change_requests for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = financial_budget_change_requests.region_id))
  );
create policy financial_budget_change_lines_select_region_or_admin
  on public.financial_budget_change_request_lines for select to authenticated using (
    exists (select 1 from public.financial_budget_change_requests as requests
      where requests.id = financial_budget_change_request_lines.request_id)
  );
create policy financial_pending_new_project_funds_select_region_or_admin
  on public.financial_pending_new_project_funds for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = financial_pending_new_project_funds.region_id))
  );
create policy financial_pending_link_requests_select_region_or_admin
  on public.financial_pending_new_project_link_requests for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = financial_pending_new_project_link_requests.region_id))
  );

revoke all on table
  public.financial_budget_change_requests,
  public.financial_budget_change_request_lines,
  public.financial_pending_new_project_funds,
  public.financial_pending_new_project_link_requests
from public, anon, authenticated;
grant select on table
  public.financial_budget_change_requests,
  public.financial_budget_change_request_lines,
  public.financial_pending_new_project_funds,
  public.financial_pending_new_project_link_requests
to authenticated;
grant select on table
  public.financial_budget_change_requests,
  public.financial_budget_change_request_lines,
  public.financial_pending_new_project_funds,
  public.financial_pending_new_project_link_requests
to service_role;

revoke all on function public.financial_budget_change_visible_decrease(uuid) from public, anon, authenticated;
revoke all on function public.financial_validate_budget_change_request(uuid) from public, anon, authenticated;

revoke all on function public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean) from public, anon;
grant execute on function public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean) to authenticated;
revoke all on function public.financial_submit_budget_change_request(uuid) from public, anon;
grant execute on function public.financial_submit_budget_change_request(uuid) to authenticated;
revoke all on function public.financial_approve_budget_change_request(uuid) from public, anon;
grant execute on function public.financial_approve_budget_change_request(uuid) to authenticated;
revoke all on function public.financial_reject_budget_change_request(uuid,text) from public, anon;
grant execute on function public.financial_reject_budget_change_request(uuid,text) to authenticated;
revoke all on function public.financial_apply_budget_change_request(uuid) from public, anon;
grant execute on function public.financial_apply_budget_change_request(uuid) to authenticated;
revoke all on function public.financial_request_pending_new_project_link(uuid,uuid,uuid) from public, anon;
grant execute on function public.financial_request_pending_new_project_link(uuid,uuid,uuid) to authenticated;
revoke all on function public.financial_review_pending_new_project_link(uuid,text,text) from public, anon;
grant execute on function public.financial_review_pending_new_project_link(uuid,text,text) to authenticated;
revoke all on function public.financial_apply_pending_new_project_link(uuid) from public, anon;
grant execute on function public.financial_apply_pending_new_project_link(uuid) to authenticated;
revoke all on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) from public, anon;
grant execute on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) to authenticated;
revoke all on function public.get_financial_budget_change_requests(uuid,text,integer,uuid) from public, anon;
grant execute on function public.get_financial_budget_change_requests(uuid,text,integer,uuid) to authenticated;
revoke all on function public.get_financial_pending_new_project_funds(text,integer,uuid) from public, anon;
grant execute on function public.get_financial_pending_new_project_funds(text,integer,uuid) to authenticated;
revoke all on function public.get_financial_pending_new_project_link_requests(text) from public, anon;
grant execute on function public.get_financial_pending_new_project_link_requests(text) to authenticated;
revoke all on function public.get_financial_budget_change_project_position(uuid) from public, anon;
grant execute on function public.get_financial_budget_change_project_position(uuid) to authenticated;
revoke all on function public.get_financial_budget_change_statistics(integer,uuid) from public, anon;
grant execute on function public.get_financial_budget_change_statistics(integer,uuid) to authenticated;
revoke all on function public.get_financial_budget_change_statistics_filtered(integer,text,text) from public, anon;
grant execute on function public.get_financial_budget_change_statistics_filtered(integer,text,text) to authenticated;

commit;
