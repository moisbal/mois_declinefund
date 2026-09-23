-- TEST UAT follow-up: use only columns that exist in public.regions when
-- formatting funding analytics labels. The canonical 00100 migration carries
-- the same definition for future environments.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'RECONCILIATION'
     or v_runtime.bound_project_ref is null
     or v_runtime.baseline_as_of <> date '2026-08-31'
     or v_runtime.native_start_date <> date '2026-09-01' then
    raise exception using errcode = '55000', message =
      'Funding analytics UAT hotfix is restricted to approved TEST/RECONCILIATION.';
  end if;
  if to_regprocedure('public.get_financial_funding_analytics(integer,text,text)') is null then
    raise exception using errcode = '55000', message = 'Funding analytics RPC is missing.';
  end if;
end
$$;

create temporary table funding_analytics_region_label_hotfix_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric
    as project_alloc_total,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric
    as project_exec_total,
  (select count(*) from public.financial_unallocated_fund_lots)::bigint as lot_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select count(*) from public.financial_project_decrease_classifications)::bigint
    as classification_count,
  (select count(*) from public.financial_project_decrease_classification_reversals)::bigint
    as classification_reversal_count,
  (select count(*) from public.financial_funding_reallocation_requests)::bigint
    as funding_request_count,
  (select count(*) from public.financial_new_project_requests)::bigint
    as new_project_request_count,
  (select jsonb_agg(to_jsonb(runtime) order by runtime.singleton)
    from public.financial_ledger_runtime as runtime) as runtime_rows;

