-- TEST-only hotfix: keep the original allocation baseline distinct from later
-- increases, and enforce the same-year/next-year reallocation contract.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.get_financial_budget_change_project_position(uuid)') is null
     or to_regprocedure('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)') is null then
    raise exception using errcode = '55000', message =
      'Budget-change conservation hotfix requires the approved TEST base delta.';
  end if;
end;
$$;

create or replace function public.financial_validate_budget_change_line_year()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_region_id uuid;
  v_fiscal_year integer;
  v_source_project_id uuid;
  v_destination_region uuid;
  v_destination_year integer;
  v_registered_project_id uuid;
begin
  select region_id, fiscal_year, source_project_id
    into v_region_id, v_fiscal_year, v_source_project_id
  from public.financial_budget_change_requests where id = new.request_id;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  if new.destination_type = 'EXISTING_PROJECT' then
    select region_id, year into v_destination_region, v_destination_year
    from public.projects where id = new.destination_project_id;
    if not found or v_destination_region <> v_region_id
       or v_destination_year <> v_fiscal_year
       or new.destination_project_id = v_source_project_id then
      raise exception using errcode = '23514', message =
        '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
    end if;
  elsif new.planned_project_year <> v_fiscal_year + 1 then
    raise exception using errcode = '23514', message =
      '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
  elsif coalesce(new.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
    if substring(new.note from 30) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = '등록된 차년도 사업을 다시 선택해 주세요.';
    end if;
    v_registered_project_id := substring(new.note from 30)::uuid;
    select region_id, year into v_destination_region, v_destination_year
    from public.projects where id = v_registered_project_id;
    if not found or v_destination_region <> v_region_id or v_destination_year <> v_fiscal_year + 1 then
      raise exception using errcode = '23514', message =
        '등록된 신규사업은 같은 지역의 다음 연도 사업이어야 합니다.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.get_financial_budget_change_next_year_candidates(
  p_anchor_project_id uuid,
  p_search text default null
)
returns table (
  project_id uuid, fiscal_year integer, project_code text, project_name text
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
        else '사업명 확인 필요' end)::text
  from public.projects
  where projects.region_id = v_anchor_region
    and projects.year = v_anchor_year + 1
    and (nullif(btrim(coalesce(p_search, '')), '') is null
      or coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name, '')
        ilike '%' || btrim(p_search) || '%'
      or coalesce(projects.project_code, '') ilike '%' || btrim(p_search) || '%')
  order by 4, 3;
end;
$$;

drop trigger if exists financial_validate_budget_change_line_year
  on public.financial_budget_change_request_lines;
create trigger financial_validate_budget_change_line_year
before insert or update on public.financial_budget_change_request_lines
for each row execute function public.financial_validate_budget_change_line_year();

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
  select projects.region_id, projects.year into v_region_id, v_year
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
         or v_year <> v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
      end if;
    elsif v_line.planned_project_year <> v_request.fiscal_year + 1 then
      raise exception using errcode = '23514', message =
        '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
    end if;
  end loop;
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
  if p_year is not null and p_year <> v_anchor_year then
    raise exception using errcode = '23514', message = '기존사업은 출처 사업과 같은 연도만 조회할 수 있습니다.';
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
    and projects.year = v_anchor_year
    and (nullif(btrim(coalesce(p_search, '')), '') is null
      or coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name, '')
        ilike '%' || btrim(p_search) || '%'
      or coalesce(projects.project_code, '') ilike '%' || btrim(p_search) || '%')
    and (not p_require_available or coalesce(source_wallet.available_amount, 0) > 0)
  order by 4, 3;
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
  with position as (
    select projects.id,
      case when coalesce(projects.original_alloc, 0) > 0
        then projects.original_alloc
        else coalesce(projects.alloc, 0) + coalesce(projects.decrease_amount, 0)
          - coalesce(projects.increase_amount, 0)
      end::bigint as original_amount,
      coalesce(ledger.ledger_adjusted_allocation, projects.alloc,
        coalesce(projects.original_alloc, 0) + coalesce(projects.increase_amount, 0)
          - coalesce(projects.decrease_amount, 0), 0)::bigint as adjusted_amount,
      coalesce(ledger.ledger_execution_amount, projects.exec, 0)::bigint as execution_amount,
      coalesce((select sum(effects.classification_effect)::bigint
        from public.financial_project_decrease_classification_effects as effects
        where effects.source_project_id = projects.id), 0)::bigint as classified_decrease,
      coalesce(projects.decrease_amount, 0)::bigint as imported_decrease
    from public.projects
    left join public.financial_project_funding_positions as ledger
      on ledger.project_id = projects.id and ledger.projection_ready
    where projects.id = p_project_id
  ), gross as (
    select position.*,
      greatest(position.classified_decrease, position.imported_decrease,
        position.original_amount - position.adjusted_amount, 0)::bigint as gross_decrease
    from position
  )
  select gross.id, gross.original_amount,
    (gross.adjusted_amount - gross.original_amount + gross.gross_decrease)::bigint,
    gross.gross_decrease, gross.adjusted_amount, gross.execution_amount,
    (gross.adjusted_amount - gross.execution_amount)::bigint,
    case when gross.adjusted_amount > 0
      then round(gross.execution_amount::numeric * 100 / gross.adjusted_amount::numeric, 2)
      else 0::numeric end,
    gross.execution_amount <= gross.adjusted_amount
  from gross;
