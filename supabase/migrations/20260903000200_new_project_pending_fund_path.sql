-- TEST-only N -> N+1 pending-fund path for a new project that will be written later.

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
      '승인된 TEST 신규 운영거래 환경에서만 차년도 신규사업 예정예산 경로를 설치할 수 있습니다.';
  end if;
  if to_regprocedure('public.financial_test_uat_save_budget_change_request_with_drafts(uuid,uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regprocedure('public.get_financial_new_project_funding_sources(integer,uuid)') is null then
    raise exception using errcode = '55000', message = '선행 신규사업 재원 연결 보정이 없습니다.';
  end if;
end;
$$;

create temporary table new_project_pending_path_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric project_allocation,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric project_execution,
  (select count(*) from public.financial_new_project_requests)::bigint new_request_count,
  (select count(*) from public.financial_budget_change_requests)::bigint budget_request_count,
  (select count(*) from public.financial_budget_change_request_lines)::bigint budget_line_count,
  (select count(*) from public.financial_pending_new_project_funds)::bigint pending_count,
  (select count(*) from public.financial_unallocated_fund_lots)::bigint lot_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint movement_count;

alter table public.financial_budget_change_request_lines
  add column if not exists unlinked_funding_only boolean not null default false;

create or replace function public.get_financial_new_project_funding_sources(
  p_year integer default null,
  p_request_id uuid default null
)
returns table (
  pending_fund_id uuid,
  source_lot_id uuid,
  region_id uuid,
  source_fiscal_year integer,
  target_fiscal_year integer,
  planned_project_name text,
  amount bigint,
  remaining_amount bigint,
  pending_status text,
  source_project_id uuid,
  source_project_code text,
  source_project_name text,
  claimed_request_id uuid,
  claimed_request_status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  if p_year is not null and p_year not between 2000 and 2200 then
    raise exception using errcode = '22023', message = '조회할 사업연도를 확인해 주세요.';
  end if;

  return query
  select pending.id, pending.lot_id, pending.region_id,
    pending.fiscal_year, pending.planned_project_year, pending.planned_project_name,
    pending.amount, balances.remaining_amount, pending.status,
    lots.source_project_id, source.project_code::text,
    coalesce(nullif(btrim(source.detail_project_name), ''),
      nullif(btrim(source.fund_project_name), ''), nullif(btrim(source.project_name), ''),
      '사업명 확인 필요')::text,
    claimed.id, claimed.status, pending.created_at
  from public.financial_pending_new_project_funds as pending
  join public.financial_unallocated_fund_lots as lots on lots.id = pending.lot_id
  join public.financial_unallocated_fund_lot_balances as balances on balances.lot_id = pending.lot_id
  join public.projects as source on source.id = lots.source_project_id
  left join lateral (
    select requests.id, requests.status, requests.requested_by
    from public.financial_new_project_requests as requests
    where requests.source_lot_id = pending.lot_id
      and requests.status in ('DRAFT', 'SUBMITTED', 'APPROVED')
    order by requests.requested_at desc limit 1
  ) as claimed on true
  where pending.status = 'WAITING'
    and pending.planned_project_year = pending.fiscal_year + 1
    and balances.remaining_amount > 0
    and balances.remaining_amount >= pending.amount
    and (v_role = 'admin' or pending.region_id = v_actor_region_id)
    and (p_year is null or pending.planned_project_year = p_year)
    and not exists (
      select 1 from public.financial_pending_new_project_link_requests as links
      where links.pending_fund_id = pending.id
        and links.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
    )
    and (claimed.id is null or (
      p_request_id is not null and claimed.id = p_request_id
      and claimed.status = 'DRAFT' and claimed.requested_by = v_actor_id
    ))
  order by pending.planned_project_year, pending.created_at desc;
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
  v_region_id uuid;
  v_year integer;
  v_visible_decrease bigint;
  v_registered_project_id uuid;
begin
  select * into v_request from public.financial_budget_change_requests where id = p_request_id;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  select coalesce(sum(amount), 0)::bigint into v_sum
  from public.financial_budget_change_request_lines where request_id = v_request.id;
  if v_sum <> v_request.total_amount then
    raise exception using errcode = '23514', message = '감액액과 목적지 배분 합계의 차액은 0원이어야 합니다.';
  end if;
  if exists (
    select 1 from (
      select case
        when lines.destination_type = 'EXISTING_PROJECT' then 'EXISTING:' || lines.destination_project_id::text
        when lines.unlinked_funding_only then 'UNLINKED:' || lines.planned_project_year::text || ':' || lower(btrim(lines.planned_project_name))
        when coalesce(lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then 'REGISTERED:' || substring(lines.note from 30)
        else 'PLANNED:' || lines.planned_project_year::text || ':' || lower(btrim(lines.planned_project_name))
      end destination_key
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_request.id
    ) destination_keys
    group by destination_key having count(*) > 1
  ) then
    raise exception using errcode = '23505', message = '같은 목적지를 중복하여 선택할 수 없습니다.';
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
    select lines.*, new_requests.status new_project_status
    from public.financial_budget_change_request_lines as lines
    left join public.financial_new_project_requests as new_requests
      on new_requests.id = lines.new_project_request_id
    where lines.request_id = v_request.id order by lines.line_no
  loop
    if v_line.destination_type = 'EXISTING_PROJECT' then
      if v_line.unlinked_funding_only then
        raise exception using errcode = '23514', message = '기존사업 목적지는 신규사업 예정예산으로 표시할 수 없습니다.';
      end if;
      select region_id, year into v_region_id, v_year
      from public.projects where id = v_line.destination_project_id;
      if not found or v_region_id <> v_request.region_id or v_year <> v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
      end if;
    elsif v_line.planned_project_year <> v_request.fiscal_year + 1 then
      raise exception using errcode = '23514', message = '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
    elsif v_line.unlinked_funding_only then
      if v_line.new_project_request_id is not null then
        raise exception using errcode = '23514', message =
          '신규사업을 나중에 작성할 예정예산에는 신규사업 초안을 미리 연결할 수 없습니다.';
      end if;
    elsif coalesce(v_line.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      v_registered_project_id := substring(v_line.note from 30)::uuid;
      select region_id, year into v_region_id, v_year
      from public.projects where id = v_registered_project_id;
      if not found or v_region_id <> v_request.region_id or v_year <> v_request.fiscal_year + 1 then
        raise exception using errcode = '23514', message =
          '등록된 신규사업은 같은 지역의 다음 연도 사업이어야 합니다.';
      end if;
      if v_line.new_project_request_id is not null then
        raise exception using errcode = '23514', message = '등록된 신규사업에는 생성 요청을 연결할 수 없습니다.';
      end if;
    elsif v_line.new_project_request_id is null or v_line.new_project_status <> v_request.status then
      raise exception using errcode = '23514', message =
        '미등록 신규사업 생성 요청은 예산조정과 같은 묶음·상태여야 합니다.';
    end if;
  end loop;
end;
$$;

create or replace function public.financial_test_uat_save_budget_change_request_complete(
  p_source_project_id uuid,
  p_source_budget_year_id uuid,
  p_destinations jsonb,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_submit boolean default false
)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_item jsonb;
  v_ordinality bigint;
  v_has_unlinked boolean := false;
  v_has_other boolean := false;
  v_saved record;
  v_parent public.financial_budget_change_requests%rowtype;
  v_line public.financial_budget_change_request_lines%rowtype;
  v_generated_id uuid;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  if jsonb_typeof(p_destinations) <> 'array' then
    raise exception using errcode = '22023', message = '예산조정 목적지를 확인해 주세요.';
  end if;

  for v_item in select value from jsonb_array_elements(p_destinations) loop
    if coalesce((v_item ->> 'create_unlinked_funding')::boolean, false) then
      v_has_unlinked := true;
      if v_item ->> 'destination_type' <> 'PENDING_NEW_PROJECT'
         or nullif(v_item ->> 'existing_new_project_request_id', '') is not null then
        raise exception using errcode = '23514', message =
          '신규사업 예정예산은 차년도 미연결 목적지로만 만들 수 있습니다.';
      end if;
    else
      v_has_other := true;
    end if;
  end loop;
  if v_has_unlinked and v_has_other then
    raise exception using errcode = '23514', message =
      '신규사업 예정예산 확보는 다른 목적지와 나누지 말고 별도 예산조정으로 요청해 주세요.';
  end if;

  select saved.* into v_saved
  from public.financial_test_uat_save_budget_change_request_with_drafts(
    p_source_project_id, p_source_budget_year_id, p_destinations,
    p_effective_date, p_reason, p_idempotency_key, false
  ) as saved;
  select requests.* into v_parent
  from public.financial_budget_change_requests as requests
  where requests.id = v_saved.request_id for update;

  if v_has_unlinked then
    for v_item, v_ordinality in
      select items.value, items.ordinality
      from jsonb_array_elements(p_destinations) with ordinality as items(value, ordinality)
    loop
      select lines.* into v_line
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_parent.id and lines.line_no = v_ordinality
        and lines.destination_type = 'PENDING_NEW_PROJECT'
      for update;
      if not found or v_line.new_project_request_id is null then
        raise exception using errcode = '55000', message = '예정예산 목적지 행을 준비하지 못했습니다.';
      end if;
      v_generated_id := v_line.new_project_request_id;
      update public.financial_budget_change_request_lines as lines
      set new_project_request_id = null, unlinked_funding_only = true
      where lines.id = v_line.id;
      delete from public.financial_new_project_requests as requests
      where requests.id = v_generated_id
        and requests.source_budget_change_request_id = v_parent.id
        and requests.source_budget_change_line_id = v_line.id
        and requests.status = 'DRAFT';
      if not found then
        raise exception using errcode = '55000', message = '자동 생성 초안을 예정예산으로 전환하지 못했습니다.';
      end if;
    end loop;
  end if;

  perform public.financial_validate_budget_change_request(v_parent.id);
  if p_submit then
    return query select submitted.request_id, submitted.status, 0::bigint
    from public.financial_submit_budget_change_request(v_parent.id) as submitted;
    return;
  end if;
  return query select v_parent.id, v_parent.status, 0::bigint;
exception
  when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed then
    raise exception using errcode = '22023', message = '사업 또는 금액 입력값을 확인해 주세요.';
end;
$$;

create or replace function public.financial_apply_budget_change_to_pending_funds(p_request_id uuid)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
  v_line public.financial_budget_change_request_lines%rowtype;
  v_source_wallet public.project_budget_years%rowtype;
  v_lot_id uuid;
  v_pending_id uuid;
  v_classification_before bigint;
  v_classification_after bigint;
  v_line_key uuid;
  v_line_fingerprint text;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  v_actor_id := public.financial_require_admin();
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.id, v_request.status, 0::bigint;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message =
      '승인된 예산 조정만 요청자와 다른 관리자가 적용할 수 있습니다.';
  end if;
  if not exists (select 1 from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_request.id)
     or exists (select 1 from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_request.id
        and (lines.destination_type <> 'PENDING_NEW_PROJECT' or not lines.unlinked_funding_only)) then
    raise exception using errcode = '23514', message = '미연결 신규사업 예정예산 전용 요청이 아닙니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  perform public.financial_assert_funding_origin_evidence(
    v_request.region_id, 'SYSTEM_NATIVE', v_request.effective_date, null);

  select wallets.* into v_source_wallet
  from public.project_budget_years as wallets
  where wallets.id = v_request.source_budget_year_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.';
  end if;
  perform public.financial_require_available_amount(v_source_wallet.id, v_request.total_amount,
    '감액액이 현재 미집행액을 초과합니다.');
  select coalesce(bootstraps.baseline_decrease_amount, 0)
      + coalesce(sum(effects.classification_effect), 0)::bigint
    into v_classification_before
  from public.projects
  left join public.financial_test_uat_project_bootstraps as bootstraps
    on bootstraps.project_id = public.projects.id
  left join public.financial_project_decrease_classification_effects as effects
    on effects.source_project_id = public.projects.id
  where public.projects.id = v_request.source_project_id
  group by bootstraps.baseline_decrease_amount;
  v_classification_before := coalesce(v_classification_before, 0);
  perform 1 from public.financial_assert_decrease_delta_position(
    v_source_wallet.id, v_classification_before,
    v_classification_before + v_request.total_amount, v_request.total_amount, false);
  perform public.financial_assert_project_baseline_ready(
    v_request.source_project_id, -v_request.total_amount, 0,
    v_request.total_amount, 'SYSTEM_NATIVE', false);

  v_classification_after := v_classification_before;
  for v_line in
    select lines.* from public.financial_budget_change_request_lines as lines
    where lines.request_id = v_request.id
    order by lines.line_no for update of lines
  loop
    v_line_key := gen_random_uuid();
    v_line_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'request_id', v_request.id, 'line_id', v_line.id,
      'destination_type', v_line.destination_type, 'amount', v_line.amount,
      'unlinked_funding_only', true));
    insert into public.financial_unallocated_fund_lots (
      region_id, fiscal_year, budget_cohort_id, source_project_id,
      source_budget_year_id, original_amount, reason, effective_date,
      record_origin, evidence_id, idempotency_key, request_fingerprint,
      created_by, confirmed_by
    ) values (
      v_request.region_id, v_source_wallet.fiscal_year,
      v_source_wallet.budget_cohort_id, v_request.source_project_id,
      v_source_wallet.id, v_line.amount,
      '차년도 신규사업 예정예산 · ' || v_line.planned_project_name,
      v_request.effective_date, 'SYSTEM_NATIVE', null, v_line_key,
      v_line_fingerprint, v_request.requested_by, v_actor_id
    ) returning id into v_lot_id;
    insert into public.financial_project_decrease_classifications (
      region_id, fiscal_year, budget_cohort_id, source_project_id,
      source_budget_year_id, outcome_type, amount,
      decrease_amount_before, decrease_amount_after,
      canonical_table, canonical_record_id, lot_id,
      record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
    ) values (
      v_request.region_id, v_source_wallet.fiscal_year,
      v_source_wallet.budget_cohort_id, v_request.source_project_id,
      v_source_wallet.id, 'UNALLOCATED_LOT', v_line.amount,
      v_classification_after, v_classification_after + v_line.amount,
      'financial_unallocated_fund_lots', v_lot_id, v_lot_id,
      'SYSTEM_NATIVE', null, gen_random_uuid(), v_line_fingerprint,
      v_request.requested_by
    );
    insert into public.financial_pending_new_project_funds (
      region_id, fiscal_year, planned_project_name, planned_project_year,
      amount, lot_id, source_request_id, source_line_id, created_by
    ) values (
      v_request.region_id, v_source_wallet.fiscal_year,
      v_line.planned_project_name, v_line.planned_project_year,
      v_line.amount, v_lot_id, v_request.id, v_line.id, v_request.requested_by
    ) returning id into v_pending_id;
    update public.financial_budget_change_request_lines as lines
    set materialized_lot_id = v_lot_id, pending_fund_id = v_pending_id
    where lines.id = v_line.id;
    v_classification_after := v_classification_after + v_line.amount;
  end loop;
  if v_classification_after - v_classification_before <> v_request.total_amount then
    raise exception using errcode = '23514', message = '예산 조정 적용 차액이 0원이 아닙니다.';
  end if;
  update public.financial_budget_change_requests as requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_write_audit(v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_APPLIED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('amount', v_request.total_amount, 'gap_amount', 0,
      'new_project_pending_fund_count', (select count(*)
        from public.financial_budget_change_request_lines as lines
        where lines.request_id = v_request.id and lines.pending_fund_id is not null)));
  return query select v_request.id, v_request.status, 0::bigint;
end;
$$;

create or replace function public.financial_apply_budget_change_request_dispatch(p_request_id uuid)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.financial_budget_change_request_lines as lines
      where lines.request_id = p_request_id and lines.unlinked_funding_only) then
    return query select applied.request_id, applied.status, applied.gap_amount
    from public.financial_apply_budget_change_to_pending_funds(p_request_id) as applied;
  else
    return query select applied.request_id, applied.status, applied.gap_amount
    from public.financial_apply_budget_change_request(p_request_id) as applied;
  end if;
