begin;

do $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode = '55000', message =
      '복수 목적지 예산조정 보정은 승인된 TEST Ledger runtime에서만 설치할 수 있습니다.';
  end if;
end;
$$;

create temporary table multi_destination_budget_change_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric as project_alloc_sum,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric as project_exec_sum,
  (select count(*) from public.financial_budget_change_requests)::bigint as request_count,
  (select count(*) from public.financial_budget_change_request_lines)::bigint as line_count,
  (select count(*) from public.financial_new_project_requests)::bigint as new_request_count,
  (select count(*) from public.financial_pending_new_project_funds)::bigint as pending_count,
  (select coalesce(sum(amount), 0) from public.financial_pending_new_project_funds)::numeric as pending_sum,
  (select count(*) from public.financial_unallocated_fund_lots)::bigint as lot_count,
  (select coalesce(sum(original_amount), 0) from public.financial_unallocated_fund_lots)::numeric as lot_sum,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric as movement_sum,
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric as transfer_sum;

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
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  select coalesce(sum(lines.amount), 0)::bigint into v_sum
  from public.financial_budget_change_request_lines as lines
  where lines.request_id = v_request.id;
  if v_sum <> v_request.total_amount then
    raise exception using errcode = '23514', message = '감액액과 목적지 배분 합계의 차액은 0원이어야 합니다.';
  end if;
  if exists (
    select 1 from (
      select case
        when lines.destination_type = 'EXISTING_PROJECT' then 'EXISTING:' || lines.destination_project_id::text
        when lines.unlinked_funding_only then 'RESERVED:' || lines.planned_project_year::text || ':' || lower(btrim(lines.planned_project_name))
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
    select lines.*,
      new_requests.status as new_project_status,
      new_requests.region_id as new_project_region_id,
      new_requests.fiscal_year as new_project_year,
      new_requests.requested_amount as new_project_amount,
      new_requests.source_lot_id as new_project_source_lot_id,
      new_requests.source_budget_change_request_id as new_project_source_request_id,
      new_requests.source_budget_change_line_id as new_project_source_line_id
    from public.financial_budget_change_request_lines as lines
    left join public.financial_new_project_requests as new_requests
      on new_requests.id = lines.new_project_request_id
    where lines.request_id = v_request.id
    order by lines.line_no
  loop
    if v_line.destination_type = 'EXISTING_PROJECT' then
      if v_line.unlinked_funding_only then
        raise exception using errcode = '23514', message = '기존사업 목적지는 신규사업 예정재원으로 표시할 수 없습니다.';
      end if;
      select projects.region_id, projects.year into v_region_id, v_year
      from public.projects as projects where projects.id = v_line.destination_project_id;
      if not found or v_region_id <> v_request.region_id or v_year <> v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
      end if;
    elsif v_line.planned_project_year <> v_request.fiscal_year + 1 then
      raise exception using errcode = '23514', message = '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
    elsif v_line.unlinked_funding_only then
      if v_line.new_project_request_id is null
         or v_line.new_project_region_id <> v_request.region_id
         or v_line.new_project_year <> v_request.fiscal_year + 1
         or v_line.new_project_amount <> v_line.amount then
        raise exception using errcode = '23514', message =
          '예정재원 우선 목적지는 같은 지역·연도·금액의 신규사업 초안과 연결되어야 합니다.';
      end if;
      if v_request.status = 'APPLIED' then
        if v_line.materialized_lot_id is null
           or v_line.pending_fund_id is null
           or v_line.new_project_source_lot_id <> v_line.materialized_lot_id
           or v_line.new_project_source_request_id is not null
           or v_line.new_project_source_line_id is not null then
          raise exception using errcode = '23514', message =
            '적용된 예정재원과 신규사업 초안의 재원 연결이 일치하지 않습니다.';
        end if;
      elsif v_line.new_project_status <> 'DRAFT'
         or v_line.new_project_source_lot_id is not null
         or v_line.new_project_source_request_id <> v_request.id
         or v_line.new_project_source_line_id <> v_line.id then
        raise exception using errcode = '23514', message =
          '예정재원 우선 목적지의 최소정보 신규사업 초안이 요청 묶음과 일치하지 않습니다.';
      end if;
    elsif coalesce(v_line.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      v_registered_project_id := substring(v_line.note from 30)::uuid;
      select projects.region_id, projects.year into v_region_id, v_year
      from public.projects as projects where projects.id = v_registered_project_id;
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
  v_saved record;
  v_parent public.financial_budget_change_requests%rowtype;
  v_line public.financial_budget_change_request_lines%rowtype;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  if jsonb_typeof(p_destinations) <> 'array' then
    raise exception using errcode = '22023', message = '예산조정 목적지를 확인해 주세요.';
  end if;
  for v_item in select value from jsonb_array_elements(p_destinations)
  loop
    if coalesce((v_item ->> 'create_unlinked_funding')::boolean, false)
       and (v_item ->> 'destination_type' <> 'PENDING_NEW_PROJECT'
         or nullif(v_item ->> 'existing_new_project_request_id', '') is not null
         or coalesce(v_item ->> 'note', '') like 'REGISTERED_NEXT_YEAR_PROJECT:%') then
      raise exception using errcode = '23514', message =
        '예정재원 우선 확보는 차년도 최소정보 신규사업 초안으로만 요청할 수 있습니다.';
    end if;
  end loop;

  select saved.* into v_saved
  from public.financial_test_uat_save_budget_change_request_with_drafts(
    p_source_project_id, p_source_budget_year_id, p_destinations,
    p_effective_date, p_reason, p_idempotency_key, false
  ) as saved;
  select requests.* into v_parent
  from public.financial_budget_change_requests as requests
  where requests.id = v_saved.request_id for update;

  for v_item, v_ordinality in
    select items.value, items.ordinality
    from jsonb_array_elements(p_destinations) with ordinality as items(value, ordinality)
  loop
    if not coalesce((v_item ->> 'create_unlinked_funding')::boolean, false) then
      continue;
    end if;
    select lines.* into v_line
    from public.financial_budget_change_request_lines as lines
    where lines.request_id = v_parent.id
      and lines.line_no = v_ordinality
      and lines.destination_type = 'PENDING_NEW_PROJECT'
    for update;
    if not found or v_line.new_project_request_id is null then
      raise exception using errcode = '55000', message =
        '예정재원 목적지의 최소정보 신규사업 초안을 준비하지 못했습니다.';
    end if;
    update public.financial_budget_change_request_lines as lines
    set unlinked_funding_only = true
    where lines.id = v_line.id;
  end loop;

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

create or replace function public.financial_submit_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
begin
  select actor.actor_id, actor.actor_role, actor.actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor() as actor;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT'
     or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '요청자만 작성 중인 예산조정을 제출할 수 있습니다.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_request.adjustment_fingerprint, 0));
  if exists (
    select 1 from public.financial_budget_change_requests as requests
    where requests.id <> v_request.id
      and requests.adjustment_fingerprint = v_request.adjustment_fingerprint
      and requests.status in ('SUBMITTED', 'APPROVED', 'APPLIED')
      and requests.duplicate_of_request_id is null
  ) then
    raise exception using errcode = '23505', message = '동일 예산조정이 이미 승인 요청되었거나 적용되었습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  update public.financial_new_project_requests as new_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where new_requests.source_budget_change_request_id = v_request.id
    and new_requests.status = 'DRAFT'
    and exists (
      select 1 from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_request.id
        and lines.new_project_request_id = new_requests.id
        and not lines.unlinked_funding_only
    );
  update public.financial_budget_change_requests as requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_budget_change_request_group(
  p_request_id uuid,
  p_new_project_codes jsonb default '{}'::jsonb
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
  v_new_request public.financial_new_project_requests%rowtype;
  v_code text;
begin
  v_actor_id := public.financial_require_admin();
  if jsonb_typeof(coalesce(p_new_project_codes, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = '신규사업 공식 사업코드 목록을 확인해 주세요.';
  end if;
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '다른 관리자가 제출된 예산 조정만 승인할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  for v_new_request in
    select new_requests.*
    from public.financial_new_project_requests as new_requests
    join public.financial_budget_change_request_lines as lines
      on lines.new_project_request_id = new_requests.id
    where lines.request_id = v_request.id
      and not lines.unlinked_funding_only
    order by new_requests.id for update of new_requests
  loop
    v_code := btrim(coalesce(p_new_project_codes ->> v_new_request.id::text, ''));
    if char_length(v_code) not between 3 and 100
       or v_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$' then
      raise exception using errcode = '22023', message =
        format('%s 신규사업의 공식 사업코드를 입력해 주세요.', v_new_request.project_name);
    end if;
    if exists (select 1 from public.projects where project_code = v_code or project_id = v_code)
       or exists (select 1 from public.financial_new_project_requests as other
         where other.id <> v_new_request.id and other.official_project_code = v_code) then
      raise exception using errcode = '23505', message = '공식 사업코드가 기존 사업 또는 다른 요청과 중복됩니다.';
    end if;
    update public.financial_new_project_requests as new_requests
    set status = 'APPROVED', official_project_code = v_code,
        approved_by = v_actor_id, approved_at = clock_timestamp()
    where new_requests.id = v_new_request.id;
  end loop;
  update public.financial_budget_change_requests as requests
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_apply_budget_change_request(p_request_id uuid)
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
  v_new_request public.financial_new_project_requests%rowtype;
  v_source_wallet public.project_budget_years%rowtype;
  v_destination_project_id uuid;
  v_destination_budget_year_id uuid;
  v_destination_region uuid;
  v_destination_year integer;
  v_transfer_id uuid;
  v_lot_id uuid;
  v_movement_id uuid;
  v_pending_id uuid;
  v_classification_before bigint;
  v_classification_after bigint;
  v_line_key uuid;
  v_line_fingerprint text;
  v_movement_fingerprint text;
  v_remaining bigint;
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
  perform public.financial_validate_budget_change_request(v_request.id);
  perform public.financial_assert_funding_origin_evidence(
    v_request.region_id, 'SYSTEM_NATIVE', v_request.effective_date, null);

  select wallets.* into v_source_wallet
  from public.project_budget_years as wallets
  where wallets.id = v_request.source_budget_year_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.';
  end if;
  perform public.financial_require_available_amount(
    v_source_wallet.id, v_request.total_amount,
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
    v_classification_before + v_request.total_amount,
    v_request.total_amount, false);
  perform public.financial_assert_project_baseline_ready(
    v_request.source_project_id, -v_request.total_amount, 0,
    v_request.total_amount, 'SYSTEM_NATIVE', false);

  v_classification_after := v_classification_before;
  for v_line in
    select lines.*
    from public.financial_budget_change_request_lines as lines
    where lines.request_id = v_request.id
    order by lines.line_no for update of lines
  loop
    v_line_key := gen_random_uuid();
    v_line_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'request_id', v_request.id, 'line_id', v_line.id,
      'destination_type', v_line.destination_type, 'amount', v_line.amount,
      'reserved_draft', v_line.unlinked_funding_only));

    if v_line.destination_type = 'EXISTING_PROJECT' then
      select projects.region_id, projects.year into v_destination_region, v_destination_year
      from public.projects as projects where projects.id = v_line.destination_project_id;
      if not found or v_destination_region <> v_request.region_id
         or v_destination_year <> v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
      end if;
      perform public.financial_test_uat_bootstrap_project(v_line.destination_project_id);
      perform public.financial_assert_project_baseline_ready(
        v_line.destination_project_id, v_line.amount, 0, 0,
        'SYSTEM_NATIVE', false);
      v_destination_budget_year_id := public.financial_get_or_create_budget_year(
        v_line.destination_project_id, v_source_wallet.budget_cohort_id,
        v_source_wallet.fiscal_year, v_actor_id);
      perform 1 from public.project_budget_years as wallets
      where wallets.id = any(array[v_source_wallet.id, v_destination_budget_year_id])
      order by wallets.id for update;
      insert into public.project_fund_transfers (
        source_budget_year_id, destination_budget_year_id, amount, status,
        transaction_kind, reason_code, memo, effective_date, idempotency_key,
        created_by, submitted_at, confirmed_by, confirmed_at,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_wallet.id, v_destination_budget_year_id, v_line.amount, 'CONFIRMED',
        'NORMAL', 'BUDGET_REALLOCATION', coalesce(v_line.note, v_request.reason),
        v_request.effective_date, v_line_key, v_request.requested_by,
        v_request.submitted_at, v_actor_id, clock_timestamp(),
        'SYSTEM_NATIVE', null, v_line_fingerprint
      ) returning id into v_transfer_id;
      insert into public.financial_project_decrease_classifications (
        region_id, fiscal_year, budget_cohort_id, source_project_id,
        source_budget_year_id, outcome_type, amount,
        decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, transfer_id,
        record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year,
        v_source_wallet.budget_cohort_id, v_request.source_project_id,
        v_source_wallet.id, 'EXISTING_PROJECT_TRANSFER', v_line.amount,
        v_classification_after, v_classification_after + v_line.amount,
        'project_fund_transfers', v_transfer_id, v_transfer_id,
        'SYSTEM_NATIVE', null, gen_random_uuid(), v_line_fingerprint,
        v_request.requested_by
      );
      update public.financial_budget_change_request_lines as lines
      set materialized_transfer_id = v_transfer_id
      where lines.id = v_line.id;
    else
      insert into public.financial_unallocated_fund_lots (
        region_id, fiscal_year, budget_cohort_id, source_project_id,
        source_budget_year_id, original_amount, reason, effective_date,
        record_origin, evidence_id, idempotency_key, request_fingerprint,
        created_by, confirmed_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year,
        v_source_wallet.budget_cohort_id, v_request.source_project_id,
        v_source_wallet.id, v_line.amount,
        case when v_line.unlinked_funding_only
          then '차년도 신규사업 예정재원 · ' || v_line.planned_project_name
          else '차년도 신규사업 배분 · ' || v_line.planned_project_name end,
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

      if v_line.unlinked_funding_only then
        select new_requests.* into v_new_request
        from public.financial_new_project_requests as new_requests
        where new_requests.id = v_line.new_project_request_id
          and new_requests.source_budget_change_request_id = v_request.id
          and new_requests.source_budget_change_line_id = v_line.id
          and new_requests.status = 'DRAFT'
        for update;
        if not found
           or v_new_request.region_id <> v_request.region_id
           or v_new_request.fiscal_year <> v_request.fiscal_year + 1
           or v_new_request.requested_amount <> v_line.amount then
          raise exception using errcode = '23514', message =
            '예정재원 우선 목적지의 신규사업 초안이 요청 묶음과 일치하지 않습니다.';
        end if;
        insert into public.financial_pending_new_project_funds (
          region_id, fiscal_year, planned_project_name, planned_project_year,
          amount, lot_id, source_request_id, source_line_id, created_by
        ) values (
          v_request.region_id, v_source_wallet.fiscal_year,
          v_line.planned_project_name, v_line.planned_project_year,
          v_line.amount, v_lot_id, v_request.id, v_line.id,
          v_request.requested_by
        ) returning id into v_pending_id;
        update public.financial_new_project_requests as new_requests
        set source_lot_id = v_lot_id,
            source_budget_change_request_id = null,
            source_budget_change_line_id = null,
            linked_from_standalone = false
        where new_requests.id = v_new_request.id;
        update public.financial_budget_change_request_lines as lines
        set materialized_lot_id = v_lot_id,
            pending_fund_id = v_pending_id
        where lines.id = v_line.id;
      else
        if coalesce(v_line.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
          v_destination_project_id := substring(v_line.note from 30)::uuid;
          select projects.region_id, projects.year into v_destination_region, v_destination_year
          from public.projects as projects where projects.id = v_destination_project_id;
          if not found or v_destination_region <> v_request.region_id
             or v_destination_year <> v_request.fiscal_year + 1 then
            raise exception using errcode = '23514', message =
              '등록된 신규사업은 같은 지역의 다음 연도 사업이어야 합니다.';
          end if;
          perform public.financial_test_uat_bootstrap_project(v_destination_project_id);
          perform public.financial_assert_project_baseline_ready(
            v_destination_project_id, v_line.amount, 0, 0,
            'SYSTEM_NATIVE', false);
        else
          select new_requests.* into v_new_request
          from public.financial_new_project_requests as new_requests
          where new_requests.id = v_line.new_project_request_id
            and new_requests.source_budget_change_request_id = v_request.id
            and new_requests.source_budget_change_line_id = v_line.id
          for update;
          if not found or v_new_request.status <> 'APPROVED'
             or v_new_request.requested_amount <> v_line.amount
             or v_new_request.fiscal_year <> v_request.fiscal_year + 1
             or v_new_request.region_id <> v_request.region_id then
            raise exception using errcode = '23514', message =
              '승인된 신규사업 생성 요청이 예산조정 목적지와 일치하지 않습니다.';
          end if;
          if exists (select 1 from public.projects as projects
            where projects.project_code = v_new_request.official_project_code
               or projects.project_id = v_new_request.official_project_code) then
            raise exception using errcode = '23505', message =
              '공식 사업코드가 기존 사업과 중복됩니다.';
          end if;
          insert into public.projects (
            project_id, project_code, region_id, year, project_name,
            fund_project_name, detail_project_name, project_period,
            project_start_year, project_end_year, status, business_type,
            large_category_id, middle_category_id, total_budget,
            original_alloc, increase_amount, decrease_amount, alloc, exec, rate
          ) values (
            v_new_request.official_project_code, v_new_request.official_project_code,
            v_new_request.region_id, v_new_request.fiscal_year,
            v_new_request.project_name, v_new_request.fund_project_name,
            v_new_request.detail_project_name, v_new_request.project_period,
            v_new_request.project_start_year, v_new_request.project_end_year,
            v_new_request.project_status, v_new_request.business_type,
            v_new_request.large_category_id, v_new_request.middle_category_id,
            v_new_request.requested_amount, 0, v_new_request.requested_amount,
            0, v_new_request.requested_amount, 0, 0
          ) returning id into v_destination_project_id;
        end if;

        v_destination_budget_year_id := public.financial_get_or_create_budget_year(
          v_destination_project_id, v_source_wallet.budget_cohort_id,
          v_source_wallet.fiscal_year, v_actor_id);
        perform 1 from public.project_budget_years as wallets
        where wallets.id = any(array[v_source_wallet.id, v_destination_budget_year_id])
        order by wallets.id for update;
        v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot_id);
        if v_remaining <> v_line.amount then
          raise exception using errcode = '55000', message =
            '신규사업 예정재원 잔액이 요청액과 일치하지 않습니다.';
        end if;
        v_movement_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
          'budget_change_request_id', v_request.id,
          'budget_change_line_id', v_line.id,
          'source_lot_id', v_lot_id,
          'destination_project_id', v_destination_project_id,
          'amount', v_line.amount));
        insert into public.financial_unallocated_fund_movements (
          lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
          destination_project_id, destination_budget_year_id, new_project_request_id,
          amount, effective_date, record_origin, evidence_id, memo,
          idempotency_key, request_fingerprint, created_by, confirmed_by
        ) values (
          v_lot_id, v_request.region_id, v_source_wallet.budget_cohort_id,
          case when v_line.new_project_request_id is null
            then 'ALLOCATE_EXISTING_PROJECT' else 'ALLOCATE_NEW_PROJECT' end,
          'NORMAL', v_destination_project_id, v_destination_budget_year_id,
          v_line.new_project_request_id, v_line.amount, v_request.effective_date,
          'SYSTEM_NATIVE', null, '예산조정 group 원자적 신규사업 배분',
          gen_random_uuid(), v_movement_fingerprint,
          v_request.requested_by, v_actor_id
        ) returning id into v_movement_id;

        if v_line.new_project_request_id is not null then
          update public.financial_new_project_requests as new_requests
          set status = 'APPLIED', applied_by = v_actor_id,
              applied_at = clock_timestamp(),
              materialized_project_id = v_destination_project_id,
              materialized_movement_id = v_movement_id
          where new_requests.id = v_line.new_project_request_id;
          perform public.financial_write_audit(
            v_destination_project_id, v_request.region_id,
            'NEW_PROJECT_APPLIED', 'financial_new_project_requests',
            v_line.new_project_request_id, v_actor_id,
            jsonb_build_object('project_code', v_new_request.official_project_code,
              'budget_change_request_id', v_request.id,
              'budget_change_line_id', v_line.id,
              'source_lot_id', v_lot_id, 'amount', v_line.amount,
              'destination_budget_year_id', v_destination_budget_year_id,
              'movement_id', v_movement_id, 'atomic_group_apply', true));
        end if;
        update public.financial_budget_change_request_lines as lines
        set materialized_lot_id = v_lot_id
        where lines.id = v_line.id;
      end if;
    end if;
    v_classification_after := v_classification_after + v_line.amount;
  end loop;

  if v_classification_after - v_classification_before <> v_request.total_amount then
    raise exception using errcode = '23514', message =
      '예산 조정 적용 차액이 0원이 아닙니다.';
  end if;
  update public.financial_budget_change_requests as requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp()
  where requests.id = v_request.id returning requests.* into v_request;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_APPLIED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('amount', v_request.total_amount, 'gap_amount', 0,
      'destination_count', (select count(*)
        from public.financial_budget_change_request_lines as lines
        where lines.request_id = v_request.id),
      'reserved_draft_count', (select count(*)
        from public.financial_budget_change_request_lines as lines
        where lines.request_id = v_request.id and lines.unlinked_funding_only),
      'atomic_group_apply', true));
  return query select v_request.id, v_request.status, 0::bigint;
end;
$$;

create or replace function public.financial_apply_budget_change_to_pending_funds(p_request_id uuid)
returns table (request_id uuid, status text, gap_amount bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  select applied.request_id, applied.status, applied.gap_amount
  from public.financial_apply_budget_change_request(p_request_id) as applied;
$$;

create or replace function public.financial_apply_budget_change_request_dispatch(p_request_id uuid)
returns table (request_id uuid, status text, gap_amount bigint)
language sql
security definer
set search_path = public, pg_temp
as $$
  select applied.request_id, applied.status, applied.gap_amount
  from public.financial_apply_budget_change_request(p_request_id) as applied;
$$;

create or replace function public.financial_apply_new_project_request_v2(p_request_id uuid)
returns table (
  request_id uuid,
  project_id uuid,
  project_code text,
  movement_id uuid,
  budget_year_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_applied record;
  v_request public.financial_new_project_requests%rowtype;
  v_pending public.financial_pending_new_project_funds%rowtype;
  v_link public.financial_pending_new_project_link_requests%rowtype;
  v_link_result record;
begin
  select applied.* into v_applied
  from public.financial_apply_new_project_request(p_request_id) as applied;
  select requests.* into v_request
  from public.financial_new_project_requests as requests
  where requests.id = p_request_id for update;

  select pending.* into v_pending
  from public.financial_pending_new_project_funds as pending
  join public.financial_budget_change_request_lines as lines
    on lines.pending_fund_id = pending.id
  join public.financial_budget_change_requests as budget_requests
    on budget_requests.id = lines.request_id
  where lines.new_project_request_id = v_request.id
    and lines.unlinked_funding_only
    and budget_requests.status = 'APPLIED'
  for update of pending;

  if not found then
    return query select v_applied.request_id, v_applied.project_id,
      v_applied.project_code, v_applied.movement_id, v_applied.budget_year_id;
    return;
  end if;

  select links.* into v_link
  from public.financial_pending_new_project_link_requests as links
  where links.pending_fund_id = v_pending.id
    and links.destination_project_id = v_applied.project_id
  order by links.requested_at desc
  limit 1 for update;
  if not found then
    raise exception using errcode = '55000', message =
      '신규사업과 예정재원의 자동 연결 요청을 찾을 수 없습니다.';
  end if;
  if v_link.status = 'SUBMITTED' then
    perform 1 from public.financial_review_pending_new_project_link(v_link.id, 'APPROVE', null);
    select links.* into v_link
    from public.financial_pending_new_project_link_requests as links
    where links.id = v_link.id for update;
  end if;
  if v_link.status = 'APPROVED' then
    select applied.* into v_link_result
    from public.financial_apply_pending_new_project_link(v_link.id) as applied;
    select links.* into v_link
    from public.financial_pending_new_project_link_requests as links
    where links.id = v_link.id;
  end if;
  if v_link.status <> 'APPLIED' or v_link.materialized_movement_id is null then
    raise exception using errcode = '55000', message =
      '신규사업 예정재원 자동 연결을 완료하지 못했습니다.';
  end if;
  update public.financial_new_project_requests as requests
  set materialized_movement_id = v_link.materialized_movement_id
  where requests.id = v_request.id;
  return query select v_request.id, v_applied.project_id,
    v_applied.project_code, v_link.materialized_movement_id,
    v_applied.budget_year_id;
end;
$$;

revoke all on function public.financial_validate_budget_change_request(uuid)
  from public, anon, authenticated;
revoke all on function public.financial_test_uat_save_budget_change_request_complete(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_test_uat_save_budget_change_request_complete(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;
revoke all on function public.financial_submit_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_submit_budget_change_request(uuid)
  to authenticated;
revoke all on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  from public, anon;
grant execute on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  to authenticated;
revoke all on function public.financial_apply_budget_change_request(uuid)
  from public, anon, authenticated;
revoke all on function public.financial_apply_budget_change_to_pending_funds(uuid)
  from public, anon, authenticated;
revoke all on function public.financial_apply_budget_change_request_dispatch(uuid)
  from public, anon;
grant execute on function public.financial_apply_budget_change_request_dispatch(uuid)
  to authenticated;
revoke all on function public.financial_apply_new_project_request_v2(uuid)
  from public, anon;
grant execute on function public.financial_apply_new_project_request_v2(uuid)
  to authenticated;

do $$
declare
  v_before multi_destination_budget_change_snapshot%rowtype;
  v_after multi_destination_budget_change_snapshot%rowtype;
  v_save_definition text;
  v_apply_definition text;
  v_new_apply_definition text;
begin
  select * into v_before from multi_destination_budget_change_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric,
    (select count(*) from public.financial_budget_change_requests)::bigint,
    (select count(*) from public.financial_budget_change_request_lines)::bigint,
    (select count(*) from public.financial_new_project_requests)::bigint,
    (select count(*) from public.financial_pending_new_project_funds)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_pending_new_project_funds)::numeric,
    (select count(*) from public.financial_unallocated_fund_lots)::bigint,
    (select coalesce(sum(original_amount), 0) from public.financial_unallocated_fund_lots)::numeric,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric,
    (select count(*) from public.project_fund_transfers)::bigint,
    (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '복수 목적지 보정 설치 중 기존 사업·요청·금액·Ledger 행이 변경되었습니다.';
  end if;
  select lower(pg_get_functiondef(
    'public.financial_test_uat_save_budget_change_request_complete(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure
  )) into v_save_definition;
  select lower(pg_get_functiondef(
    'public.financial_apply_budget_change_request(uuid)'::regprocedure
  )) into v_apply_definition;
  select lower(pg_get_functiondef(
    'public.financial_apply_new_project_request_v2(uuid)'::regprocedure
  )) into v_new_apply_definition;
  if position('v_has_unlinked and v_has_other' in v_save_definition) > 0
     or position('delete from public.financial_new_project_requests' in v_save_definition) > 0
     or position('reserved_draft_count' in v_apply_definition) = 0
     or position('financial_pending_new_project_funds' in v_apply_definition) = 0
     or position('financial_apply_pending_new_project_link' in v_new_apply_definition) = 0 then
    raise exception using errcode = '55000', message =
      '복수 목적지·초안 연결·통합 APPLY 함수 정의 검증에 실패했습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
