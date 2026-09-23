-- TEST-only projection repair. Canonical decrease classifications must remain
-- visible when a previously decreased project later receives an increase.
-- This changes no wallet, transfer, movement, project, or execution row.

begin;

create temporary table generic_budget_projection_guard on commit drop as
select count(*)::bigint as project_count,
  coalesce(sum(ledger_adjusted_allocation),0)::bigint as adjusted_total,
  coalesce(sum(ledger_execution_amount),0)::bigint as execution_total
from public.financial_project_funding_positions;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
  v_changed integer;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton=true;
  if not found or v_runtime.environment_kind<>'TEST' or v_runtime.mode<>'TEST'
     or v_runtime.bound_project_ref<>'reviewtestxxxxxxxxxx' then
    raise exception using errcode='55000', message=
      'Canonical decrease hotfix is pinned to the approved TEST project.';
  end if;
  with effects as (
    select source_project_id, count(*)::integer effect_count,
      coalesce(sum(classification_effect),0)::bigint effect_amount
    from public.financial_project_decrease_classification_effects
    group by source_project_id
  ), comparison as (
    select projects.id,
      public.financial_budget_change_visible_decrease(projects.id)::bigint current_amount,
      ((case when bootstraps.project_id is not null then bootstraps.baseline_decrease_amount
         when coalesce(effects.effect_count,0)>0 then 0
         else coalesce(projects.decrease_amount,0) end)
       + coalesce(effects.effect_amount,0))::bigint canonical_amount
    from public.projects
    left join public.financial_test_uat_project_bootstraps bootstraps
      on bootstraps.project_id=projects.id
    left join effects on effects.source_project_id=projects.id
  ) select count(*)::integer into v_changed from comparison
    where current_amount<>canonical_amount;
  if v_changed>25 then
    raise exception using errcode='55000', message=
      format('Canonical decrease hotfix impact is too broad (%s projects).',v_changed);
  end if;
end;
$$;

create or replace function public.financial_budget_change_visible_decrease(p_project_id uuid)
returns bigint
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  with effects as (
    select count(*)::integer as effect_count,
      coalesce(sum(classification_effect),0)::bigint as effect_amount
    from public.financial_project_decrease_classification_effects
    where source_project_id=p_project_id
  )
  select ((case
      when bootstraps.project_id is not null then bootstraps.baseline_decrease_amount
      when effects.effect_count>0 then 0
      else coalesce(projects.decrease_amount,0)
    end)+effects.effect_amount)::bigint
  from public.projects
  cross join effects
  left join public.financial_test_uat_project_bootstraps bootstraps
    on bootstraps.project_id=projects.id
  where projects.id=p_project_id;
$$;

