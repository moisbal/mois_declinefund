begin;

-- TEST-only follow-up: RETURNS TABLE declares project_code as text while the
-- physical projects column is varchar. Cast the final projection explicitly.
do $$
begin
  if not exists (
    select 1 from public.financial_ledger_runtime
    where singleton and environment_kind = 'TEST'
      and bound_project_ref = 'reviewtestxxxxxxxxxx'
  ) then
    raise exception using errcode = '55000', message =
      'Refusing project-change RPC return hotfix outside the bound TEST project.';
  end if;
end;
$$;

create temp table project_change_rpc_return_guard on commit drop as
select md5(string_agg(concat_ws('|', id::text, total_budget::text,
  original_alloc::text, increase_amount::text, decrease_amount::text,
  alloc::text, exec::text, rate::text), E'\n' order by id)) as monetary_digest
from public.projects;

do $$
declare
  v_signature constant regprocedure := 'public.update_my_project_metadata_v2(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text)'::regprocedure;
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('select projects.id, projects.project_code, projects.alloc' in v_definition) = 0 then
    raise exception using errcode = '55000', message = 'Expected reviewed RPC return projection was not found.';
  end if;
  v_patched := replace(
    v_definition,
    'select projects.id, projects.project_code, projects.alloc',
    'select projects.id, projects.project_code::text, projects.alloc'
  );
  if v_patched = v_definition then
    raise exception using errcode = '55000', message = 'RPC return hotfix made no change.';
  end if;
  execute v_patched;
end;
$$;

do $$
declare
  v_before text;
  v_after text;
  v_definition text;
begin
  select monetary_digest into v_before from project_change_rpc_return_guard;
  select md5(string_agg(concat_ws('|', id::text, total_budget::text,
    original_alloc::text, increase_amount::text, decrease_amount::text,
    alloc::text, exec::text, rate::text), E'\n' order by id))
  into v_after from public.projects;
  if v_after is distinct from v_before then
    raise exception using errcode = '23514', message = 'RPC return hotfix changed project monetary values.';
  end if;
  select pg_get_functiondef(
    'public.update_my_project_metadata_v2(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text)'::regprocedure
  ) into v_definition;
  if position('select projects.id, projects.project_code::text, projects.alloc' in v_definition) = 0
     or position('select projects.id, projects.project_code, projects.alloc' in v_definition) > 0 then
    raise exception using errcode = '55000', message = 'RPC return type verification failed.';
  end if;
end;
$$;

commit;
