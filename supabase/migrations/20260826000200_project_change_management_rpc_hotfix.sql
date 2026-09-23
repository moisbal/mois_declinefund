begin;

-- TEST-only metadata RPC hotfix. The previous function's RETURNS TABLE `id`
-- output variable made one unqualified `where id = ...` reference ambiguous.
-- Patch only that catalog definition; no project or Ledger row is updated.
do $$
begin
  if not exists (
    select 1 from public.financial_ledger_runtime
    where singleton
      and environment_kind = 'TEST'
      and bound_project_ref = 'reviewtestxxxxxxxxxx'
  ) then
    raise exception using errcode = '55000', message =
      'Refusing project-change RPC hotfix outside the bound TEST project.';
  end if;
end;
$$;

create temp table project_change_rpc_hotfix_guard on commit drop as
select
  coalesce(sum(total_budget), 0)::numeric as total_budget,
  coalesce(sum(original_alloc), 0)::numeric as original_alloc,
  coalesce(sum(increase_amount), 0)::numeric as increase_amount,
  coalesce(sum(decrease_amount), 0)::numeric as decrease_amount,
  coalesce(sum(alloc), 0)::numeric as alloc,
  coalesce(sum(exec), 0)::numeric as exec,
  coalesce(sum(rate), 0)::numeric as rate
from public.projects;

do $$
declare
  v_signature constant regprocedure := 'public.update_my_project_metadata_v2(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text)'::regprocedure;
  v_definition text;
  v_patched_definition text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('where id = p_project_id' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Expected ambiguous project lookup was not found; refusing an unreviewed hotfix.';
  end if;
  v_patched_definition := replace(
    v_definition,
    'where id = p_project_id',
    'where projects.id = p_project_id'
  );
  if v_patched_definition = v_definition then
    raise exception using errcode = '55000', message = 'Project metadata RPC hotfix made no change.';
  end if;
  execute v_patched_definition;
end;
$$;

do $$
declare
  v_before project_change_rpc_hotfix_guard%rowtype;
  v_after record;
  v_definition text;
begin
  select * into v_before from project_change_rpc_hotfix_guard;
  select
    coalesce(sum(total_budget), 0)::numeric as total_budget,
    coalesce(sum(original_alloc), 0)::numeric as original_alloc,
    coalesce(sum(increase_amount), 0)::numeric as increase_amount,
    coalesce(sum(decrease_amount), 0)::numeric as decrease_amount,
    coalesce(sum(alloc), 0)::numeric as alloc,
    coalesce(sum(exec), 0)::numeric as exec,
    coalesce(sum(rate), 0)::numeric as rate
  into v_after from public.projects;
  if row(v_before.total_budget, v_before.original_alloc, v_before.increase_amount,
         v_before.decrease_amount, v_before.alloc, v_before.exec, v_before.rate)
     is distinct from
     row(v_after.total_budget, v_after.original_alloc, v_after.increase_amount,
         v_after.decrease_amount, v_after.alloc, v_after.exec, v_after.rate) then
    raise exception using errcode = '23514', message = 'RPC hotfix changed project monetary totals.';
  end if;

  select pg_get_functiondef(
    'public.update_my_project_metadata_v2(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text)'::regprocedure
  ) into v_definition;
  if position('where projects.id = p_project_id' in v_definition) = 0
     or position('where id = p_project_id' in v_definition) > 0 then
    raise exception using errcode = '55000', message = 'RPC hotfix definition verification failed.';
  end if;
end;
$$;

commit;
