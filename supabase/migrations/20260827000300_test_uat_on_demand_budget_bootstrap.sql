-- TEST-only delta: allow human UAT to start a budget change from a project
-- that has current project-table budget/execution values but no canonical
-- Ledger wallet yet.  This is an on-demand present-state anchor, not a
-- reconstruction of historical increases, decreases, returns, or carryovers.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or v_runtime.mode <> 'TEST'
     or to_regprocedure('public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regprocedure('public.financial_apply_budget_change_request(uuid)') is null
     or to_regprocedure('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)') is null
     or to_regclass('public.financial_test_uat_project_bootstraps') is not null then
    raise exception using errcode = '55000', message =
      'TEST UAT bootstrap delta requires the approved TEST budget-change workflow.';
  end if;
end;
$$;

create table public.financial_test_uat_project_bootstraps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  original_allocation bigint not null check (original_allocation >= 0),
  baseline_increase_amount bigint not null check (baseline_increase_amount >= 0),
  baseline_decrease_amount bigint not null check (baseline_decrease_amount >= 0),
  adjusted_allocation bigint not null check (adjusted_allocation >= 0),
  execution_amount bigint not null check (execution_amount >= 0),
  budget_cohort_id uuid unique references public.project_budget_cohorts(id) on delete restrict,
  budget_year_id uuid unique references public.project_budget_years(id) on delete restrict,
  bootstrap_kind text not null default 'TEST_UAT_BOOTSTRAP'
    check (bootstrap_kind = 'TEST_UAT_BOOTSTRAP'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check (adjusted_allocation = original_allocation
    + baseline_increase_amount - baseline_decrease_amount),
  check (execution_amount <= adjusted_allocation),
  check ((adjusted_allocation = 0 and budget_cohort_id is null and budget_year_id is null)
    or (adjusted_allocation > 0 and budget_cohort_id is not null and budget_year_id is not null))
);

alter table public.financial_test_uat_project_bootstraps enable row level security;
alter table public.financial_test_uat_project_bootstraps force row level security;

create policy financial_test_uat_bootstraps_select_region_or_admin
  on public.financial_test_uat_project_bootstraps for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid()
        and (role = 'admin' or region_id = financial_test_uat_project_bootstraps.region_id))
  );

revoke all on table public.financial_test_uat_project_bootstraps
  from public, anon, authenticated;
grant select on table public.financial_test_uat_project_bootstraps to authenticated;

create or replace function public.financial_require_test_uat_bootstrap_runtime()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or v_runtime.mode <> 'TEST' then
    raise exception using errcode = '42501', message =
      'TEST 전용 예산조정 기준재원 연결은 승인된 TEST 신규 운영거래 모드에서만 가능합니다.';
  end if;
end;
$$;

