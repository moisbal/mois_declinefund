-- TEST-only UAT guard: expose the exact project-level maximum decrease before
-- any on-demand Ledger bootstrap and restore the same-fiscal-year destination rule.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regprocedure('public.get_financial_budget_change_project_position(uuid)') is null then
    raise exception using errcode = '55000', message =
      'Maximum-decrease guard requires the approved TEST budget workflow.';
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
       or v_destination_year <> v_fiscal_year
       or new.destination_project_id = v_source_project_id then
      raise exception using errcode = '23514', message =
        '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
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
    if not found or v_destination_region <> v_region_id
       or v_destination_year <> v_fiscal_year + 1 then
      raise exception using errcode = '23514', message =
        '등록된 신규사업은 같은 지역의 다음 연도 사업이어야 합니다.';
    end if;
  end if;
  return new;
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
  if p_year is not null and p_year <> v_anchor_year then
    raise exception using errcode = '23514', message = '기존사업은 같은 사업연도만 조회할 수 있습니다.';
  end if;
  return query
  select projects.id, projects.year, projects.project_code::text,
    coalesce(nullif(btrim(projects.detail_project_name), ''),
      nullif(btrim(projects.fund_project_name), ''),
      nullif(btrim(projects.project_name), ''),
      case when projects.project_code is not null
        then '사업명 확인 필요 (' || projects.project_code || ')'
        else '사업명 확인 필요' end)::text,
    source_wallet.id,
    case when source_wallet.id is not null then source_wallet.available_amount
      when not exists (select 1 from public.project_budget_years as existing_wallets
        where existing_wallets.project_id = projects.id)
        and coalesce(projects.exec, 0) <= coalesce(projects.alloc, 0)
      then greatest(coalesce(projects.alloc, 0) - coalesce(projects.exec, 0), 0)::bigint
      else 0::bigint end
  from public.projects
  left join lateral (
    select wallets.id, balance.available_to_commit::bigint as available_amount
    from public.project_budget_years as wallets
    cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
    where wallets.project_id = projects.id
    order by balance.available_to_commit desc, wallets.id
    limit 1
  ) as source_wallet on true
  where projects.region_id = v_anchor_region
    and projects.id <> p_anchor_project_id
    and projects.year = v_anchor_year
    and (p_year is null or projects.year = p_year)
    and (nullif(btrim(coalesce(p_search, '')), '') is null
      or coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name, '')
        ilike '%' || btrim(p_search) || '%'
      or coalesce(projects.project_code, '') ilike '%' || btrim(p_search) || '%')
    and (not p_require_available or case
      when source_wallet.id is not null then source_wallet.available_amount
      when not exists (select 1 from public.project_budget_years as existing_wallets
        where existing_wallets.project_id = projects.id)
        and coalesce(projects.exec, 0) <= coalesce(projects.alloc, 0)
      then greatest(coalesce(projects.alloc, 0) - coalesce(projects.exec, 0), 0)
      else 0 end > 0)
  order by 4, 3;
end;
$$;

create or replace function public.financial_test_uat_create_budget_change_request(
  p_source_project_id uuid,
  p_source_budget_year_id uuid,
  p_destinations jsonb,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_submit boolean default true
)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bootstrap record;
  v_position record;
  v_source_budget_year_id uuid;
  v_requested_amount bigint;
  v_maximum_decrease bigint;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  if jsonb_typeof(p_destinations) <> 'array' then
    raise exception using errcode = '22023', message = '목적지 목록을 확인해 주세요.';
  end if;
  select coalesce(sum(case when destination ->> 'amount' ~ '^[1-9][0-9]*$'
      then (destination ->> 'amount')::bigint else 0 end), 0)::bigint
    into v_requested_amount
  from jsonb_array_elements(p_destinations) as destination;
  perform 1 from public.projects where id = p_source_project_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '출처 사업을 찾을 수 없습니다.';
  end if;
  select * into v_position
  from public.get_financial_budget_change_project_position(p_source_project_id);
  v_maximum_decrease := greatest(coalesce(v_position.unexecuted_amount, 0), 0)::bigint;
  if v_requested_amount > v_maximum_decrease then
    raise exception using errcode = '23514', message = format(
      '현재 미집행액을 초과하여 감액할 수 없습니다. 최대 감액 가능액은 %s원입니다.',
      to_char(v_maximum_decrease, 'FM999,999,999,999,999,990')
    );
  end if;

  select * into v_bootstrap
  from public.financial_test_uat_bootstrap_project(p_source_project_id);
  if p_source_budget_year_id is not null then
    select wallets.id into v_source_budget_year_id
    from public.project_budget_years as wallets
    where wallets.id = p_source_budget_year_id and wallets.project_id = p_source_project_id;
    if not found then
      raise exception using errcode = '23514', message = '선택한 출처 재원이 해당 사업과 일치하지 않습니다.';
    end if;
  else
    v_source_budget_year_id := v_bootstrap.source_budget_year_id;
  end if;
  if v_source_budget_year_id is null then
    raise exception using errcode = '23514', message = '이 사업에는 감액 가능한 미집행액이 없습니다.';
  end if;
  return query select * from public.financial_create_budget_change_request(
    v_source_budget_year_id, p_destinations, p_effective_date,
    p_reason, p_idempotency_key, p_submit
  );
end;
$$;

revoke all on function public.financial_validate_budget_change_line_year()
  from public, anon, authenticated;
revoke all on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean)
  from public, anon;
grant execute on function public.get_financial_budget_change_candidates(uuid,text,integer,boolean)
  to authenticated;
revoke all on function public.financial_test_uat_create_budget_change_request(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_test_uat_create_budget_change_request(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;

do $$
declare v_candidate_definition text; v_create_definition text; v_trigger_definition text;
begin
  select lower(pg_get_functiondef('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)'::regprocedure))
    into v_candidate_definition;
  select lower(pg_get_functiondef('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure))
    into v_create_definition;
  select lower(pg_get_functiondef('public.financial_validate_budget_change_line_year()'::regprocedure))
    into v_trigger_definition;
  if position('projects.year = v_anchor_year' in v_candidate_definition) = 0
     or position('최대 감액 가능액' in v_create_definition) = 0
     or position('v_destination_year <> v_fiscal_year' in v_trigger_definition) = 0 then
    raise exception using errcode = '55000', message = 'Budget-change maximum/year guard definition check failed.';
  end if;
end;
$$;

commit;
