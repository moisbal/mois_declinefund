-- TEST-only repair for unqualified request-line references inside RETURNS TABLE
-- PL/pgSQL functions. The request_id output parameter otherwise conflicts with
-- financial_budget_change_request_lines.request_id at runtime.

begin;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
  v_create_definition text;
  v_apply_definition text;
  v_create_fixed text;
  v_apply_fixed text;
begin
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      'Budget-adjustment ambiguity hotfix is pinned to the approved TEST project.';
  end if;

  select pg_get_functiondef(
    'public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)'::regprocedure)
    into v_create_definition;
  select pg_get_functiondef(
    'public.financial_apply_budget_change_request(uuid)'::regprocedure)
    into v_apply_definition;
  if position('grouped_new_project_count' in v_create_definition) = 0
     or position('atomic_group_apply' in v_apply_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Expected generic budget-adjustment definitions are not installed.';
  end if;

  v_create_fixed := replace(
    v_create_definition,
    'where request_id = v_request.id and new_project_request_id is not null',
    'where financial_budget_change_request_lines.request_id = v_request.id and financial_budget_change_request_lines.new_project_request_id is not null');
  v_apply_fixed := replace(
    v_apply_definition,
    'from public.financial_budget_change_request_lines where request_id = v_request.id',
    'from public.financial_budget_change_request_lines where financial_budget_change_request_lines.request_id = v_request.id');
  if v_create_fixed = v_create_definition or v_apply_fixed = v_apply_definition then
    raise exception using errcode = '55000', message =
      'Budget-adjustment ambiguous reference pattern was not found.';
  end if;

  execute v_create_fixed;
  execute v_apply_fixed;
end;
$$;

do $$
declare
  v_create_definition text;
  v_apply_definition text;
begin
  select lower(pg_get_functiondef(
    'public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)'::regprocedure))
    into v_create_definition;
  select lower(pg_get_functiondef(
    'public.financial_apply_budget_change_request(uuid)'::regprocedure))
    into v_apply_definition;
  if position('financial_budget_change_request_lines.request_id = v_request.id' in v_create_definition) = 0
     or position('financial_budget_change_request_lines.request_id = v_request.id' in v_apply_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Budget-adjustment ambiguity hotfix definition check failed.';
  end if;
end;
$$;

commit;