create or replace function public.financial_test_uat_bootstrap_project(p_project_id uuid)
returns table (
  source_budget_year_id uuid,
  bootstrap_created boolean,
  original_allocation bigint,
  adjusted_allocation bigint,
  execution_amount bigint,
  available_amount bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_project public.projects%rowtype;
  v_existing public.financial_test_uat_project_bootstraps%rowtype;
  v_position public.financial_project_funding_positions%rowtype;
  v_runtime public.financial_ledger_runtime%rowtype;
  v_wallet_id uuid;
  v_cohort_id uuid;
  v_original bigint;
  v_adjusted bigint;
  v_execution bigint;
  v_baseline_decrease bigint;
  v_baseline_increase bigint;
  v_payload jsonb;
  v_fingerprint text;
  v_execution_id uuid;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_project_id is null then
    raise exception using errcode = '22023', message = '사업을 다시 선택해 주세요.';
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'financial_test_uat_bootstrap:' || p_project_id::text, 20260827000300
  )) then
    raise exception using errcode = '40001', message =
      '동일 사업의 테스트 기준재원을 연결 중입니다. 잠시 후 다시 시도해 주세요.';
  end if;

  select * into v_project from public.projects where id = p_project_id for update;
  if not found or (v_role = 'local_user' and v_project.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '자기 지역 사업만 예산 조정할 수 있습니다.';
  end if;
  if v_project.year is null or v_project.year not between 2000 and 2200 then
    raise exception using errcode = '23514', message = '사업연도를 확인해 주세요.';
  end if;

  select * into v_existing
  from public.financial_test_uat_project_bootstraps where project_id = p_project_id;
  if found then
    return query select v_existing.budget_year_id, false,
      v_existing.original_allocation, v_existing.adjusted_allocation,
      v_existing.execution_amount,
      greatest(v_existing.adjusted_allocation - v_existing.execution_amount, 0)::bigint;
    return;
  end if;

  select * into v_position
  from public.financial_project_funding_positions where project_id = p_project_id;
  if found and v_position.projection_ready then
    select wallets.id into v_wallet_id
    from public.project_budget_years as wallets
    cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
    where wallets.project_id = p_project_id
    order by balance.available_to_commit desc, wallets.created_at desc, wallets.id
    limit 1;
    return query select v_wallet_id, false,
      v_position.ledger_original_allocation,
      v_position.ledger_adjusted_allocation,
      v_position.ledger_execution_amount,
      greatest(v_position.current_wallet_balance, 0)::bigint;
    return;
  end if;
  if exists (select 1 from public.project_budget_years where project_id = p_project_id) then
    raise exception using errcode = '23514', message =
      '이 사업에는 일부 원장 기록이 있어 현재 사업값과 자동 연결할 수 없습니다. 관리자에게 기존 기록 확인을 요청해 주세요.';
  end if;

  v_adjusted := greatest(coalesce(v_project.alloc,
    coalesce(v_project.original_alloc, 0) + coalesce(v_project.increase_amount, 0)
      - coalesce(v_project.decrease_amount, 0), 0), 0)::bigint;
  v_execution := greatest(coalesce(v_project.exec, 0), 0)::bigint;
  v_original := greatest(case when coalesce(v_project.original_alloc, 0) > 0
    then v_project.original_alloc
    else v_adjusted + coalesce(v_project.decrease_amount, 0)
      - coalesce(v_project.increase_amount, 0) end, 0)::bigint;
  v_baseline_decrease := greatest(coalesce(v_project.decrease_amount, 0),
    v_original - v_adjusted, 0)::bigint;
  v_baseline_increase := (v_adjusted - v_original + v_baseline_decrease)::bigint;
  if v_execution > v_adjusted or v_baseline_increase < 0 then
    raise exception using errcode = '23514', message =
      '현재 집행액이 조정 후 배분액을 초과하거나 예산값의 관계가 올바르지 않습니다.';
  end if;

  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  insert into public.financial_project_baseline_attestations (
    project_id, region_id, physical_adjusted_allocation,
    ledger_adjusted_allocation, physical_execution_amount,
    ledger_execution_amount, attested_by
  ) values (
    v_project.id, v_project.region_id, v_adjusted,
    v_adjusted, v_execution, v_execution, v_actor_id
  ) on conflict (project_id) do nothing;

  if v_adjusted > 0 then
    v_payload := jsonb_build_object(
      'bootstrap_kind', 'TEST_UAT_BOOTSTRAP',
      'project_id', v_project.id, 'fiscal_year', v_project.year,
      'current_adjusted_allocation', v_adjusted,
      'current_execution_amount', v_execution,
      'effective_date', v_runtime.native_start_date
    );
    v_fingerprint := public.financial_request_fingerprint(v_payload);
    insert into public.project_budget_cohorts (
      origin_project_id, origin_fiscal_year, initial_allocation, allocation_type,
      memo, idempotency_key, created_by, source_type, effective_date,
      record_origin, evidence_id, request_fingerprint, reconciliation_status
    ) values (
      v_project.id, v_project.year, v_adjusted, 'INITIAL',
      'TEST_UAT_BOOTSTRAP · 현재 조정 후 배분액 기준점', gen_random_uuid(),
      v_actor_id, 'STANDARD', v_runtime.native_start_date,
      'SYSTEM_NATIVE', null, v_fingerprint, 'RECONCILED'
    ) returning id into v_cohort_id;
    v_wallet_id := public.financial_get_or_create_budget_year(
      v_project.id, v_cohort_id, v_project.year, v_actor_id
    );

    if v_execution > 0 then
      v_payload := jsonb_build_object(
        'bootstrap_kind', 'TEST_UAT_BOOTSTRAP',
        'budget_year_id', v_wallet_id, 'amount', v_execution,
        'execution_date', v_runtime.native_start_date,
        'memo', 'TEST_UAT_BOOTSTRAP · 현재 집행액 기준점',
        'record_origin', 'SYSTEM_NATIVE', 'evidence_id', null
      );
      v_fingerprint := public.financial_request_fingerprint(v_payload);
      insert into public.project_execution_records (
        budget_year_id, amount, execution_date, status, transaction_kind,
        memo, idempotency_key, created_by, confirmed_by, confirmed_at,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_wallet_id, v_execution, v_runtime.native_start_date, 'CONFIRMED', 'NORMAL',
        'TEST_UAT_BOOTSTRAP · 현재 집행액 기준점', gen_random_uuid(),
        v_actor_id, v_actor_id, clock_timestamp(), 'SYSTEM_NATIVE', null, v_fingerprint
      ) returning id into v_execution_id;
    end if;
  end if;

  insert into public.financial_test_uat_project_bootstraps (
    project_id, region_id, fiscal_year, original_allocation,
    baseline_increase_amount, baseline_decrease_amount,
    adjusted_allocation, execution_amount, budget_cohort_id,
    budget_year_id, created_by
  ) values (
    v_project.id, v_project.region_id, v_project.year, v_original,
    v_baseline_increase, v_baseline_decrease,
    v_adjusted, v_execution, v_cohort_id, v_wallet_id, v_actor_id
  ) returning * into v_existing;

  perform public.financial_write_audit(
    v_project.id, v_project.region_id, 'TEST_UAT_BOOTSTRAP',
    'financial_test_uat_project_bootstraps', v_existing.id, v_actor_id,
    jsonb_build_object(
      'bootstrap_kind', 'TEST_UAT_BOOTSTRAP',
      'fiscal_year', v_project.year,
      'original_allocation', v_original,
      'adjusted_allocation', v_adjusted,
      'execution_amount', v_execution,
      'budget_year_id', v_wallet_id
    )
  );
  return query select v_wallet_id, true, v_original, v_adjusted,
    v_execution, greatest(v_adjusted - v_execution, 0)::bigint;
end;
$$;

-- Imported raw decreases are part of the TEST present-state anchor.  They are
-- not historical classifications and must not block future native UAT deltas.
create or replace view public.financial_unclassified_project_decreases
with (security_invoker = true)
as
with classified as (
  select effects.source_project_id,
    count(*)::bigint as classification_count,
    coalesce(sum(effects.classification_effect), 0)::bigint as classified_amount
  from public.financial_project_decrease_classification_effects as effects
  group by effects.source_project_id
), project_wallet as (
  select wallets.project_id, count(*)::bigint as wallet_count,
    (array_agg(wallets.id order by wallets.fiscal_year desc, wallets.created_at desc))[1]
      as candidate_budget_year_id,
    (array_agg(wallets.budget_cohort_id order by wallets.fiscal_year desc, wallets.created_at desc))[1]
      as candidate_budget_cohort_id
  from public.project_budget_years as wallets
  group by wallets.project_id
)
select projects.id as project_id, projects.project_code,
  coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name) as project_name,
  projects.region_id, projects.year as fiscal_year,
  coalesce(projects.decrease_amount, 0)::bigint as decrease_amount,
  coalesce(classified.classified_amount, 0)::bigint as classified_amount,
  greatest(coalesce(projects.decrease_amount, 0) - coalesce(classified.classified_amount, 0), 0)::bigint
    as unclassified_amount,
  (coalesce(project_wallet.wallet_count, 0) > 0) as has_budget_year,
  case when project_wallet.wallet_count = 1 then project_wallet.candidate_budget_year_id end
    as budget_year_id,
  case when project_wallet.wallet_count = 1 then project_wallet.candidate_budget_cohort_id end
    as budget_cohort_id,
  coalesce(project_wallet.wallet_count, 0)::bigint as wallet_count,
  (coalesce(project_wallet.wallet_count, 0) > 1) as source_selection_required