create or replace view public.financial_project_funding_positions
with (security_invoker=true)
as
with wallet_totals as (
  select wallets.project_id,
    coalesce(sum(balance.accounting_balance),0)::bigint as current_wallet_balance,
    coalesce(sum(executions.confirmed_execution),0)::bigint as confirmed_execution
  from public.project_budget_years wallets
  cross join lateral public.financial_get_budget_year_balance(wallets.id) balance
  left join lateral (
    select coalesce(sum(records.amount*case when records.transaction_kind='REVERSAL' then -1 else 1 end),0)::bigint
      as confirmed_execution
    from public.project_execution_records records
    where records.budget_year_id=wallets.id and records.status='CONFIRMED'
  ) executions on true
  group by wallets.project_id
), origin_totals as (
  select cohorts.origin_project_id as project_id,
    coalesce(sum(cohorts.initial_allocation),0)::bigint as original_allocation
  from public.project_budget_cohorts cohorts
  where cohorts.record_origin='SYSTEM_NATIVE'
     or (cohorts.record_origin='LEGACY_EXCEL' and cohorts.reconciliation_status='RECONCILED')
  group by cohorts.origin_project_id
), unclassified as (
  select rows.project_id,sum(rows.unclassified_amount)::bigint as unclassified_amount
  from public.financial_unclassified_project_decreases rows group by rows.project_id
), base as (
  select projects.id as project_id,projects.region_id,projects.year as fiscal_year,
    coalesce(bootstraps.original_allocation,origins.original_allocation,0)::bigint
      as ledger_original_allocation,
    (coalesce(wallets.current_wallet_balance,0)+coalesce(wallets.confirmed_execution,0))::bigint
      as ledger_adjusted_allocation,
    coalesce(wallets.confirmed_execution,0)::bigint as ledger_execution_amount,
    coalesce(wallets.current_wallet_balance,0)::bigint as current_wallet_balance,
    coalesce(unclassified.unclassified_amount,0)::bigint as unclassified_decrease_amount,
    coalesce(bootstraps.baseline_decrease_amount,0)::bigint as baseline_decrease_amount,
    (coalesce(unclassified.unclassified_amount,0)=0 and (
      exists(select 1 from public.financial_project_baseline_attestations attestations
        where attestations.project_id=projects.id)
      or exists(select 1 from public.financial_new_project_requests requests
        where requests.materialized_project_id=projects.id and requests.status='APPLIED')
      or ((origins.project_id is not null or exists(
          select 1 from public.project_carryovers carryovers
          join public.project_budget_years destination_wallet
            on destination_wallet.id=carryovers.destination_budget_year_id
          where destination_wallet.project_id=projects.id
            and carryovers.status='CONFIRMED' and carryovers.transaction_kind='NORMAL'))
        and (coalesce(wallets.current_wallet_balance,0)+coalesce(wallets.confirmed_execution,0))
          =greatest(coalesce(projects.alloc,
            projects.original_alloc+coalesce(projects.increase_amount,0)
              -coalesce(projects.decrease_amount,0),0),0)
        and coalesce(wallets.confirmed_execution,0)=coalesce(projects.exec,0))))
      as projection_ready
  from public.projects
  join wallet_totals wallets on wallets.project_id=projects.id
  left join origin_totals origins on origins.project_id=projects.id
  left join unclassified on unclassified.project_id=projects.id
  left join public.financial_test_uat_project_bootstraps bootstraps
    on bootstraps.project_id=projects.id
), amounts as (
  select base.*,
    greatest(public.financial_budget_change_visible_decrease(base.project_id),
      base.baseline_decrease_amount,
      base.ledger_original_allocation-base.ledger_adjusted_allocation,0)::bigint
      as ledger_decrease_amount
  from base
)
select amounts.project_id,amounts.region_id,amounts.fiscal_year,
  amounts.ledger_original_allocation,amounts.ledger_adjusted_allocation,
  (amounts.ledger_adjusted_allocation-amounts.ledger_original_allocation
    +amounts.ledger_decrease_amount)::bigint as ledger_increase_amount,
  amounts.ledger_decrease_amount,amounts.ledger_execution_amount,
  case when amounts.ledger_adjusted_allocation>0 then
    round(amounts.ledger_execution_amount::numeric*100
      /amounts.ledger_adjusted_allocation::numeric,2)
    else 0::numeric end as ledger_execution_rate,
  amounts.current_wallet_balance,amounts.unclassified_decrease_amount,
  amounts.projection_ready
from amounts;

do $$
declare
  v_before generic_budget_projection_guard%rowtype;
  v_after record;
  v_mismatch integer;
begin
  select * into v_before from generic_budget_projection_guard;
  select count(*)::bigint project_count,
    coalesce(sum(ledger_adjusted_allocation),0)::bigint adjusted_total,
    coalesce(sum(ledger_execution_amount),0)::bigint execution_total
    into v_after from public.financial_project_funding_positions;
  if v_after.project_count<>v_before.project_count
     or v_after.adjusted_total<>v_before.adjusted_total
     or v_after.execution_total<>v_before.execution_total then
    raise exception using errcode='55000', message=
      'Canonical decrease hotfix changed project count, adjusted allocation, or execution.';
  end if;
  select count(*)::integer into v_mismatch
  from public.financial_project_funding_positions
  where ledger_original_allocation+ledger_increase_amount-ledger_decrease_amount
    <>ledger_adjusted_allocation;
  if v_mismatch<>0 or exists(select 1 from public.financial_funding_invariant_check
    where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) then
    raise exception using errcode='55000', message=
      'Canonical decrease hotfix failed projection or monetary integrity checks.';
  end if;
end;
$$;

commit;
