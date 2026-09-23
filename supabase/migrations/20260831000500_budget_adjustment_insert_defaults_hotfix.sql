-- TEST-only compatibility defaults for the legacy internal INSERT signature.
-- The authenticated wrapper replaces every provisional value with the canonical
-- source revision, draft id, and economic fingerprint in the same transaction.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select runtime.* into v_runtime
  from public.financial_ledger_runtime as runtime
  where runtime.singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regclass('public.financial_budget_change_active_adjustment_uidx') is null then
    raise exception using errcode = '55000', message =
      'Budget-adjustment INSERT compatibility hotfix is pinned to the approved TEST engine.';
  end if;
end;
$$;

create temporary table financial_budget_adjustment_insert_defaults_snapshot on commit drop as
select
  (select count(*) from public.financial_budget_change_requests)::bigint as request_count,
  (select count(*) from public.financial_budget_change_request_lines)::bigint as line_count,
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select coalesce(sum(transfers.amount), 0) from public.project_fund_transfers as transfers)::numeric as transfer_amount,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select coalesce(sum(movements.amount), 0) from public.financial_unallocated_fund_movements as movements)::numeric as movement_amount;

alter table public.financial_budget_change_requests
  alter column source_adjustment_revision set default 0,
  alter column draft_revision_id set default gen_random_uuid(),
  alter column adjustment_fingerprint set default
    encode(digest(gen_random_uuid()::text, 'sha256'), 'hex');

do $$
declare
  v_before financial_budget_adjustment_insert_defaults_snapshot%rowtype;
  v_after financial_budget_adjustment_insert_defaults_snapshot%rowtype;
begin
  select snapshot.* into v_before
  from financial_budget_adjustment_insert_defaults_snapshot as snapshot;
  select
    (select count(*) from public.financial_budget_change_requests)::bigint,
    (select count(*) from public.financial_budget_change_request_lines)::bigint,
    (select count(*) from public.project_fund_transfers)::bigint,
    (select coalesce(sum(transfers.amount), 0) from public.project_fund_transfers as transfers)::numeric,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint,
    (select coalesce(sum(movements.amount), 0) from public.financial_unallocated_fund_movements as movements)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      'INSERT compatibility hotfix changed request or monetary rows.';
  end if;
  if exists (
    select 1
    from information_schema.columns as columns
    where columns.table_schema = 'public'
      and columns.table_name = 'financial_budget_change_requests'
      and columns.column_name in (
        'source_adjustment_revision', 'draft_revision_id', 'adjustment_fingerprint'
      )
      and columns.column_default is null
  ) then
    raise exception using errcode = '55000', message =
      'Budget-adjustment INSERT compatibility defaults are incomplete.';
  end if;
  if has_function_privilege('authenticated',
    'public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)', 'EXECUTE') then
    raise exception using errcode = '55000', message =
      'Authenticated callers must not bypass the idempotent TEST wrapper.';
  end if;
end;
$$;

commit;