create or replace function public.get_financial_funding_analytics(
  p_fiscal_year integer default null,
  p_sido text default null,
  p_sigungu text default null
)
returns table (
  scope_key text,
  label text,
  region_id uuid,
  sido text,
  sigungu text,
  fiscal_year integer,
  budget_cohort_id uuid,
  initial_allocation_amount bigint,
  confirmed_execution_amount bigint,
  current_wallet_balance bigint,
  unclassified_decrease_amount bigint,
  unclassified_decrease_count bigint,
  decrease_flow_amount bigint,
  reallocated_amount bigint,
  returned_amount bigint,
  waiting_stock_amount bigint,
  waiting_stock_count bigint,
  myeongsi_flow_amount bigint,
  myeongsi_flow_count bigint,
  sago_flow_amount bigint,
  sago_flow_count bigint,
  current_carryover_stock bigint,
  second_sequence_amount bigint
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
  with classification_totals as (
    select effects.budget_cohort_id,
      coalesce(sum(effects.classification_effect), 0)::bigint as decrease_flow_amount,
      coalesce(sum(case when effects.outcome_type = 'EXISTING_PROJECT_TRANSFER'
        then effects.classification_effect else 0 end), 0)::bigint as direct_reallocated_amount,
      coalesce(sum(case when effects.outcome_type = 'DIRECT_RETURN'
        then effects.classification_effect else 0 end), 0)::bigint as direct_returned_amount
    from public.financial_project_decrease_classification_effects as effects
    group by effects.budget_cohort_id
  ), pool_totals as (
    select lots.budget_cohort_id,
      coalesce(sum(balances.allocated_existing_amount + balances.allocated_new_amount), 0)::bigint
        as pool_reallocated_amount,
      coalesce(sum(balances.returned_amount), 0)::bigint as pool_returned_amount,
      coalesce(sum(balances.remaining_amount), 0)::bigint as waiting_stock_amount,
      count(*) filter (where balances.remaining_amount > 0)::bigint as waiting_stock_count
    from public.financial_unallocated_fund_lots as lots
    join public.financial_unallocated_fund_lot_balances as balances on balances.lot_id = lots.id
    group by lots.budget_cohort_id
  ), carryover_net as (
    select normal.id, normal.source_budget_year_id, normal.destination_budget_year_id,
      normal.carryover_type, normal.carryover_sequence,
      greatest(normal.amount - coalesce(sum(reversals.amount), 0), 0)::bigint as net_amount
    from public.project_carryovers as normal
    left join public.project_carryovers as reversals
      on reversals.reversal_of = normal.id and reversals.transaction_kind = 'REVERSAL'
      and reversals.status = 'CONFIRMED'
    where normal.status = 'CONFIRMED' and normal.transaction_kind = 'NORMAL'
    group by normal.id, normal.source_budget_year_id, normal.destination_budget_year_id,
      normal.carryover_type, normal.carryover_sequence, normal.amount
  ), carryover_totals as (
    select wallets.budget_cohort_id,
      coalesce(sum(case when carryovers.carryover_type = 'MYEONGSI'
        then carryovers.net_amount
        else 0 end), 0)::bigint as myeongsi_flow_amount,
      count(*) filter (where carryovers.carryover_type = 'MYEONGSI'
        and carryovers.net_amount > 0)::bigint as myeongsi_flow_count,
      coalesce(sum(case when carryovers.carryover_type = 'SAGO'
        then carryovers.net_amount
        else 0 end), 0)::bigint as sago_flow_amount,
      count(*) filter (where carryovers.carryover_type = 'SAGO'
        and carryovers.net_amount > 0)::bigint as sago_flow_count,
      coalesce(sum(case when carryovers.carryover_sequence = 2
        then carryovers.net_amount
        else 0 end), 0)::bigint as second_sequence_amount
    from carryover_net as carryovers
    join public.project_budget_years as wallets on wallets.id = carryovers.source_budget_year_id
    group by wallets.budget_cohort_id
  ), carryover_destination_wallets as (
    select distinct destination_wallet.id, destination_wallet.budget_cohort_id
    from carryover_net as inbound
    join public.project_budget_years as destination_wallet
      on destination_wallet.id = inbound.destination_budget_year_id
    where inbound.net_amount > 0
  ), carryover_stock as (
    -- Include every distinct wallet that has an active inbound carryover. Its
    -- accounting balance already nets any partial/full outbound carryover, so
    -- excluding non-terminal wallets would drop a partial-chain remainder.
    select carryover_wallets.budget_cohort_id,
      coalesce(sum(balance.accounting_balance), 0)::bigint as current_carryover_stock
    from carryover_destination_wallets as carryover_wallets
    cross join lateral public.financial_get_budget_year_balance(carryover_wallets.id) as balance
    group by carryover_wallets.budget_cohort_id
  ), cohort_rows as (
    select summaries.region_id, summaries.origin_fiscal_year as fiscal_year,
      summaries.cohort_id as budget_cohort_id, summaries.initial_allocation,
      coalesce(summaries.verified_cumulative_execution, 0)::bigint as confirmed_execution,
      coalesce(summaries.current_wallet_balance, 0)::bigint as wallet_balance,
      coalesce(classifications.decrease_flow_amount, 0)::bigint as decrease_flow,
      (coalesce(classifications.direct_reallocated_amount, 0)
        + coalesce(pool.pool_reallocated_amount, 0))::bigint as reallocated,
      (coalesce(classifications.direct_returned_amount, 0)
        + coalesce(pool.pool_returned_amount, 0))::bigint as returned,
      coalesce(pool.waiting_stock_amount, 0)::bigint as waiting_stock,
      coalesce(pool.waiting_stock_count, 0)::bigint as waiting_count,
      coalesce(carryovers.myeongsi_flow_amount, 0)::bigint as myeongsi_amount,
      coalesce(carryovers.myeongsi_flow_count, 0)::bigint as myeongsi_count,
      coalesce(carryovers.sago_flow_amount, 0)::bigint as sago_amount,
      coalesce(carryovers.sago_flow_count, 0)::bigint as sago_count,
      coalesce(terminal.current_carryover_stock, 0)::bigint as carryover_stock,
      coalesce(carryovers.second_sequence_amount, 0)::bigint as second_sequence
    from public.financial_funding_cohort_execution as summaries
    left join classification_totals as classifications
      on classifications.budget_cohort_id = summaries.cohort_id
    left join pool_totals as pool on pool.budget_cohort_id = summaries.cohort_id
    left join carryover_totals as carryovers on carryovers.budget_cohort_id = summaries.cohort_id
    left join carryover_stock as terminal on terminal.budget_cohort_id = summaries.cohort_id
    where summaries.cohort_id is not null
  ), unclassified_rows as (
    select rows.region_id, rows.fiscal_year,
      sum(rows.unclassified_amount)::bigint as unclassified_amount,
      count(*)::bigint as unclassified_count
    from public.financial_unclassified_project_decreases as rows
    group by rows.region_id, rows.fiscal_year
  ), combined as (
    select cohorts.region_id, cohorts.fiscal_year, cohorts.budget_cohort_id,
      cohorts.initial_allocation as initial_allocation_amount,
      cohorts.confirmed_execution as confirmed_execution_amount,
      cohorts.wallet_balance as current_wallet_balance,
      0::bigint as unclassified_decrease_amount,
      0::bigint as unclassified_decrease_count,
      cohorts.decrease_flow as decrease_flow_amount,
      cohorts.reallocated as reallocated_amount, cohorts.returned as returned_amount,
      cohorts.waiting_stock as waiting_stock_amount, cohorts.waiting_count as waiting_stock_count,
      cohorts.myeongsi_amount as myeongsi_flow_amount, cohorts.myeongsi_count as myeongsi_flow_count,
      cohorts.sago_amount as sago_flow_amount, cohorts.sago_count as sago_flow_count,
      cohorts.carryover_stock as current_carryover_stock,
      cohorts.second_sequence as second_sequence_amount
    from cohort_rows as cohorts
    union all
    select unclassified.region_id, unclassified.fiscal_year, null::uuid,
      0::bigint, 0::bigint, 0::bigint,
      unclassified.unclassified_amount, unclassified.unclassified_count,
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint
    from unclassified_rows as unclassified
  )
  select (combined.region_id::text || ':' || combined.fiscal_year::text || ':'
      || coalesce(combined.budget_cohort_id::text, 'UNCLASSIFIED'))::text as scope_key,
    (coalesce(nullif(btrim(regions.display_name), ''),
      nullif(btrim(concat_ws(' ', regions.sido, regions.sigungu)), ''), '지역 미상')
      || ' ' || combined.fiscal_year::text)::text as label,
    combined.region_id, regions.sido::text, regions.sigungu::text,
    combined.fiscal_year, combined.budget_cohort_id,
    combined.initial_allocation_amount, combined.confirmed_execution_amount,
    combined.current_wallet_balance, combined.unclassified_decrease_amount,
    combined.unclassified_decrease_count, combined.decrease_flow_amount,
    combined.reallocated_amount, combined.returned_amount,
    combined.waiting_stock_amount, combined.waiting_stock_count,
    combined.myeongsi_flow_amount, combined.myeongsi_flow_count,
    combined.sago_flow_amount, combined.sago_flow_count,
    combined.current_carryover_stock, combined.second_sequence_amount
  from combined
  join public.regions on regions.id = combined.region_id
  where (v_role = 'admin' or combined.region_id = v_actor_region_id)
    and (p_fiscal_year is null or combined.fiscal_year = p_fiscal_year)
    and (p_sido is null or regions.sido = p_sido)
    and (p_sigungu is null or regions.sigungu = p_sigungu)
  order by combined.fiscal_year, combined.region_id, combined.budget_cohort_id nulls last;
end;
$$;

revoke all on function public.get_financial_funding_analytics(integer,text,text)
  from public, anon;
grant execute on function public.get_financial_funding_analytics(integer,text,text)
  to authenticated;

do $$
declare v_definition text;
begin
  select lower(pg_catalog.pg_get_functiondef(
    'public.get_financial_funding_analytics(integer,text,text)'::regprocedure
  )) into v_definition;
  if position('regions.name' in v_definition) > 0
     or position('regions.display_name' in v_definition) = 0
     or position('concat_ws' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Funding analytics region-label postcondition failed.';
  end if;
end
$$;

do $$
declare v_snapshot funding_analytics_region_label_hotfix_snapshot%rowtype;
begin
  select * into v_snapshot from funding_analytics_region_label_hotfix_snapshot;
  if (select count(*) from public.projects) <> v_snapshot.project_count
     or (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)
        <> v_snapshot.project_alloc_total
     or (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)
        <> v_snapshot.project_exec_total
     or (select count(*) from public.financial_unallocated_fund_lots) <> v_snapshot.lot_count
     or (select count(*) from public.financial_unallocated_fund_movements) <> v_snapshot.movement_count
     or (select count(*) from public.financial_project_decrease_classifications)
        <> v_snapshot.classification_count
     or (select count(*) from public.financial_project_decrease_classification_reversals)
        <> v_snapshot.classification_reversal_count
     or (select count(*) from public.financial_funding_reallocation_requests)
        <> v_snapshot.funding_request_count
     or (select count(*) from public.financial_new_project_requests)
        <> v_snapshot.new_project_request_count
     or (select jsonb_agg(to_jsonb(runtime) order by runtime.singleton)
        from public.financial_ledger_runtime as runtime) is distinct from v_snapshot.runtime_rows then
    raise exception using errcode = '55000', message =
      'Funding analytics hotfix must not mutate TEST data or runtime policy.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
