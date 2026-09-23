-- TEST-only trace hotfix for grouped next-year budget destinations.
-- The monetary movement is already created by the generic APPLY.  This trigger
-- records the completed pending-fund/link workflow in the same transaction so
-- the admin queue can follow budget request -> new project -> fund link.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or position('atomic_group_apply' in lower(pg_get_functiondef(
       'public.financial_apply_budget_change_request(uuid)'::regprocedure))) = 0 then
    raise exception using errcode = '55000', message =
      'Grouped budget trace hotfix is pinned to the approved TEST generic engine.';
  end if;
end;
$$;

create or replace function public.financial_trace_grouped_budget_destination()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.financial_budget_change_request_lines%rowtype;
  v_movement public.financial_unallocated_fund_movements%rowtype;
  v_destination_project_id uuid;
  v_pending_id uuid;
  v_link_id uuid;
  v_fingerprint text;
begin
  if new.status <> 'APPLIED' or old.status = 'APPLIED' then return new; end if;

  for v_line in
    select lines.*
    from public.financial_budget_change_request_lines as lines
    where lines.request_id = new.id
      and lines.destination_type = 'PENDING_NEW_PROJECT'
      and lines.materialized_lot_id is not null
      and lines.pending_fund_id is null
    order by lines.line_no
    for update of lines
  loop
    select movements.* into v_movement
    from public.financial_unallocated_fund_movements as movements
    where movements.lot_id = v_line.materialized_lot_id
      and movements.transaction_kind = 'NORMAL'
    order by movements.created_at, movements.id
    limit 1;
    if not found or v_movement.amount <> v_line.amount
       or v_movement.destination_project_id is null
       or v_movement.destination_budget_year_id is null then
      raise exception using errcode = '55000', message =
        'Grouped next-year destination movement trace is incomplete.';
    end if;
    v_destination_project_id := v_movement.destination_project_id;
    if coalesce(v_line.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
       and v_destination_project_id <> substring(v_line.note from 30)::uuid then
      raise exception using errcode = '55000', message =
        'Registered next-year destination movement does not match the request.';
    end if;
    if v_line.new_project_request_id is not null and not exists (
      select 1 from public.financial_new_project_requests as requests
      where requests.id = v_line.new_project_request_id
        and requests.source_budget_change_request_id = new.id
        and requests.source_budget_change_line_id = v_line.id
        and requests.status = 'APPLIED'
        and requests.materialized_project_id = v_destination_project_id
        and requests.materialized_movement_id = v_movement.id
    ) then
      raise exception using errcode = '55000', message =
        'Grouped new-project materialization does not match the movement.';
    end if;

    insert into public.financial_pending_new_project_funds (
      region_id, fiscal_year, planned_project_name, planned_project_year,
      amount, lot_id, source_request_id, source_line_id, status,
      linked_project_id, linked_movement_id, linked_by, linked_at,
      created_by, created_at
    ) values (
      new.region_id, new.fiscal_year, v_line.planned_project_name,
      v_line.planned_project_year, v_line.amount, v_line.materialized_lot_id,
      new.id, v_line.id, 'LINKED', v_destination_project_id, v_movement.id,
      new.applied_by, new.applied_at, new.requested_by, new.requested_at
    ) returning id into v_pending_id;

    v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'budget_change_request_id', new.id,
      'budget_change_line_id', v_line.id,
      'pending_fund_id', v_pending_id,
      'destination_project_id', v_destination_project_id,
      'movement_id', v_movement.id,
      'amount', v_line.amount,
      'atomic_group_apply', true));
    insert into public.financial_pending_new_project_link_requests (
      pending_fund_id, region_id, destination_project_id, amount, status,
      idempotency_key, request_fingerprint, requested_by, requested_at,
      approved_by, approved_at, applied_by, applied_at, materialized_movement_id
    ) values (
      v_pending_id, new.region_id, v_destination_project_id, v_line.amount,
      'APPLIED', gen_random_uuid(), v_fingerprint, new.requested_by,
      new.requested_at, new.approved_by, new.approved_at,
      new.applied_by, new.applied_at, v_movement.id
    ) returning id into v_link_id;

    update public.financial_budget_change_request_lines
    set pending_fund_id = v_pending_id
    where id = v_line.id;
    perform public.financial_write_audit(
      v_destination_project_id, new.region_id,
      'PENDING_NEW_PROJECT_FUND_LINKED',
      'financial_pending_new_project_funds', v_pending_id, new.applied_by,
      jsonb_build_object('amount', v_line.amount,
        'source_request_id', new.id, 'source_line_id', v_line.id,
        'link_request_id', v_link_id, 'movement_id', v_movement.id,
        'atomic_group_apply', true));
  end loop;
  return new;
end;
$$;

drop trigger if exists financial_trace_grouped_budget_destination
  on public.financial_budget_change_requests;
create trigger financial_trace_grouped_budget_destination
after update of status on public.financial_budget_change_requests
for each row execute function public.financial_trace_grouped_budget_destination();

revoke all on function public.financial_trace_grouped_budget_destination()
  from public, anon, authenticated;

do $$
declare v_definition text;
begin
  select lower(pg_get_functiondef(
    'public.financial_trace_grouped_budget_destination()'::regprocedure))
    into v_definition;
  if position('financial_pending_new_project_funds' in v_definition) = 0
     or position('financial_pending_new_project_link_requests' in v_definition) = 0
     or position('atomic_group_apply' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Grouped budget destination trace definition check failed.';
  end if;
end;
$$;

commit;
