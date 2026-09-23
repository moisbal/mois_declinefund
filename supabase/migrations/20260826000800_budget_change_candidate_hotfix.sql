-- TEST-only hotfix: disambiguate the candidate RPC output-column ORDER BY.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)') is null then
    raise exception using errcode = '55000', message =
      'Budget-change candidate hotfix requires the approved TEST base delta.';
  end if;
end;
$$;

create or replace function public.get_financial_budget_change_candidates(
  p_anchor_project_id uuid,
  p_search text default null,
  p_year integer default null,
  p_require_available boolean default false
)
returns table (
  project_id uuid, fiscal_year integer, project_code text, project_name text,
  source_budget_year_id uuid, available_amount bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_anchor_region uuid; v_anchor_year integer;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select region_id, year into v_anchor_region, v_anchor_year
  from public.projects where id = p_anchor_project_id;
  if not found or (v_role = 'local_user' and v_anchor_region <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '조회할 수 없는 사업입니다.';
  end if;
  return query
  select projects.id, projects.year, projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''),
      nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null
        then '사업명 확인 필요 (' || projects.project_code || ')'
        else '사업명 확인 필요' end)::text,
    source_wallet.id, coalesce(source_wallet.available_amount, 0)::bigint
  from public.projects
  left join lateral (
    select wallets.id, balance.accounting_balance::bigint as available_amount
    from public.project_budget_years as wallets
    cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
    where wallets.project_id = projects.id
    order by balance.accounting_balance desc, wallets.id
    limit 1
  ) as source_wallet on true
  where projects.region_id = v_anchor_region
    and projects.id <> p_anchor_project_id
    and projects.year <= v_anchor_year
    and (p_year is null or projects.year = p_year)
    and (nullif(btrim(coalesce(p_search, '')), '') is null
      or coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name, '')
        ilike '%' || btrim(p_search) || '%'
      or coalesce(projects.project_code, '') ilike '%' || btrim(p_search) || '%')
    and exists (
      select 1 from public.project_budget_years as candidate_wallets
      where candidate_wallets.project_id = projects.id
    )
    and (not p_require_available or coalesce(source_wallet.available_amount, 0) > 0)
  order by 2 desc, 4, 3;
end;
$$;

revoke all on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) from public, anon;
grant execute on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) to authenticated;

commit;
