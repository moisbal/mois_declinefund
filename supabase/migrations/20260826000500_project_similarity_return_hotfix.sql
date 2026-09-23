begin;

-- TEST-only follow-up: cast varchar candidate labels to the RPC's declared
-- text return columns. This does not create or update any project/ledger row.
do $$
begin
  if not exists (
    select 1 from public.financial_ledger_runtime
    where singleton and environment_kind = 'TEST'
      and bound_project_ref = 'reviewtestxxxxxxxxxx'
  ) then
    raise exception using errcode = '55000', message =
      'Refusing similarity return hotfix outside the bound TEST project.';
  end if;
end;
$$;

create temp table project_similarity_return_guard on commit drop as
select md5(string_agg(concat_ws('|', id::text, total_budget::text,
  original_alloc::text, increase_amount::text, decrease_amount::text,
  alloc::text, exec::text, rate::text), E'\n' order by id)) as monetary_digest
from public.projects;

do $$
declare
  v_signature constant regprocedure := 'public.get_project_similarity_candidates(uuid,text,integer)'::regprocedure;
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('ranked.display_name,' in v_definition) = 0
     or position('ranked.project_code,' in v_definition) = 0
     or position('regions.display_name,' in v_definition) = 0
     or position('large_categories.name,' in v_definition) = 0 then
    raise exception using errcode = '55000', message = 'Expected similarity return projection was not found.';
  end if;
  v_patched := replace(replace(replace(replace(
    v_definition,
    'ranked.display_name,', 'ranked.display_name::text,'),
    'ranked.project_code,', 'ranked.project_code::text,'),
    'regions.display_name,', 'regions.display_name::text,'),
    'large_categories.name,', 'large_categories.name::text,');
  execute v_patched;
end;
$$;

do $$
declare
  v_before text;
  v_after text;
  v_definition text;
begin
  select monetary_digest into v_before from project_similarity_return_guard;
  select md5(string_agg(concat_ws('|', id::text, total_budget::text,
    original_alloc::text, increase_amount::text, decrease_amount::text,
    alloc::text, exec::text, rate::text), E'\n' order by id))
  into v_after from public.projects;
  if v_after is distinct from v_before then
    raise exception using errcode = '23514', message = 'Similarity hotfix changed project monetary values.';
  end if;
  select pg_get_functiondef('public.get_project_similarity_candidates(uuid,text,integer)'::regprocedure)
  into v_definition;
  if position('ranked.display_name::text,' in v_definition) = 0
     or position('ranked.project_code::text,' in v_definition) = 0
     or position('regions.display_name::text,' in v_definition) = 0
     or position('large_categories.name::text,' in v_definition) = 0 then
    raise exception using errcode = '55000', message = 'Similarity return type verification failed.';
  end if;
end;
$$;

commit;
