-- TEST-only snapshot support for a pending fund that intentionally has no project yet.

begin;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      '승인된 TEST 신규 운영거래 환경에서만 예정예산 스냅샷 보정을 설치할 수 있습니다.';
  end if;
  if to_regprocedure('public.financial_apply_budget_change_to_pending_funds(uuid)') is null then
    raise exception using errcode = '55000', message = '선행 예정예산 경로가 없습니다.';
  end if;
end;
$$;

create temporary table pending_fund_snapshot_trigger_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric project_allocation,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric project_execution,
  (select count(*) from public.financial_budget_workflow_amount_snapshots)::bigint snapshot_count,
  (select count(*) from public.financial_pending_new_project_funds)::bigint pending_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint movement_count;

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
  v_before_adjusted := v_position.original_allocation + v_position.increase_amount
    - new.decrease_amount_before;
  v_after_adjusted := v_position.original_allocation + v_position.increase_amount
    - new.decrease_amount_after;
  insert into public.financial_budget_workflow_amount_snapshots (
    event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
    project_role, amount, capture_kind,
    original_before, increase_before, decrease_before, adjusted_before,
    execution_before, unexecuted_before,
    original_after, increase_after, decrease_after, adjusted_after,
    execution_after, unexecuted_after
  ) values (
    'BUDGET_CHANGE', new.id, new.id, new.source_project_id, new.region_id, new.fiscal_year,
    'SOURCE', new.total_amount, 'EXACT_AT_APPLY',
    v_position.original_allocation, v_position.increase_amount, new.decrease_amount_before,
    v_before_adjusted, v_position.execution_amount,
    v_before_adjusted - v_position.execution_amount,
    v_position.original_allocation, v_position.increase_amount, new.decrease_amount_after,
    v_after_adjusted, v_position.execution_amount,
    v_after_adjusted - v_position.execution_amount
  ) on conflict do nothing;

  for v_destination in
    select lines.id as line_id, lines.amount,
      case
        when lines.destination_type = 'EXISTING_PROJECT' then lines.destination_project_id
        when coalesce(lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
          then substring(lines.note from 30)::uuid
        else new_requests.materialized_project_id
      end as project_id
    from public.financial_budget_change_request_lines as lines
    left join public.financial_new_project_requests as new_requests
      on new_requests.id = lines.new_project_request_id
    where lines.request_id = new.id
      and not lines.unlinked_funding_only
    order by lines.line_no
  loop
    if v_destination.project_id is null then
      raise exception using errcode = '55000', message =
        'Applied budget destination project is missing.';
    end if;
    select * into v_position
    from public.get_financial_budget_change_project_position(v_destination.project_id);
    select year into v_destination_year
    from public.projects where id = v_destination.project_id;
    if not found or v_position.increase_amount < v_destination.amount then
      raise exception using errcode = '55000', message =
        'Destination amount snapshot position is invalid.';
    end if;
    insert into public.financial_budget_workflow_amount_snapshots (
      event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
      project_role, amount, capture_kind,
      original_before, increase_before, decrease_before, adjusted_before,
      execution_before, unexecuted_before,
      original_after, increase_after, decrease_after, adjusted_after,
      execution_after, unexecuted_after
    ) values (
      'BUDGET_CHANGE', new.id, new.id, v_destination.project_id,
      new.region_id, v_destination_year, 'DESTINATION', v_destination.amount,
      'EXACT_AT_APPLY',
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

do $$
declare
  v_before pending_fund_snapshot_trigger_snapshot%rowtype;
  v_after pending_fund_snapshot_trigger_snapshot%rowtype;
  v_definition text;
begin
  select * into v_before from pending_fund_snapshot_trigger_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric,
    (select count(*) from public.financial_budget_workflow_amount_snapshots)::bigint,
    (select count(*) from public.financial_pending_new_project_funds)::bigint,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '예정예산 스냅샷 보정이 기존 TEST 업무 행 또는 금액을 변경했습니다.';
  end if;
  select lower(pg_get_functiondef(
    'public.financial_capture_budget_change_amount_snapshots()'::regprocedure)) into v_definition;
  if position('and not lines.unlinked_funding_only' in v_definition) = 0 then
    raise exception using errcode = '55000', message = '예정예산 스냅샷 제외 정의 검증에 실패했습니다.';
  end if;
end;
$$;

commit;
