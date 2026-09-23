-- TEST-only delta: allow current/past-year existing-project search and make
-- destination-led increases explicit without weakening region or conservation guards.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.financial_validate_budget_change_request(uuid)') is null
     or to_regprocedure('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)') is null then
    raise exception using errcode = '55000', message =
      'Budget-change year-search delta requires the approved TEST conservation hotfix.';
  end if;
end;
$$;

create or replace function public.financial_validate_budget_change_line_year()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_region_id uuid;
  v_fiscal_year integer;
  v_source_project_id uuid;
  v_destination_region uuid;
  v_destination_year integer;
  v_registered_project_id uuid;
begin
  select region_id, fiscal_year, source_project_id
    into v_region_id, v_fiscal_year, v_source_project_id
  from public.financial_budget_change_requests where id = new.request_id;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  if new.destination_type = 'EXISTING_PROJECT' then
    select region_id, year into v_destination_region, v_destination_year
    from public.projects where id = new.destination_project_id;
    if not found or v_destination_region <> v_region_id
       or new.destination_project_id = v_source_project_id
       or (v_destination_year > v_fiscal_year and coalesce(new.note, '') <> 'INCREASE_TARGET') then
      raise exception using errcode = '23514', message =
        '기존사업은 같은 지역의 당해·과거연도 사업이어야 하며, 미래연도 증액은 현재 사업을 목적지로 지정한 요청에서만 가능합니다.';
    end if;
  elsif new.planned_project_year <> v_fiscal_year + 1 then
    raise exception using errcode = '23514', message =
      '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
  elsif coalesce(new.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
    if substring(new.note from 30) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = '등록된 차년도 사업을 다시 선택해 주세요.';
    end if;
    v_registered_project_id := substring(new.note from 30)::uuid;
    select region_id, year into v_destination_region, v_destination_year
    from public.projects where id = v_registered_project_id;
    if not found or v_destination_region <> v_region_id or v_destination_year <> v_fiscal_year + 1 then
      raise exception using errcode = '23514', message =
        '등록된 신규사업은 같은 지역의 다음 연도 사업이어야 합니다.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.financial_validate_budget_change_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.financial_budget_change_requests%rowtype;
  v_line record;
  v_sum bigint;
  v_line_count integer;
  v_region_id uuid;
  v_year integer;
  v_visible_decrease bigint;
begin
  select * into v_request
  from public.financial_budget_change_requests
  where id = p_request_id;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  select coalesce(sum(amount), 0)::bigint, count(*)::integer
    into v_sum, v_line_count
  from public.financial_budget_change_request_lines
  where request_id = v_request.id;
  if v_sum <> v_request.total_amount then
    raise exception using errcode = '23514', message = '감액액과 목적지 배분 합계의 차액은 0원이어야 합니다.';
  end if;
  select projects.region_id, projects.year into v_region_id, v_year
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = v_request.source_budget_year_id
    and projects.id = v_request.source_project_id;
  if not found or v_region_id <> v_request.region_id or v_year <> v_request.fiscal_year then
    raise exception using errcode = '23514', message = '출처 사업의 지역 또는 연도가 변경되었습니다.';
  end if;
  v_visible_decrease := public.financial_budget_change_visible_decrease(v_request.source_project_id);
  if v_visible_decrease <> v_request.decrease_amount_before then
    raise exception using errcode = '40001', message = '출처 사업의 감액액이 변경되었습니다. 새로고침 후 다시 요청해 주세요.';
  end if;
  for v_line in
    select * from public.financial_budget_change_request_lines
    where request_id = v_request.id order by line_no
  loop
    if v_line.destination_type = 'EXISTING_PROJECT' then
      select region_id, year into v_region_id, v_year
      from public.projects where id = v_line.destination_project_id;
      if not found or v_region_id <> v_request.region_id
         or v_line.destination_project_id = v_request.source_project_id
         or (v_year > v_request.fiscal_year
           and (coalesce(v_line.note, '') <> 'INCREASE_TARGET' or v_line_count <> 1)) then
        raise exception using errcode = '23514', message =
          '기존사업은 같은 지역의 당해·과거연도 사업이어야 하며, 증액에서 시작한 요청은 현재 사업 한 곳만 목적지로 지정해야 합니다.';
      end if;
    elsif v_line.planned_project_year <> v_request.fiscal_year + 1 then
      raise exception using errcode = '23514', message =
        '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
    end if;
  end loop;
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
  if p_year is not null and (p_year < 2000 or p_year > v_anchor_year) then
    raise exception using errcode = '23514', message = '당해연도 또는 과거연도만 조회할 수 있습니다.';
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
    and (not p_require_available or coalesce(source_wallet.available_amount, 0) > 0)
  order by 2 desc, 4, 3;
end;
$$;

revoke all on function public.financial_validate_budget_change_request(uuid) from public, anon, authenticated;
revoke all on function public.financial_validate_budget_change_line_year() from public, anon, authenticated;
revoke all on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) from public, anon;
grant execute on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean) to authenticated;

commit;