from public.projects
left join classified on classified.source_project_id = projects.id
left join project_wallet on project_wallet.project_id = projects.id
where coalesce(classified.classification_count, 0) = 0
  and coalesce(projects.decrease_amount, 0) > 0
  and not exists (select 1 from public.financial_test_uat_project_bootstraps as bootstraps
    where bootstraps.project_id = projects.id);

-- Keep the user's original/increase/decrease columns visible while the wallet
-- starts from the already-adjusted current amount.  No fake historical event is
-- materialized to explain the imported present-state difference.
create or replace view public.financial_project_funding_positions
with (security_invoker = true)
as
with wallet_totals as (
  select wallets.project_id,
    coalesce(sum(balance.accounting_balance), 0)::bigint as current_wallet_balance,
    coalesce(sum(executions.confirmed_execution), 0)::bigint as confirmed_execution
  from public.project_budget_years as wallets
  cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
  left join lateral (
    select coalesce(sum(records.amount
      * case when records.transaction_kind = 'REVERSAL' then -1 else 1 end), 0)::bigint
      as confirmed_execution
    from public.project_execution_records as records
    where records.budget_year_id = wallets.id and records.status = 'CONFIRMED'
  ) as executions on true
  group by wallets.project_id
), origin_totals as (
  select cohorts.origin_project_id as project_id,
    coalesce(sum(cohorts.initial_allocation), 0)::bigint as original_allocation
  from public.project_budget_cohorts as cohorts
  where cohorts.record_origin = 'SYSTEM_NATIVE'
     or (cohorts.record_origin = 'LEGACY_EXCEL' and cohorts.reconciliation_status = 'RECONCILED')
  group by cohorts.origin_project_id
), unclassified as (
  select rows.project_id, sum(rows.unclassified_amount)::bigint as unclassified_amount
  from public.financial_unclassified_project_decreases as rows
  group by rows.project_id
), base as (
  select projects.id as project_id, projects.region_id, projects.year as fiscal_year,
    coalesce(bootstraps.original_allocation, origins.original_allocation, 0)::bigint
      as ledger_original_allocation,
    (coalesce(wallets.current_wallet_balance, 0)
      + coalesce(wallets.confirmed_execution, 0))::bigint as ledger_adjusted_allocation,
    coalesce(wallets.confirmed_execution, 0)::bigint as ledger_execution_amount,
    coalesce(wallets.current_wallet_balance, 0)::bigint as current_wallet_balance,
    coalesce(unclassified.unclassified_amount, 0)::bigint as unclassified_decrease_amount,
    bootstraps.project_id is not null as is_test_uat_bootstrap,
    coalesce(bootstraps.baseline_decrease_amount, 0)::bigint as baseline_decrease_amount,
    (coalesce(unclassified.unclassified_amount, 0) = 0
      and (exists (select 1 from public.financial_project_baseline_attestations as attestations
        where attestations.project_id = projects.id)
      or exists (select 1 from public.financial_new_project_requests as requests
        where requests.materialized_project_id = projects.id and requests.status = 'APPLIED')
      or ((origins.project_id is not null or exists (
          select 1 from public.project_carryovers as carryovers
          join public.project_budget_years as destination_wallet
            on destination_wallet.id = carryovers.destination_budget_year_id
          where destination_wallet.project_id = projects.id
            and carryovers.status = 'CONFIRMED'
            and carryovers.transaction_kind = 'NORMAL'))
        and (coalesce(wallets.current_wallet_balance, 0)
          + coalesce(wallets.confirmed_execution, 0))
          = greatest(coalesce(projects.alloc,
            projects.original_alloc + coalesce(projects.increase_amount, 0)
              - coalesce(projects.decrease_amount, 0), 0), 0)
        and coalesce(wallets.confirmed_execution, 0) = coalesce(projects.exec, 0))))
      as projection_ready
  from public.projects
  join wallet_totals as wallets on wallets.project_id = projects.id
  left join origin_totals as origins on origins.project_id = projects.id
  left join unclassified on unclassified.project_id = projects.id
  left join public.financial_test_uat_project_bootstraps as bootstraps
    on bootstraps.project_id = projects.id
), amounts as (
  select base.*,
    case when base.is_test_uat_bootstrap
      then greatest(public.financial_budget_change_visible_decrease(base.project_id),
        base.baseline_decrease_amount,
        base.ledger_original_allocation - base.ledger_adjusted_allocation, 0)::bigint
      else greatest(base.ledger_original_allocation - base.ledger_adjusted_allocation, 0)::bigint
    end as ledger_decrease_amount
  from base
)
select amounts.project_id, amounts.region_id, amounts.fiscal_year,
  amounts.ledger_original_allocation, amounts.ledger_adjusted_allocation,
  (amounts.ledger_adjusted_allocation - amounts.ledger_original_allocation
    + amounts.ledger_decrease_amount)::bigint as ledger_increase_amount,
  amounts.ledger_decrease_amount,
  amounts.ledger_execution_amount,
  case when amounts.ledger_adjusted_allocation > 0 then
    round(amounts.ledger_execution_amount::numeric * 100
      / amounts.ledger_adjusted_allocation::numeric, 2)
    else 0::numeric end as ledger_execution_rate,
  amounts.current_wallet_balance, amounts.unclassified_decrease_amount,
  amounts.projection_ready
