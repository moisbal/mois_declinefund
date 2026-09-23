-- TEST-only repair for the local new-project funding-source workflow.
-- Production is intentionally rejected before any DDL is executed.

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
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      '승인된 TEST 신규 운영거래 환경에서만 신규사업 재원 연결을 보정할 수 있습니다.';
  end if;

  if to_regclass('public.financial_pending_new_project_funds') is null
     or to_regprocedure('public.financial_test_uat_save_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regprocedure('public.financial_submit_budget_change_request(uuid)') is null then
    raise exception using errcode = '55000', message =
      '신규사업 재원 연결 보정에 필요한 예산조정 기능이 없습니다.';
  end if;
end;
$$;

create temporary table new_project_funding_workflow_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric project_allocation,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric project_execution,
  (select count(*) from public.financial_new_project_requests)::bigint new_request_count,
  (select count(*) from public.financial_budget_change_requests)::bigint budget_request_count,
  (select count(*) from public.financial_budget_change_request_lines)::bigint budget_line_count,
  (select count(*) from public.financial_pending_new_project_funds)::bigint pending_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint movement_count;

alter table public.financial_new_project_requests
  add column if not exists linked_from_standalone boolean not null default false;

alter table public.financial_new_project_requests
  drop constraint if exists financial_new_project_requests_requested_amount_check,
  drop constraint if exists financial_new_project_requests_source_shape;

alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_requested_amount_check
    check (requested_amount >= 0),
  add constraint financial_new_project_requests_source_shape check (
    (
      source_budget_change_request_id is null
      and source_budget_change_line_id is null
      and linked_from_standalone = false
      and (
        (source_lot_id is not null and requested_amount > 0)
        or (source_lot_id is null and status = 'DRAFT')
      )
    )
    or (
      source_budget_change_request_id is not null
      and source_budget_change_line_id is not null
      and source_lot_id is null
      and requested_amount > 0
    )
  );

do $$
begin
  if exists (
    select source_lot_id
    from public.financial_new_project_requests
    where source_lot_id is not null
      and status in ('DRAFT', 'SUBMITTED', 'APPROVED')
    group by source_lot_id
    having count(*) > 1
  ) then
    raise exception using errcode = '55000', message =
      '하나의 대기재원에 둘 이상의 진행 중 신규사업 요청이 연결되어 있습니다.';
  end if;
end;
$$;

create unique index if not exists financial_new_project_requests_one_active_source_uidx
  on public.financial_new_project_requests(source_lot_id)
  where source_lot_id is not null and status in ('DRAFT', 'SUBMITTED', 'APPROVED');

create or replace function public.get_financial_new_project_funding_sources(
  p_year integer default null,
  p_request_id uuid default null
)
returns table (
  pending_fund_id uuid,
  source_lot_id uuid,
  region_id uuid,
  source_fiscal_year integer,
  target_fiscal_year integer,
  planned_project_name text,
  amount bigint,
  remaining_amount bigint,
  pending_status text,
  source_project_id uuid,
  source_project_code text,
  source_project_name text,
  claimed_request_id uuid,
  claimed_request_status text,
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
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;

  if p_year is not null and p_year not between 2000 and 2200 then
    raise exception using errcode = '22023', message = '조회할 사업연도를 확인해 주세요.';
  end if;

  return query
  select
    pending.id,
    pending.lot_id,
    pending.region_id,
    pending.fiscal_year,
    pending.planned_project_year,
    pending.planned_project_name,
    pending.amount,
    balances.remaining_amount,
    pending.status,
    lots.source_project_id,
    source.project_code::text,
    coalesce(
      nullif(btrim(source.detail_project_name), ''),
      nullif(btrim(source.fund_project_name), ''),
      nullif(btrim(source.project_name), ''),
      '사업명 확인 필요'
    )::text,
    claimed.id,
    claimed.status,
    pending.created_at
  from public.financial_pending_new_project_funds as pending
  join public.financial_unallocated_fund_lots as lots on lots.id = pending.lot_id
  join public.financial_unallocated_fund_lot_balances as balances on balances.lot_id = pending.lot_id
  join public.projects as source on source.id = lots.source_project_id
  left join lateral (
    select requests.id, requests.status, requests.requested_by
    from public.financial_new_project_requests as requests
    where requests.source_lot_id = pending.lot_id
      and requests.status in ('DRAFT', 'SUBMITTED', 'APPROVED')
    order by requests.requested_at desc
    limit 1
  ) as claimed on true
  where pending.status = 'WAITING'
    and balances.remaining_amount > 0
    and balances.remaining_amount >= pending.amount
    and (v_role = 'admin' or pending.region_id = v_actor_region_id)
    and (p_year is null or pending.planned_project_year = p_year)
    and not exists (
      select 1
      from public.financial_pending_new_project_link_requests as links
      where links.pending_fund_id = pending.id
        and links.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
    )
    and (
      claimed.id is null
      or (
        p_request_id is not null
        and claimed.id = p_request_id
        and claimed.status = 'DRAFT'
        and claimed.requested_by = v_actor_id
      )
    )
  order by pending.planned_project_year, pending.created_at desc;
end;
$$;

create or replace function public.get_financial_attachable_new_project_drafts(
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
  select
    requests.id,
    requests.region_id,
    requests.fiscal_year,
    requests.project_name,
    requests.fund_project_name,
    requests.detail_project_name,
    requests.project_period,
    requests.project_start_year,
    requests.project_end_year,
    requests.project_status,
    requests.business_type,
    requests.large_category_id,
    requests.middle_category_id,
    requests.requested_amount,
    requests.status,
    requests.requested_at
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

create or replace function public.financial_save_new_project_request_draft(
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
  p_idempotency_key uuid
)
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
  v_request public.financial_new_project_requests%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_remaining bigint;
  v_payload jsonb;
  v_fingerprint text;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;

  if p_region_id is null
     or p_fiscal_year not between 2000 and 2200
     or p_idempotency_key is null
     or char_length(btrim(coalesce(p_project_name, ''))) not between 1 and 500
     or char_length(coalesce(p_fund_project_name, '')) > 500
     or char_length(coalesce(p_detail_project_name, '')) > 500
     or char_length(coalesce(p_project_period, '')) > 200
     or char_length(coalesce(p_status, '')) > 100
     or p_business_type not in ('HW', 'SW', 'COMPOSITE')
     or ((p_large_category_id is null) <> (p_middle_category_id is null))
     or p_project_start_year not between 2000 and 2200
     or p_project_end_year not between 2000 and 2200
     or p_project_start_year > p_project_end_year
     or p_requested_amount is null
     or p_requested_amount < 0
     or (p_source_lot_id is not null and p_requested_amount <= 0) then
    raise exception using errcode = '22023', message = '신규사업 작성값을 확인해 주세요.';
  end if;

  if v_role = 'local_user' and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '자기 지역의 신규사업만 작성할 수 있습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  if p_request_id is not null then
    select requests.* into v_request
    from public.financial_new_project_requests as requests
    where requests.id = p_request_id
    for update;
  else
    select requests.* into v_request
    from public.financial_new_project_requests as requests
    where requests.idempotency_key = p_idempotency_key
    for update;
  end if;

  if found and (
    v_request.status <> 'DRAFT'
    or v_request.requested_by <> v_actor_id
    or v_request.region_id <> p_region_id
    or v_request.fiscal_year <> p_fiscal_year
    or v_request.source_budget_change_request_id is not null
    or v_request.source_budget_change_line_id is not null
  ) then
    raise exception using errcode = '42501', message =
      '요청자 본인의 독립 신규사업 초안만 수정할 수 있습니다.';
  end if;

  if p_request_id is not null and v_request.id is null then
    raise exception using errcode = 'P0002', message = '수정할 신규사업 초안을 찾을 수 없습니다.';
  end if;

  if p_source_lot_id is not null then
    select pending.*
      into v_pending
    from public.financial_pending_new_project_funds as pending
    join public.financial_unallocated_fund_lots as lots on lots.id = pending.lot_id
    where pending.lot_id = p_source_lot_id
    for update of pending, lots;

    if found then
      select balances.remaining_amount into v_remaining
      from public.financial_unallocated_fund_lot_balances as balances
      where balances.lot_id = p_source_lot_id;
    end if;

    if not found
       or v_pending.status <> 'WAITING'
       or v_pending.region_id <> p_region_id
       or v_pending.planned_project_year <> p_fiscal_year
       or v_pending.amount <> p_requested_amount
       or v_remaining < p_requested_amount then
      raise exception using errcode = '23514', message =
        '선택한 대기재원의 지역·대상연도·금액 또는 잔액이 신규사업과 일치하지 않습니다.';
    end if;

    if exists (
      select 1
      from public.financial_pending_new_project_link_requests as links
      where links.pending_fund_id = v_pending.id
        and links.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
    ) or exists (
      select 1
      from public.financial_new_project_requests as other
      where other.source_lot_id = p_source_lot_id
        and other.id is distinct from v_request.id
        and other.status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED')
    ) then
      raise exception using errcode = '23505', message = '이미 다른 신규사업에 연결된 대기재원입니다.';
    end if;
  end if;

  v_payload := jsonb_build_object(
    'region_id', p_region_id,
    'fiscal_year', p_fiscal_year,
    'project_name', btrim(p_project_name),
    'fund_project_name', nullif(btrim(coalesce(p_fund_project_name, '')), ''),
    'detail_project_name', nullif(btrim(coalesce(p_detail_project_name, '')), ''),
    'project_period', nullif(btrim(coalesce(p_project_period, '')), ''),
    'project_start_year', p_project_start_year,
    'project_end_year', p_project_end_year,
    'project_status', nullif(btrim(coalesce(p_status, '')), ''),
    'business_type', p_business_type,
    'large_category_id', p_large_category_id,
    'middle_category_id', p_middle_category_id,
    'source_lot_id', p_source_lot_id,
    'requested_amount', p_requested_amount
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);

  if v_request.id is null then
    insert into public.financial_new_project_requests (
      region_id, fiscal_year, project_name, fund_project_name, detail_project_name,
      project_period, project_start_year, project_end_year, project_status, business_type,
      large_category_id, middle_category_id, source_lot_id, requested_amount,
      status, idempotency_key, request_fingerprint, requested_by
    ) values (
      p_region_id, p_fiscal_year, btrim(p_project_name),
      nullif(btrim(coalesce(p_fund_project_name, '')), ''),
      nullif(btrim(coalesce(p_detail_project_name, '')), ''),
      nullif(btrim(coalesce(p_project_period, '')), ''),
      p_project_start_year, p_project_end_year,
      nullif(btrim(coalesce(p_status, '')), ''), p_business_type,
      p_large_category_id, p_middle_category_id, p_source_lot_id, p_requested_amount,
      'DRAFT', p_idempotency_key, v_fingerprint, v_actor_id
    ) returning * into v_request;
  else
    update public.financial_new_project_requests as requests
    set project_name = btrim(p_project_name),
        fund_project_name = nullif(btrim(coalesce(p_fund_project_name, '')), ''),
        detail_project_name = nullif(btrim(coalesce(p_detail_project_name, '')), ''),
        project_period = nullif(btrim(coalesce(p_project_period, '')), ''),
        project_start_year = p_project_start_year,
        project_end_year = p_project_end_year,
        project_status = nullif(btrim(coalesce(p_status, '')), ''),
        business_type = p_business_type,
        large_category_id = p_large_category_id,
        middle_category_id = p_middle_category_id,
        source_lot_id = p_source_lot_id,
        requested_amount = p_requested_amount,
        request_fingerprint = v_fingerprint
    where requests.id = v_request.id
    returning requests.* into v_request;
  end if;

  return query select v_request.id, v_request.status;
exception
  when unique_violation then
    raise exception using errcode = '23505', message = '이미 다른 신규사업에 연결된 대기재원입니다.';
end;
$$;

create or replace function public.financial_submit_new_project_request(p_request_id uuid)
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
  v_request public.financial_new_project_requests%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_remaining bigint;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;

  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.id = p_request_id
  for update;

  if not found
     or v_request.status <> 'DRAFT'
     or v_request.requested_by <> v_actor_id
     or v_request.source_budget_change_request_id is not null
     or v_request.source_budget_change_line_id is not null
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message =
      '요청자 본인의 독립 신규사업 초안만 제출할 수 있습니다.';
  end if;

  if v_request.source_lot_id is null or v_request.requested_amount <= 0 then
    raise exception using errcode = '23514', message =
      '승인요청 전에 연결할 대기재원을 선택해 주세요.';
  end if;

  select pending.*
    into v_pending
  from public.financial_pending_new_project_funds as pending
  join public.financial_unallocated_fund_lots as lots on lots.id = pending.lot_id
  where pending.lot_id = v_request.source_lot_id
  for update of pending, lots;

  if found then
    select balances.remaining_amount into v_remaining
    from public.financial_unallocated_fund_lot_balances as balances
    where balances.lot_id = v_request.source_lot_id;
  end if;

  if not found
     or v_pending.status <> 'WAITING'
     or v_pending.region_id <> v_request.region_id
     or v_pending.planned_project_year <> v_request.fiscal_year
     or v_pending.amount <> v_request.requested_amount
     or v_remaining < v_request.requested_amount
     or exists (
       select 1
       from public.financial_pending_new_project_link_requests as links
       where links.pending_fund_id = v_pending.id
         and links.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
     ) then
    raise exception using errcode = '23514', message =
      '대기재원이 더 이상 제출 조건을 충족하지 않습니다. 재원을 다시 선택해 주세요.';
  end if;

  update public.financial_new_project_requests as requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where requests.id = v_request.id
  returning requests.* into v_request;

  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_test_uat_save_budget_change_request_with_drafts(
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
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_parent public.financial_budget_change_requests%rowtype;
  v_item jsonb;
  v_ordinality bigint;
  v_existing_id uuid;
  v_existing_ids uuid[] := array[]::uuid[];
  v_existing public.financial_new_project_requests%rowtype;
  v_line public.financial_budget_change_request_lines%rowtype;
  v_generated_id uuid;
  v_saved record;
  v_fingerprint text;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor.actor_id into v_actor_id
  from public.financial_require_actor() as actor;

  if jsonb_typeof(p_destinations) <> 'array' then
    raise exception using errcode = '22023', message = '예산조정 목적지를 확인해 주세요.';
  end if;

  for v_item, v_ordinality in
    select items.value, items.ordinality
    from jsonb_array_elements(p_destinations) with ordinality as items(value, ordinality)
  loop
    if nullif(v_item ->> 'existing_new_project_request_id', '') is not null then
      if v_item ->> 'destination_type' <> 'PENDING_NEW_PROJECT' then
        raise exception using errcode = '23514', message =
          '기존 신규사업 초안은 차년도 신규사업 목적지에만 연결할 수 있습니다.';
      end if;
      v_existing_id := (v_item ->> 'existing_new_project_request_id')::uuid;
      if v_existing_id = any(v_existing_ids) then
        raise exception using errcode = '23505', message = '같은 신규사업 초안을 중복 연결할 수 없습니다.';
      end if;
      v_existing_ids := array_append(v_existing_ids, v_existing_id);
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select requests.* into v_parent
  from public.financial_budget_change_requests as requests
  where requests.idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_parent.status <> 'DRAFT' or v_parent.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message = '작성 중인 본인 예산조정만 수정할 수 있습니다.';
    end if;

    update public.financial_new_project_requests as requests
    set source_budget_change_request_id = null,
        source_budget_change_line_id = null,
        linked_from_standalone = false
    where requests.source_budget_change_request_id = v_parent.id
      and requests.linked_from_standalone = true
      and requests.status = 'DRAFT';
  end if;

  select saved.* into v_saved
  from public.financial_test_uat_save_budget_change_request(
    p_source_project_id,
    p_source_budget_year_id,
    p_destinations,
    p_effective_date,
    p_reason,
    p_idempotency_key,
    false
  ) as saved;

  select requests.* into v_parent
  from public.financial_budget_change_requests as requests
  where requests.id = v_saved.request_id
  for update;

  for v_item, v_ordinality in
    select items.value, items.ordinality
    from jsonb_array_elements(p_destinations) with ordinality as items(value, ordinality)
  loop
    if nullif(v_item ->> 'existing_new_project_request_id', '') is null then
      continue;
    end if;

    v_existing_id := (v_item ->> 'existing_new_project_request_id')::uuid;
    select requests.* into v_existing
    from public.financial_new_project_requests as requests
    where requests.id = v_existing_id
    for update;

    if not found
       or v_existing.requested_by <> v_actor_id
       or v_existing.status <> 'DRAFT'
       or v_existing.region_id <> v_parent.region_id
       or v_existing.fiscal_year <> v_parent.fiscal_year + 1
       or v_existing.source_lot_id is not null
       or v_existing.source_budget_change_request_id is not null
       or v_existing.source_budget_change_line_id is not null
       or v_existing.materialized_project_id is not null then
      raise exception using errcode = '23514', message =
        '같은 지자체·다음연도의 독립 무재원 신규사업 초안만 연결할 수 있습니다.';
    end if;

    select lines.* into v_line
    from public.financial_budget_change_request_lines as lines
    where lines.request_id = v_parent.id
      and lines.line_no = v_ordinality
      and lines.destination_type = 'PENDING_NEW_PROJECT'
    for update;

    if not found or v_line.new_project_request_id is null then
      raise exception using errcode = '55000', message = '신규사업 목적지 연결 행을 찾을 수 없습니다.';
    end if;

    v_generated_id := v_line.new_project_request_id;
    update public.financial_budget_change_request_lines as lines
    set new_project_request_id = null
    where lines.id = v_line.id;

    delete from public.financial_new_project_requests as requests
    where requests.id = v_generated_id
      and requests.source_budget_change_request_id = v_parent.id
      and requests.source_budget_change_line_id = v_line.id
      and requests.linked_from_standalone = false
      and requests.status = 'DRAFT';

    if found is false then
      raise exception using errcode = '55000', message = '자동 생성된 신규사업 초안을 교체하지 못했습니다.';
    end if;

    v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'budget_change_request_id', v_parent.id,
      'budget_change_line_id', v_line.id,
      'project_name', v_existing.project_name,
      'fiscal_year', v_existing.fiscal_year,
      'requested_amount', (v_item ->> 'amount')::bigint,
      'linked_from_standalone', true
    ));

    update public.financial_new_project_requests as requests
    set requested_amount = (v_item ->> 'amount')::bigint,
        source_budget_change_request_id = v_parent.id,
        source_budget_change_line_id = v_line.id,
        linked_from_standalone = true,
        request_fingerprint = v_fingerprint
    where requests.id = v_existing.id;

    update public.financial_budget_change_request_lines as lines
    set new_project_request_id = v_existing.id,
        planned_project_name = v_existing.project_name,
        planned_project_year = v_existing.fiscal_year,
        planned_fund_project_name = v_existing.fund_project_name,
        planned_detail_project_name = v_existing.detail_project_name,
        planned_project_period = v_existing.project_period,
        planned_project_start_year = v_existing.project_start_year,
        planned_project_end_year = v_existing.project_end_year,
        planned_project_status = v_existing.project_status,
        planned_business_type = v_existing.business_type,
        planned_large_category_id = v_existing.large_category_id,
        planned_middle_category_id = v_existing.middle_category_id
    where lines.id = v_line.id;
  end loop;

  perform public.financial_validate_budget_change_request(v_parent.id);

  if p_submit then
    return query
    select submitted.request_id, submitted.status, 0::bigint
    from public.financial_submit_budget_change_request(v_parent.id) as submitted;
    return;
  end if;

  return query select v_parent.id, v_parent.status, 0::bigint;
exception
  when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed then
    raise exception using errcode = '22023', message = '사업 또는 금액 입력값을 확인해 주세요.';
end;
$$;

revoke all on function public.get_financial_new_project_funding_sources(integer,uuid) from public, anon;
grant execute on function public.get_financial_new_project_funding_sources(integer,uuid) to authenticated;
revoke all on function public.get_financial_attachable_new_project_drafts(uuid) from public, anon;
grant execute on function public.get_financial_attachable_new_project_drafts(uuid) to authenticated;
revoke all on function public.financial_save_new_project_request_draft(
  uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid
) from public, anon;
grant execute on function public.financial_save_new_project_request_draft(
  uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid
) to authenticated;
revoke all on function public.financial_submit_new_project_request(uuid) from public, anon;
grant execute on function public.financial_submit_new_project_request(uuid) to authenticated;
revoke all on function public.financial_test_uat_save_budget_change_request_with_drafts(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_test_uat_save_budget_change_request_with_drafts(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;

do $$
declare
  v_before new_project_funding_workflow_snapshot%rowtype;
  v_after new_project_funding_workflow_snapshot%rowtype;
  v_source_definition text;
  v_save_definition text;
  v_attach_definition text;
begin
  select * into v_before from new_project_funding_workflow_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric,
    (select count(*) from public.financial_new_project_requests)::bigint,
    (select count(*) from public.financial_budget_change_requests)::bigint,
    (select count(*) from public.financial_budget_change_request_lines)::bigint,
    (select count(*) from public.financial_pending_new_project_funds)::bigint,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint
  into v_after;

  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '신규사업 재원 연결 마이그레이션이 기존 TEST 업무 행 또는 금액을 변경했습니다.';
  end if;

  select lower(pg_get_functiondef(
    'public.get_financial_new_project_funding_sources(integer,uuid)'::regprocedure
  )) into v_source_definition;
  select lower(pg_get_functiondef(
    'public.financial_save_new_project_request_draft(uuid,uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid)'::regprocedure
  )) into v_save_definition;
  select lower(pg_get_functiondef(
    'public.financial_test_uat_save_budget_change_request_with_drafts(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure
  )) into v_attach_definition;

  if position('financial_pending_new_project_funds' in v_source_definition) = 0
     or position('remaining_amount > 0' in v_source_definition) = 0
     or position('p_requested_amount < 0' in v_save_definition) = 0
     or position('linked_from_standalone' in v_attach_definition) = 0
     or position('financial_submit_budget_change_request' in v_attach_definition) = 0 then
    raise exception using errcode = '55000', message = '신규사업 재원 연결 정의 검증에 실패했습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