end;
$$;

revoke all on function public.get_financial_new_project_funding_sources(integer,uuid) from public, anon;
grant execute on function public.get_financial_new_project_funding_sources(integer,uuid) to authenticated;
revoke all on function public.financial_validate_budget_change_request(uuid) from public, anon, authenticated;
revoke all on function public.financial_test_uat_save_budget_change_request_complete(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_test_uat_save_budget_change_request_complete(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;
revoke all on function public.financial_apply_budget_change_to_pending_funds(uuid)
  from public, anon, authenticated;
revoke all on function public.financial_apply_budget_change_request_dispatch(uuid) from public, anon;
grant execute on function public.financial_apply_budget_change_request_dispatch(uuid) to authenticated;

do $$
declare
  v_before new_project_pending_path_snapshot%rowtype;
  v_after new_project_pending_path_snapshot%rowtype;
  v_source text;
  v_apply text;
begin
  select * into v_before from new_project_pending_path_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric,
    (select count(*) from public.financial_new_project_requests)::bigint,
    (select count(*) from public.financial_budget_change_requests)::bigint,
    (select count(*) from public.financial_budget_change_request_lines)::bigint,
    (select count(*) from public.financial_pending_new_project_funds)::bigint,
    (select count(*) from public.financial_unallocated_fund_lots)::bigint,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '차년도 신규사업 예정예산 마이그레이션이 기존 TEST 업무 행 또는 금액을 변경했습니다.';
  end if;
  select lower(pg_get_functiondef(
    'public.get_financial_new_project_funding_sources(integer,uuid)'::regprocedure)) into v_source;
  select lower(pg_get_functiondef(
    'public.financial_apply_budget_change_to_pending_funds(uuid)'::regprocedure)) into v_apply;
  if position('planned_project_year = pending.fiscal_year + 1' in v_source) = 0
     or position('financial_pending_new_project_funds' in v_apply) = 0
     or position('v_classification_after - v_classification_before' in v_apply) = 0 then
    raise exception using errcode = '55000', message = '차년도 신규사업 예정예산 정의 검증에 실패했습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