from amounts;

create or replace function public.financial_assert_decrease_delta_position(
  p_source_budget_year_id uuid,
  p_decrease_amount_before bigint,
  p_decrease_amount_after bigint,
  p_amount bigint,
  p_is_correction boolean default false
)
returns table (
  region_id uuid, fiscal_year integer, budget_cohort_id uuid, source_project_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_decrease bigint;
  v_classified bigint;
  v_classification_count bigint;
  v_bootstrap_decrease bigint;
begin
  if p_amount is null or p_amount <= 0
     or p_decrease_amount_before is null or p_decrease_amount_before < 0
     or p_decrease_amount_after is null or p_decrease_amount_after < 0 then
    raise exception using errcode = '22023', message = '감액 변화값을 확인해 주세요.';
  end if;
  if (not p_is_correction and p_decrease_amount_after - p_decrease_amount_before <> p_amount)
     or (p_is_correction and p_decrease_amount_before - p_decrease_amount_after <> p_amount) then
    raise exception using errcode = '23514', message = '감액액 변화는 정확한 양수 차액이어야 합니다.';
  end if;
  select projects.region_id, wallets.fiscal_year, wallets.budget_cohort_id,
    projects.id, coalesce(projects.decrease_amount, 0)::bigint
    into region_id, fiscal_year, budget_cohort_id, source_project_id, v_project_decrease
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = p_source_budget_year_id for update of projects;
  if not found then
    raise exception using errcode = 'P0002', message = '감액 출처 재원을 찾을 수 없습니다.';
  end if;
  select count(*)::bigint, coalesce(sum(classification_effect), 0)::bigint
    into v_classification_count, v_classified
  from public.financial_project_decrease_classification_effects
  where financial_project_decrease_classification_effects.source_project_id =
    financial_assert_decrease_delta_position.source_project_id;
  select coalesce(bootstraps.baseline_decrease_amount, 0)::bigint
    into v_bootstrap_decrease
  from public.financial_test_uat_project_bootstraps as bootstraps
  where bootstraps.project_id = financial_assert_decrease_delta_position.source_project_id;
  v_bootstrap_decrease := coalesce(v_bootstrap_decrease, 0);
  if v_classification_count = 0 then
    if p_decrease_amount_before <> v_bootstrap_decrease
       or (v_bootstrap_decrease = 0 and v_project_decrease > 0
         and v_project_decrease <> p_decrease_amount_after) then
      raise exception using errcode = '23514', message =
        '현재 감액 기준값과 신규 감액 시작값이 일치하지 않습니다.';
    end if;
  elsif v_bootstrap_decrease + v_classified <> p_decrease_amount_before then
    raise exception using errcode = '23514', message =
      '현재 감액 누계와 신규 감액 시작값이 일치하지 않습니다.';
  end if;
  return next;
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
      coalesce(bootstraps.original_allocation,
        case when coalesce(projects.original_alloc, 0) > 0 then projects.original_alloc
          else coalesce(projects.alloc, 0) + coalesce(projects.decrease_amount, 0)
            - coalesce(projects.increase_amount, 0) end, 0)::bigint as original_amount,
      coalesce(ledger.ledger_adjusted_allocation, projects.alloc,
        coalesce(projects.original_alloc, 0) + coalesce(projects.increase_amount, 0)
          - coalesce(projects.decrease_amount, 0), 0)::bigint as adjusted_amount,
      coalesce(ledger.ledger_execution_amount, projects.exec, 0)::bigint as execution_amount,
      public.financial_budget_change_visible_decrease(projects.id)::bigint as visible_decrease,
      coalesce(bootstraps.baseline_decrease_amount, 0)::bigint as bootstrap_decrease
    from public.projects
    left join public.financial_project_funding_positions as ledger
      on ledger.project_id = projects.id and ledger.projection_ready
    left join public.financial_test_uat_project_bootstraps as bootstraps
      on bootstraps.project_id = projects.id
    where projects.id = p_project_id
  ), gross as (
    select position.*,
      greatest(position.visible_decrease, position.bootstrap_decrease,
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
  if p_year is not null and (p_year < 2000 or p_year > v_anchor_year) then
    raise exception using errcode = '23514', message = '당해연도 또는 과거연도만 조회할 수 있습니다.';
  end if;
  return query
  select projects.id, projects.year, projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''),
      nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null
        then '사업명 확인 필요 (' || projects.project_code || ')'
        else '사업명 확인 필요' end)::text,
    source_wallet.id,
    case when source_wallet.id is not null then source_wallet.available_amount
      when not exists (select 1 from public.project_budget_years as existing_wallets
        where existing_wallets.project_id = projects.id)
        and coalesce(projects.exec, 0) <= coalesce(projects.alloc, 0)
      then greatest(coalesce(projects.alloc, 0) - coalesce(projects.exec, 0), 0)::bigint
      else 0::bigint end
  from public.projects
  left join lateral (
    select wallets.id, balance.available_to_commit::bigint as available_amount
    from public.project_budget_years as wallets
    cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
    where wallets.project_id = projects.id
    order by balance.available_to_commit desc, wallets.id
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
    and (not p_require_available or case
      when source_wallet.id is not null then source_wallet.available_amount
      when not exists (select 1 from public.project_budget_years as existing_wallets
        where existing_wallets.project_id = projects.id)
        and coalesce(projects.exec, 0) <= coalesce(projects.alloc, 0)
      then greatest(coalesce(projects.alloc, 0) - coalesce(projects.exec, 0), 0)
      else 0 end > 0)
  order by 2 desc, 4, 3;
end;
$$;

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
declare
  v_bootstrap record;
  v_source_budget_year_id uuid;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select * into v_bootstrap
  from public.financial_test_uat_bootstrap_project(p_source_project_id);
  if p_source_budget_year_id is not null then
    select wallets.id into v_source_budget_year_id
    from public.project_budget_years as wallets
    where wallets.id = p_source_budget_year_id and wallets.project_id = p_source_project_id;
    if not found then
      raise exception using errcode = '23514', message = '선택한 출처 재원이 해당 사업과 일치하지 않습니다.';
    end if;
  else
    v_source_budget_year_id := v_bootstrap.source_budget_year_id;
  end if;
  if v_source_budget_year_id is null then
    raise exception using errcode = '23514', message = '이 사업에는 감액 가능한 미집행액이 없습니다.';
  end if;
  return query select * from public.financial_create_budget_change_request(
    v_source_budget_year_id, p_destinations, p_effective_date,
    p_reason, p_idempotency_key, p_submit
  );
end;
$$;

-- Apply remains maker-checker/admin-only.  The only new behavior is to anchor
-- an unlinked existing destination immediately before its first confirmed
-- inbound transfer, in the same database transaction.
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
  perform public.financial_require_test_uat_bootstrap_runtime();
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.'; end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.id, v_request.status, 0::bigint; return;
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
  if not found then raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.'; end if;
  perform public.financial_require_available_amount(
    v_source_wallet.id, v_request.total_amount, '감액액이 현재 미집행액을 초과합니다.'
  );
  select coalesce(bootstraps.baseline_decrease_amount, 0)
      + coalesce(sum(effects.classification_effect), 0)::bigint
    into v_classification_before
  from public.projects
  left join public.financial_test_uat_project_bootstraps as bootstraps
    on bootstraps.project_id = public.projects.id
  left join public.financial_project_decrease_classification_effects as effects
    on effects.source_project_id = public.projects.id
  where public.projects.id = v_request.source_project_id
  group by bootstraps.baseline_decrease_amount;
  v_classification_before := coalesce(v_classification_before, 0);
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
    select request_lines.* from public.financial_budget_change_request_lines as request_lines
    where request_lines.request_id = v_request.id
    order by request_lines.line_no for update of request_lines
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
         or (v_destination_year > v_request.fiscal_year and coalesce(v_line.note, '') <> 'INCREASE_TARGET')
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message = '목적지 사업의 지역 또는 연도가 변경되었습니다.';
      end if;
      perform public.financial_test_uat_bootstrap_project(v_line.destination_project_id);
      perform public.financial_assert_project_baseline_ready(
        v_line.destination_project_id, v_line.amount, 0, 0, 'SYSTEM_NATIVE', false
      );
      v_destination_budget_year_id := public.financial_get_or_create_budget_year(
        v_line.destination_project_id, v_source_wallet.budget_cohort_id,
        v_source_wallet.fiscal_year, v_actor_id
      );
      perform 1 from public.project_budget_years
      where id = any(array[v_source_wallet.id, v_destination_budget_year_id]) order by id for update;
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
      set materialized_transfer_id = v_transfer_id where id = v_line.id;
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
      set materialized_lot_id = v_lot_id, pending_fund_id = v_pending_id where id = v_line.id;
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

revoke all on function public.financial_require_test_uat_bootstrap_runtime()
  from public, anon, authenticated;
revoke all on function public.financial_test_uat_bootstrap_project(uuid)
  from public, anon;
grant execute on function public.financial_test_uat_bootstrap_project(uuid)
  to authenticated;
revoke all on function public.financial_test_uat_create_budget_change_request(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_test_uat_create_budget_change_request(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;
revoke all on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean)
  from public, anon;
grant execute on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean)
  to authenticated;
revoke all on function public.financial_apply_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_apply_budget_change_request(uuid)
  to authenticated;

commit;