end;
$$;

create or replace function public.financial_link_pending_fund_from_new_project()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.movement_type = 'ALLOCATE_NEW_PROJECT'
     and new.transaction_kind = 'NORMAL'
     and new.new_project_request_id is not null then
    update public.financial_pending_new_project_funds as pending
    set status = 'LINKED', linked_project_id = new.destination_project_id,
        linked_movement_id = new.id, linked_by = new.confirmed_by,
        linked_at = clock_timestamp()
    where pending.lot_id = new.lot_id and pending.status = 'WAITING'
      and pending.amount = new.amount
      and pending.planned_project_year = (
        select projects.year from public.projects
        where projects.id = new.destination_project_id
      );
  end if;
  return new;
end;
$$;

create or replace function public.financial_link_registered_next_year_project()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_line public.financial_budget_change_request_lines%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_destination_project_id uuid;
  v_destination_region uuid;
  v_destination_year integer;
  v_destination_budget_year_id uuid;
  v_movement_id uuid;
  v_fingerprint text;
begin
  select * into v_line from public.financial_budget_change_request_lines
  where id = new.source_line_id;
  if coalesce(v_line.note, '') not like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
    return new;
  end if;
  v_actor_id := public.financial_require_admin();
  v_destination_project_id := substring(v_line.note from 30)::uuid;
  select region_id, year into v_destination_region, v_destination_year
  from public.projects where id = v_destination_project_id;
  if not found or v_destination_region <> new.region_id
     or v_destination_year <> new.planned_project_year then
    raise exception using errcode = '23514', message = '등록된 차년도 사업의 지역 또는 연도가 변경되었습니다.';
  end if;
  select * into v_lot from public.financial_unallocated_fund_lots
  where id = new.lot_id;
  perform public.financial_assert_project_baseline_ready(
    v_destination_project_id, new.amount, 0, 0, v_lot.record_origin, false
  );
  v_destination_budget_year_id := public.financial_get_or_create_budget_year(
    v_destination_project_id, v_lot.budget_cohort_id, v_lot.fiscal_year, v_actor_id
  );
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'pending_fund_id', new.id, 'destination_project_id', v_destination_project_id,
    'amount', new.amount, 'direct_registered_next_year_link', true
  ));
  insert into public.financial_unallocated_fund_movements (
    lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
    destination_project_id, destination_budget_year_id, amount,
    effective_date, record_origin, evidence_id, memo,
    idempotency_key, request_fingerprint, created_by, confirmed_by
  ) values (
    v_lot.id, v_lot.region_id, v_lot.budget_cohort_id,
    'ALLOCATE_EXISTING_PROJECT', 'NORMAL', v_destination_project_id,
    v_destination_budget_year_id, new.amount, v_lot.effective_date,
    v_lot.record_origin, v_lot.evidence_id,
    '등록된 차년도 신규사업 직접 연결 · ' || new.planned_project_name,
    gen_random_uuid(), v_fingerprint, new.created_by, v_actor_id
  ) returning id into v_movement_id;
  update public.financial_pending_new_project_funds
  set status = 'LINKED', linked_project_id = v_destination_project_id,
      linked_movement_id = v_movement_id, linked_by = v_actor_id,
      linked_at = clock_timestamp()
  where id = new.id;
  perform public.financial_write_audit(
    v_destination_project_id, new.region_id,
    'PENDING_NEW_PROJECT_FUND_LINKED', 'financial_pending_new_project_funds',
    new.id, v_actor_id, jsonb_build_object(
      'amount', new.amount, 'movement_id', v_movement_id,
      'source_request_id', new.source_request_id, 'direct_registered_next_year_link', true
    )
  );
  return new;
end;
$$;

drop trigger if exists financial_link_registered_next_year_project
  on public.financial_pending_new_project_funds;
create trigger financial_link_registered_next_year_project
after insert on public.financial_pending_new_project_funds
for each row execute function public.financial_link_registered_next_year_project();

drop trigger if exists financial_link_pending_fund_from_new_project
  on public.financial_unallocated_fund_movements;
create trigger financial_link_pending_fund_from_new_project
after insert on public.financial_unallocated_fund_movements
for each row execute function public.financial_link_pending_fund_from_new_project();

revoke all on function public.financial_validate_budget_change_request(uuid) from public, anon, authenticated;
revoke all on function public.financial_validate_budget_change_line_year() from public, anon, authenticated;
revoke all on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) from public, anon;
grant execute on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) to authenticated;
revoke all on function public.get_financial_budget_change_next_year_candidates(uuid,text) from public, anon;
grant execute on function public.get_financial_budget_change_next_year_candidates(uuid,text) to authenticated;
revoke all on function public.get_financial_budget_change_project_position(uuid) from public, anon;
grant execute on function public.get_financial_budget_change_project_position(uuid) to authenticated;
revoke all on function public.financial_link_pending_fund_from_new_project() from public, anon, authenticated;
revoke all on function public.financial_link_registered_next_year_project() from public, anon, authenticated;

commit;
