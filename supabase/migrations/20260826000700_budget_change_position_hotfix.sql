-- TEST-only hotfix: derive gross increase/decrease from the confirmed Ledger
-- while keeping adjusted allocation = original + increase - decrease.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.get_financial_budget_change_project_position(uuid)') is null then
    raise exception using errcode = '55000', message =
      'Budget-change position hotfix requires the approved TEST base delta.';
  end if;
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
      coalesce(ledger.ledger_original_allocation, projects.original_alloc, 0)::bigint as original_amount,
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

revoke all on function public.get_financial_budget_change_project_position(uuid) from public, anon;
grant execute on function public.get_financial_budget_change_project_position(uuid) to authenticated;

commit;
