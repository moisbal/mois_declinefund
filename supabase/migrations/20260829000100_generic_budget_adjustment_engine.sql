-- TEST-only generic budget-adjustment engine.
-- Request rows are non-monetary. One admin APPLY atomically materializes the
-- source decrease, every destination increase, new projects, movement trace,
-- immutable before/after snapshots, request state, and audit rows.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is null then
    raise exception using errcode = '55000', message =
      'Generic budget-adjustment engine is pinned to the approved TEST project.';
  end if;
end;
$$;

alter table public.financial_budget_change_request_lines
  add column planned_fund_project_name text,
  add column planned_detail_project_name text,
  add column planned_project_period text,
  add column planned_project_start_year integer,
  add column planned_project_end_year integer,
  add column planned_project_status text,
  add column planned_business_type text,
  add column planned_large_category_id uuid references public.large_categories(id) on delete restrict,
  add column planned_middle_category_id uuid,
  add column new_project_request_id uuid;

alter table public.financial_budget_change_request_lines
  add constraint financial_budget_change_line_period_order check (
    planned_project_start_year is null or planned_project_end_year is null
    or planned_project_start_year <= planned_project_end_year
  ),
  add constraint financial_budget_change_line_business_type check (
    planned_business_type is null or planned_business_type in ('HW', 'SW', 'COMPOSITE')
  ),
  add constraint financial_budget_change_line_category_pair check (
    (planned_large_category_id is null and planned_middle_category_id is null)
    or (planned_large_category_id is not null and planned_middle_category_id is not null)
  ),
  add constraint financial_budget_change_line_middle_large_fkey
    foreign key (planned_middle_category_id, planned_large_category_id)
    references public.middle_categories(id, large_category_id) on delete restrict;

alter table public.financial_new_project_requests
  alter column source_lot_id drop not null,
  add column source_budget_change_request_id uuid
    references public.financial_budget_change_requests(id) on delete restrict,
  add column source_budget_change_line_id uuid
    references public.financial_budget_change_request_lines(id) on delete restrict;

create unique index financial_new_project_requests_budget_line_uidx
  on public.financial_new_project_requests(source_budget_change_line_id)
  where source_budget_change_line_id is not null;

alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_source_shape check (
    (source_budget_change_request_id is null and source_budget_change_line_id is null
      and source_lot_id is not null)
    or (source_budget_change_request_id is not null and source_budget_change_line_id is not null)
  );

alter table public.financial_budget_change_request_lines
  add constraint financial_budget_change_line_new_project_fkey
  foreign key (new_project_request_id)
  references public.financial_new_project_requests(id) on delete restrict;

create unique index financial_budget_change_line_new_project_uidx
  on public.financial_budget_change_request_lines(new_project_request_id)
  where new_project_request_id is not null;

alter table public.financial_new_project_requests
  drop constraint if exists financial_new_project_requests_state_shape;
alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_state_shape check (
    (status = 'DRAFT' and official_project_code is null and submitted_by is null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and official_project_code is null
      and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and official_project_code is not null
      and approved_by is not null and approved_at is not null
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and official_project_code is null
      and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and official_project_code is not null
      and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null
      and materialized_project_id is not null)
  );

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
        when lines.destination_type = 'EXISTING_PROJECT'
          then 'EXISTING:' || lines.destination_project_id::text
        when coalesce(lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
          then 'REGISTERED:' || substring(lines.note from 30)
        else 'PLANNED:' || lines.planned_project_year::text || ':' || lower(btrim(lines.planned_project_name))
      end as destination_key
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = v_request.id
    ) as destination_keys
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
    select lines.*, new_requests.status as new_project_status
    from public.financial_budget_change_request_lines as lines
    left join public.financial_new_project_requests as new_requests
      on new_requests.id = lines.new_project_request_id
    where lines.request_id = v_request.id order by lines.line_no
  loop
    if v_line.destination_type = 'EXISTING_PROJECT' then
      select region_id, year into v_region_id, v_year
      from public.projects where id = v_line.destination_project_id;
      if not found or v_region_id <> v_request.region_id or v_year <> v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업 목적지는 같은 지역·같은 사업연도의 다른 사업이어야 합니다.';
      end if;
    elsif v_line.planned_project_year <> v_request.fiscal_year + 1 then
      raise exception using errcode = '23514', message = '신규사업 목적지는 출처 사업의 다음 연도여야 합니다.';
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
        '미등록 신규사업 생성 요청은 예산조정과 같은 group·상태여야 합니다.';
    end if;
  end loop;
end;
$$;

create or replace function public.financial_create_budget_change_request(
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
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_source_project_id uuid; v_region_id uuid; v_fiscal_year integer;
  v_total bigint := 0; v_before bigint; v_fingerprint text;
  v_request public.financial_budget_change_requests%rowtype;
  v_item jsonb; v_kind text; v_amount bigint; v_destination_project_id uuid;
  v_planned_name text; v_planned_year integer; v_line_no integer := 0;
  v_existing_region uuid; v_existing_year integer; v_line_id uuid;
  v_new_request_id uuid; v_destination_key text; v_destination_keys text[] := array[]::text[];
  v_registered_project_id uuid; v_new_fingerprint text;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null or p_effective_date is null
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000
     or jsonb_typeof(p_destinations) <> 'array'
     or jsonb_array_length(p_destinations) not between 1 and 20 then
    raise exception using errcode = '22023', message = '예산 조정 사유와 1~20개의 목적지를 입력해 주세요.';
  end if;
  select wallets.project_id, projects.region_id, projects.year
    into v_source_project_id, v_region_id, v_fiscal_year
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = p_source_budget_year_id;
  if not found then raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.'; end if;
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '자기 지역 사업만 예산 조정을 요청할 수 있습니다.';
  end if;
  if exists (select 1 from public.financial_unclassified_project_decreases
    where project_id = v_source_project_id and unclassified_amount > 0) then
    raise exception using errcode = '23514', message = '기존 감액의 재원 연결을 먼저 완료해 주세요.';
  end if;

  for v_item in select value from jsonb_array_elements(p_destinations) loop
    v_kind := v_item ->> 'destination_type';
    if coalesce(v_item ->> 'amount', '') !~ '^[1-9][0-9]*$'
       or v_kind not in ('EXISTING_PROJECT', 'PENDING_NEW_PROJECT') then
      raise exception using errcode = '22023', message = '모든 목적지 금액은 0보다 큰 원 단위 정수여야 합니다.';
    end if;
    v_amount := (v_item ->> 'amount')::bigint;
    v_total := v_total + v_amount;
    if v_kind = 'EXISTING_PROJECT' then
      v_destination_project_id := (v_item ->> 'destination_project_id')::uuid;
      select region_id, year into v_existing_region, v_existing_year
      from public.projects where id = v_destination_project_id;
      if not found or v_existing_region <> v_region_id or v_existing_year <> v_fiscal_year
         or v_destination_project_id = v_source_project_id then
        raise exception using errcode = '23514', message =
          '기존사업은 같은 지역·같은 사업연도의 다른 사업만 선택할 수 있습니다.';
      end if;
      v_destination_key := 'EXISTING:' || v_destination_project_id::text;
    else
      v_planned_name := btrim(coalesce(v_item ->> 'planned_project_name', ''));
      v_planned_year := (v_item ->> 'planned_project_year')::integer;
      if char_length(v_planned_name) not between 1 and 500 or v_planned_year <> v_fiscal_year + 1 then
        raise exception using errcode = '23514', message = '신규사업은 같은 지역의 다음 연도로 입력해 주세요.';
      end if;
      if coalesce(v_item ->> 'note', '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
        v_registered_project_id := substring(v_item ->> 'note' from 30)::uuid;
        select region_id, year into v_existing_region, v_existing_year
        from public.projects where id = v_registered_project_id;
        if not found or v_existing_region <> v_region_id or v_existing_year <> v_fiscal_year + 1 then
          raise exception using errcode = '23514', message = '등록된 신규사업은 같은 지역의 다음 연도 사업이어야 합니다.';
        end if;
        v_destination_key := 'REGISTERED:' || v_registered_project_id::text;
      else
        v_destination_key := 'PLANNED:' || v_planned_year::text || ':' || lower(v_planned_name);
        if (v_item ->> 'planned_project_start_year') is not null
           and (v_item ->> 'planned_project_end_year') is not null
           and (v_item ->> 'planned_project_start_year')::integer > (v_item ->> 'planned_project_end_year')::integer then
          raise exception using errcode = '23514', message = '신규사업의 시작연도는 종료연도보다 늦을 수 없습니다.';
        end if;
      end if;
    end if;
    if v_destination_key = any(v_destination_keys) then
      raise exception using errcode = '23505', message = '같은 목적지를 중복하여 선택할 수 없습니다.';
    end if;
    v_destination_keys := array_append(v_destination_keys, v_destination_key);
  end loop;

  perform 1 from public.project_budget_years where id = p_source_budget_year_id for update;
  perform public.financial_require_available_amount(
    p_source_budget_year_id, v_total, '감액액이 현재 미집행액을 초과합니다.');
  v_before := public.financial_budget_change_visible_decrease(v_source_project_id);
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'source_budget_year_id', p_source_budget_year_id, 'destinations', p_destinations,
    'effective_date', p_effective_date, 'reason', btrim(p_reason)));
  select * into v_request from public.financial_budget_change_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message = '요청 식별키가 다른 사용자에게 속해 있습니다.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_request.request_fingerprint, v_fingerprint, 'financial_budget_change_requests');
    return query select v_request.id, v_request.status, 0::bigint; return;
  end if;
  insert into public.financial_budget_change_requests (
    region_id, fiscal_year, source_project_id, source_budget_year_id,
    total_amount, decrease_amount_before, decrease_amount_after,
    effective_date, reason, status, idempotency_key, request_fingerprint,
    requested_by, submitted_by, submitted_at
  ) values (
    v_region_id, v_fiscal_year, v_source_project_id, p_source_budget_year_id,
    v_total, v_before, v_before + v_total, p_effective_date, btrim(p_reason),
    case when p_submit then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when p_submit then v_actor_id else null end,
    case when p_submit then clock_timestamp() else null end
  ) returning * into v_request;

  for v_item in select value from jsonb_array_elements(p_destinations) loop
    v_line_no := v_line_no + 1; v_kind := v_item ->> 'destination_type';
    insert into public.financial_budget_change_request_lines (
      request_id, line_no, destination_type, destination_project_id,
      planned_project_name, planned_project_year, amount, note,
      planned_fund_project_name, planned_detail_project_name, planned_project_period,
      planned_project_start_year, planned_project_end_year, planned_project_status,
      planned_business_type, planned_large_category_id, planned_middle_category_id
    ) values (
      v_request.id, v_line_no, v_kind,
      case when v_kind = 'EXISTING_PROJECT' then (v_item ->> 'destination_project_id')::uuid else null end,
      case when v_kind = 'PENDING_NEW_PROJECT' then btrim(v_item ->> 'planned_project_name') else null end,
      case when v_kind = 'PENDING_NEW_PROJECT' then (v_item ->> 'planned_project_year')::integer else null end,
      (v_item ->> 'amount')::bigint, nullif(btrim(coalesce(v_item ->> 'note', '')), ''),
      nullif(btrim(coalesce(v_item ->> 'planned_fund_project_name', '')), ''),
      nullif(btrim(coalesce(v_item ->> 'planned_detail_project_name', '')), ''),
      nullif(btrim(coalesce(v_item ->> 'planned_project_period', '')), ''),
      nullif(v_item ->> 'planned_project_start_year', '')::integer,
      nullif(v_item ->> 'planned_project_end_year', '')::integer,
      nullif(btrim(coalesce(v_item ->> 'planned_project_status', '')), ''),
      nullif(v_item ->> 'planned_business_type', ''),
      nullif(v_item ->> 'planned_large_category_id', '')::uuid,
      nullif(v_item ->> 'planned_middle_category_id', '')::uuid
    ) returning id into v_line_id;
    if v_kind = 'PENDING_NEW_PROJECT'
       and coalesce(v_item ->> 'note', '') not like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      v_new_request_id := gen_random_uuid();
      v_new_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
        'budget_change_request_id', v_request.id, 'budget_change_line_id', v_line_id,
        'project_name', btrim(v_item ->> 'planned_project_name'),
        'fiscal_year', (v_item ->> 'planned_project_year')::integer,
        'requested_amount', (v_item ->> 'amount')::bigint));
      insert into public.financial_new_project_requests (
        id, region_id, fiscal_year, project_name, fund_project_name, detail_project_name,
        project_period, project_start_year, project_end_year, project_status, business_type,
        large_category_id, middle_category_id, source_lot_id, requested_amount,
        status, idempotency_key, request_fingerprint, requested_by, requested_at,
        submitted_by, submitted_at, source_budget_change_request_id, source_budget_change_line_id
      ) values (
        v_new_request_id, v_region_id, (v_item ->> 'planned_project_year')::integer,
        btrim(v_item ->> 'planned_project_name'),
        nullif(btrim(coalesce(v_item ->> 'planned_fund_project_name', '')), ''),
        coalesce(nullif(btrim(coalesce(v_item ->> 'planned_detail_project_name', '')), ''),
          btrim(v_item ->> 'planned_project_name')),
        nullif(btrim(coalesce(v_item ->> 'planned_project_period', '')), ''),
        nullif(v_item ->> 'planned_project_start_year', '')::integer,
        nullif(v_item ->> 'planned_project_end_year', '')::integer,
        coalesce(nullif(btrim(coalesce(v_item ->> 'planned_project_status', '')), ''), '정상추진'),
        nullif(v_item ->> 'planned_business_type', ''),
        nullif(v_item ->> 'planned_large_category_id', '')::uuid,
        nullif(v_item ->> 'planned_middle_category_id', '')::uuid,
        null, (v_item ->> 'amount')::bigint,
        case when p_submit then 'SUBMITTED' else 'DRAFT' end,
        gen_random_uuid(), v_new_fingerprint, v_actor_id, clock_timestamp(),
        case when p_submit then v_actor_id else null end,
        case when p_submit then clock_timestamp() else null end,
        v_request.id, v_line_id
      );
      update public.financial_budget_change_request_lines
      set new_project_request_id = v_new_request_id where id = v_line_id;
    end if;
  end loop;
  perform public.financial_write_audit(
    v_source_project_id, v_region_id,
    case when p_submit then 'BUDGET_REALLOCATION_SUBMITTED' else 'BUDGET_REALLOCATION_DRAFTED' end,
    'financial_budget_change_requests', v_request.id, v_actor_id,
    jsonb_build_object('amount', v_total, 'destination_count', v_line_no,
      'gap_amount', 0, 'grouped_new_project_count',
      (select count(*) from public.financial_budget_change_request_lines
       where financial_budget_change_request_lines.request_id = v_request.id
         and financial_budget_change_request_lines.new_project_request_id is not null)));
  return query select v_request.id, v_request.status, 0::bigint;
exception
  when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed then
    raise exception using errcode = '22023', message = '사업 또는 금액 입력값을 확인해 주세요.';
end;
$$;

create or replace function public.financial_submit_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_budget_change_requests where id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '요청자만 예산 조정 초안을 제출할 수 있습니다.';
  end if;
  update public.financial_new_project_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where source_budget_change_request_id = v_request.id and status = 'DRAFT';
  update public.financial_budget_change_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_budget_change_request_group(
  p_request_id uuid, p_new_project_codes jsonb default '{}'::jsonb
)
returns table (request_id uuid, status text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_budget_change_requests%rowtype;
  v_new_request public.financial_new_project_requests%rowtype; v_code text;
begin
  v_actor_id := public.financial_require_admin();
  if jsonb_typeof(coalesce(p_new_project_codes, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = '신규사업 공식 사업코드 목록을 확인해 주세요.';
  end if;
  select * into v_request from public.financial_budget_change_requests where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '다른 관리자가 제출된 예산 조정만 승인할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  for v_new_request in
    select * from public.financial_new_project_requests
    where source_budget_change_request_id = v_request.id order by id for update
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
    update public.financial_new_project_requests
    set status = 'APPROVED', official_project_code = v_code,
        approved_by = v_actor_id, approved_at = clock_timestamp()
    where id = v_new_request.id;
  end loop;
  update public.financial_budget_change_requests
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text)
language sql security definer set search_path = public, pg_temp
as $$
  select * from public.financial_approve_budget_change_request_group(p_request_id, '{}'::jsonb);
$$;

create or replace function public.financial_reject_budget_change_request(p_request_id uuid, p_reason text)
returns table (request_id uuid, status text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_budget_change_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '반려 사유를 입력해 주세요.';
  end if;
  select * into v_request from public.financial_budget_change_requests where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '다른 관리자가 제출된 예산 조정만 반려할 수 있습니다.';
  end if;
  update public.financial_new_project_requests
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where source_budget_change_request_id = v_request.id and status = 'SUBMITTED';
  update public.financial_budget_change_requests
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

-- Capture every destination that is materialized by the grouped APPLY.  The
-- previous trigger only knew about same-year EXISTING_PROJECT lines; grouped
-- next-year destinations resolve either from an already registered project or
-- from the new-project request created with the budget-change line.
create or replace function public.financial_capture_budget_change_amount_snapshots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_position record;
  v_destination record;
  v_destination_year integer;
  v_before_adjusted bigint;
  v_after_adjusted bigint;
begin
  if new.status <> 'APPLIED' or old.status = 'APPLIED' then return new; end if;

  select * into v_position
  from public.get_financial_budget_change_project_position(new.source_project_id);
  if not found then
    raise exception using errcode = '55000', message = 'Source amount snapshot position is missing.';
  end if;
  v_before_adjusted := v_position.original_allocation + v_position.increase_amount
    - new.decrease_amount_before;
  v_after_adjusted := v_position.original_allocation + v_position.increase_amount
    - new.decrease_amount_after;
  insert into public.financial_budget_workflow_amount_snapshots (
    event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
    project_role, amount, capture_kind,
    original_before, increase_before, decrease_before, adjusted_before,
    execution_before, unexecuted_before,
    original_after, increase_after, decrease_after, adjusted_after,
    execution_after, unexecuted_after
  ) values (
    'BUDGET_CHANGE', new.id, new.id, new.source_project_id, new.region_id, new.fiscal_year,
    'SOURCE', new.total_amount, 'EXACT_AT_APPLY',
    v_position.original_allocation, v_position.increase_amount, new.decrease_amount_before,
    v_before_adjusted, v_position.execution_amount,
    v_before_adjusted - v_position.execution_amount,
    v_position.original_allocation, v_position.increase_amount, new.decrease_amount_after,
    v_after_adjusted, v_position.execution_amount,
    v_after_adjusted - v_position.execution_amount
  ) on conflict do nothing;

  for v_destination in
    select lines.id as line_id, lines.amount,
      case
        when lines.destination_type = 'EXISTING_PROJECT' then lines.destination_project_id
        when coalesce(lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
          then substring(lines.note from 30)::uuid
        else new_requests.materialized_project_id
      end as project_id
    from public.financial_budget_change_request_lines as lines
    left join public.financial_new_project_requests as new_requests
      on new_requests.id = lines.new_project_request_id
    where lines.request_id = new.id
    order by lines.line_no
  loop
    if v_destination.project_id is null then
      raise exception using errcode = '55000', message =
        'Applied budget destination project is missing.';
    end if;
    select * into v_position
    from public.get_financial_budget_change_project_position(v_destination.project_id);
    select year into v_destination_year
    from public.projects where id = v_destination.project_id;
    if not found or v_position.increase_amount < v_destination.amount then
      raise exception using errcode = '55000', message =
        'Destination amount snapshot position is invalid.';
    end if;
    insert into public.financial_budget_workflow_amount_snapshots (
      event_type, event_id, budget_request_id, project_id, region_id, fiscal_year,
      project_role, amount, capture_kind,
      original_before, increase_before, decrease_before, adjusted_before,
      execution_before, unexecuted_before,
      original_after, increase_after, decrease_after, adjusted_after,
      execution_after, unexecuted_after
    ) values (
      'BUDGET_CHANGE', new.id, new.id, v_destination.project_id,
      new.region_id, v_destination_year, 'DESTINATION', v_destination.amount,
      'EXACT_AT_APPLY',
      v_position.original_allocation, v_position.increase_amount - v_destination.amount,
      v_position.decrease_amount, v_position.adjusted_allocation - v_destination.amount,
      v_position.execution_amount, v_position.unexecuted_amount - v_destination.amount,
      v_position.original_allocation, v_position.increase_amount,
      v_position.decrease_amount, v_position.adjusted_allocation,
      v_position.execution_amount, v_position.unexecuted_amount
    ) on conflict do nothing;
  end loop;
  return new;
end;
$$;

create or replace function public.financial_apply_budget_change_request(p_request_id uuid)
returns table (request_id uuid, status text, gap_amount bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  v_classification_before bigint;
  v_classification_after bigint;
  v_line_key uuid;
  v_line_fingerprint text;
  v_movement_fingerprint text;
  v_remaining bigint;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  v_actor_id := public.financial_require_admin();
  select * into v_request
  from public.financial_budget_change_requests
  where id = p_request_id for update;
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

  select * into v_source_wallet
  from public.project_budget_years
  where id = v_request.source_budget_year_id for update;
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
    select request_lines.*
    from public.financial_budget_change_request_lines as request_lines
    where request_lines.request_id = v_request.id
    order by request_lines.line_no for update of request_lines
  loop
    v_line_key := gen_random_uuid();
    v_line_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'request_id', v_request.id, 'line_id', v_line.id,
      'destination_type', v_line.destination_type, 'amount', v_line.amount));

    if v_line.destination_type = 'EXISTING_PROJECT' then
      select region_id, year into v_destination_region, v_destination_year
      from public.projects where id = v_line.destination_project_id;
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
      perform 1 from public.project_budget_years
      where id = any(array[v_source_wallet.id, v_destination_budget_year_id])
      order by id for update;
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
      update public.financial_budget_change_request_lines
      set materialized_transfer_id = v_transfer_id
      where id = v_line.id;
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
        '차년도 신규사업 배분 · ' || v_line.planned_project_name,
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

      if coalesce(v_line.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
        v_destination_project_id := substring(v_line.note from 30)::uuid;
        select region_id, year into v_destination_region, v_destination_year
        from public.projects where id = v_destination_project_id;
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
        select * into v_new_request
        from public.financial_new_project_requests
        where id = v_line.new_project_request_id
          and source_budget_change_request_id = v_request.id
          and source_budget_change_line_id = v_line.id
        for update;
        if not found or v_new_request.status <> 'APPROVED'
           or v_new_request.requested_amount <> v_line.amount
           or v_new_request.fiscal_year <> v_request.fiscal_year + 1
           or v_new_request.region_id <> v_request.region_id then
          raise exception using errcode = '23514', message =
            '승인된 신규사업 생성 요청이 예산조정 목적지와 일치하지 않습니다.';
        end if;
        if exists (select 1 from public.projects
          where project_code = v_new_request.official_project_code
             or project_id = v_new_request.official_project_code) then
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
      perform 1 from public.project_budget_years
      where id = any(array[v_source_wallet.id, v_destination_budget_year_id])
      order by id for update;
      v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot_id);
      if v_remaining <> v_line.amount then
        raise exception using errcode = '55000', message =
          '신규사업 예정재원 잔액이 요청액과 일치하지 않습니다.';
      end if;
      v_movement_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
        'budget_change_request_id', v_request.id, 'budget_change_line_id', v_line.id,
        'source_lot_id', v_lot_id, 'destination_project_id', v_destination_project_id,
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
        update public.financial_new_project_requests
        set status = 'APPLIED', applied_by = v_actor_id,
            applied_at = clock_timestamp(),
            materialized_project_id = v_destination_project_id,
            materialized_movement_id = v_movement_id
        where id = v_line.new_project_request_id;
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
      update public.financial_budget_change_request_lines
      set materialized_lot_id = v_lot_id
      where id = v_line.id;
    end if;
    v_classification_after := v_classification_after + v_line.amount;
  end loop;

  if v_classification_after - v_classification_before <> v_request.total_amount then
    raise exception using errcode = '23514', message =
      '예산 조정 적용 차액이 0원이 아닙니다.';
  end if;
  update public.financial_budget_change_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_APPLIED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('amount', v_request.total_amount, 'gap_amount', 0,
      'destination_count', (select count(*)
        from public.financial_budget_change_request_lines
        where financial_budget_change_request_lines.request_id = v_request.id),
      'atomic_group_apply', true));
  return query select v_request.id, v_request.status, 0::bigint;
end;
$$;

-- Keep the existing return signature stable while enriching each destination
-- JSON object with the grouped new-project and materialization state used by
-- both the local history and the admin queue.
create or replace function public.get_financial_budget_change_requests(
  p_project_id uuid default null,
  p_status text default null,
  p_year integer default null,
  p_region_id uuid default null
)
returns table (
  id uuid, region_id uuid, fiscal_year integer,
  source_project_id uuid, source_project_code text, source_project_name text,
  total_amount bigint, decrease_amount_before bigint, decrease_amount_after bigint,
  effective_date date, reason text, status text, requested_by uuid,
  requested_at timestamptz, rejection_reason text, destinations jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' and p_region_id is not null
     and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message =
      '다른 지역의 예산 조정은 조회할 수 없습니다.';
  end if;
  return query
  select requests.id, requests.region_id, requests.fiscal_year,
    requests.source_project_id, source.project_code::text,
    coalesce(nullif(btrim(source.detail_project_name), ''),
      nullif(btrim(source.fund_project_name), ''),
      nullif(btrim(source.project_name), ''),
      case when source.project_code is not null
        then '사업명 확인 필요 (' || source.project_code || ')'
        else '사업명 확인 필요' end)::text,
    requests.total_amount, requests.decrease_amount_before,
    requests.decrease_amount_after, requests.effective_date, requests.reason,
    requests.status, requests.requested_by, requests.requested_at,
    requests.rejection_reason,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_id', lines.id, 'line_no', lines.line_no,
        'destination_type', lines.destination_type,
        'destination_project_id', lines.destination_project_id,
        'destination_project_code', destination.project_code,
        'destination_project_name', coalesce(
          nullif(btrim(destination.detail_project_name), ''),
          nullif(btrim(destination.fund_project_name), ''),
          nullif(btrim(destination.project_name), ''),
          case when destination.project_code is not null
            then '사업명 확인 필요 (' || destination.project_code || ')' else null end),
        'planned_project_name', lines.planned_project_name,
        'planned_project_year', lines.planned_project_year,
        'planned_fund_project_name', lines.planned_fund_project_name,
        'planned_detail_project_name', lines.planned_detail_project_name,
        'planned_project_period', lines.planned_project_period,
        'planned_project_start_year', lines.planned_project_start_year,
        'planned_project_end_year', lines.planned_project_end_year,
        'planned_project_status', lines.planned_project_status,
        'planned_business_type', lines.planned_business_type,
        'planned_large_category_id', lines.planned_large_category_id,
        'planned_middle_category_id', lines.planned_middle_category_id,
        'amount', lines.amount, 'note', lines.note,
        'pending_fund_id', lines.pending_fund_id,
        'new_project_request_id', new_requests.id,
        'new_project_request_status', new_requests.status,
        'official_project_code', coalesce(
          new_requests.official_project_code, materialized.project_code),
        'materialized_project_id', materialized.id,
        'materialized_project_code', materialized.project_code,
        'materialized_project_name', coalesce(
          nullif(btrim(materialized.detail_project_name), ''),
          nullif(btrim(materialized.fund_project_name), ''),
          nullif(btrim(materialized.project_name), ''),
          case when materialized.project_code is not null
            then '사업명 확인 필요 (' || materialized.project_code || ')' else null end)
      ) order by lines.line_no)
      from public.financial_budget_change_request_lines as lines
      left join public.projects as destination
        on destination.id = lines.destination_project_id
      left join public.financial_new_project_requests as new_requests
        on new_requests.id = lines.new_project_request_id
      left join public.projects as materialized
        on materialized.id = case
          when lines.destination_type = 'EXISTING_PROJECT'
            then lines.destination_project_id
          when coalesce(lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
            then substring(lines.note from 30)::uuid
          else new_requests.materialized_project_id
        end
      where lines.request_id = requests.id
    ), '[]'::jsonb)
  from public.financial_budget_change_requests as requests
  join public.projects as source on source.id = requests.source_project_id
  where (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_region_id is null or requests.region_id = p_region_id)
    and (p_year is null or requests.fiscal_year = p_year)
    and (p_status is null or requests.status = p_status)
    and (p_project_id is null or requests.source_project_id = p_project_id
      or exists (
        select 1
        from public.financial_budget_change_request_lines as project_lines
        left join public.financial_new_project_requests as project_new_requests
          on project_new_requests.id = project_lines.new_project_request_id
        where project_lines.request_id = requests.id
          and (project_lines.destination_project_id = p_project_id
            or project_new_requests.materialized_project_id = p_project_id
            or (coalesce(project_lines.note, '') like 'REGISTERED_NEXT_YEAR_PROJECT:%'
              and substring(project_lines.note from 30)::uuid = p_project_id)))
      or exists (
        select 1 from public.financial_pending_new_project_funds as pending
        where pending.source_request_id = requests.id
          and pending.linked_project_id = p_project_id))
  order by requests.requested_at desc;
end;
$$;

create or replace function public.get_financial_budget_change_statistics(
  p_year integer default null,
  p_region_id uuid default null
)
returns table (
  transfer_amount bigint, transfer_count bigint,
  new_project_allocated_amount bigint, new_project_allocated_count bigint,
  pending_new_project_amount bigint, pending_new_project_count bigint,
  applied_request_count bigint, transaction_gap_amount bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' then
    if p_region_id is not null and p_region_id <> v_actor_region_id then
      raise exception using errcode = '42501', message =
        '다른 지역의 통계는 조회할 수 없습니다.';
    end if;
    p_region_id := v_actor_region_id;
  end if;
  return query
  with applied_lines as (
    select lines.*, requests.fiscal_year as request_year,
      requests.region_id as request_region_id
    from public.financial_budget_change_request_lines as lines
    join public.financial_budget_change_requests as requests
      on requests.id = lines.request_id
    where requests.status = 'APPLIED'
      and (p_year is null or requests.fiscal_year = p_year)
      and (p_region_id is null or requests.region_id = p_region_id)
  )
  select
    coalesce((select sum(amount)::bigint from applied_lines
      where destination_type = 'EXISTING_PROJECT'
        and materialized_transfer_id is not null), 0)::bigint,
    coalesce((select count(*)::bigint from applied_lines
      where destination_type = 'EXISTING_PROJECT'
        and materialized_transfer_id is not null), 0)::bigint,
    coalesce((select sum(lines.amount)::bigint from applied_lines as lines
      where lines.destination_type = 'PENDING_NEW_PROJECT'
        and lines.materialized_lot_id is not null
        and exists (select 1 from public.financial_unallocated_fund_movements as movements
          where movements.lot_id = lines.materialized_lot_id
            and movements.transaction_kind = 'NORMAL')), 0)::bigint,
    coalesce((select count(*)::bigint from applied_lines as lines
      where lines.destination_type = 'PENDING_NEW_PROJECT'
        and lines.materialized_lot_id is not null
        and exists (select 1 from public.financial_unallocated_fund_movements as movements
          where movements.lot_id = lines.materialized_lot_id
            and movements.transaction_kind = 'NORMAL')), 0)::bigint,
    coalesce((select sum(pending.amount)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (p_region_id is null or pending.region_id = p_region_id)), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (p_region_id is null or pending.region_id = p_region_id)), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_budget_change_requests as requests
      where requests.status = 'APPLIED'
        and (p_year is null or requests.fiscal_year = p_year)
        and (p_region_id is null or requests.region_id = p_region_id)), 0)::bigint,
    coalesce((select sum(requests.total_amount - coalesce(lines.total_amount, 0))::bigint
      from public.financial_budget_change_requests as requests
      left join lateral (select sum(amount)::bigint as total_amount
        from public.financial_budget_change_request_lines
        where request_id = requests.id) as lines on true
      where requests.status = 'APPLIED'
        and (p_year is null or requests.fiscal_year = p_year)
        and (p_region_id is null or requests.region_id = p_region_id)), 0)::bigint;
end;
$$;

create or replace function public.get_financial_budget_change_statistics_filtered(
  p_year integer default null,
  p_sido text default null,
  p_sigungu text default null
)
returns table (
  transfer_amount bigint, transfer_count bigint,
  new_project_allocated_amount bigint, new_project_allocated_count bigint,
  pending_new_project_amount bigint, pending_new_project_count bigint,
  applied_request_count bigint, transaction_gap_amount bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_region_ids uuid[];
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' then
    select array_agg(regions.id) into v_region_ids
    from public.regions
    where regions.id = v_actor_region_id
      and (p_sido is null or regions.sido = p_sido)
      and (p_sigungu is null or regions.sigungu = p_sigungu);
    v_region_ids := coalesce(v_region_ids, array[]::uuid[]);
  elsif p_sido is not null or p_sigungu is not null then
    select array_agg(regions.id) into v_region_ids
    from public.regions
    where (p_sido is null or regions.sido = p_sido)
      and (p_sigungu is null or regions.sigungu = p_sigungu);
    v_region_ids := coalesce(v_region_ids, array[]::uuid[]);
  else
    v_region_ids := null;
  end if;
  return query
  with applied_lines as (
    select lines.*, requests.fiscal_year as request_year,
      requests.region_id as request_region_id
    from public.financial_budget_change_request_lines as lines
    join public.financial_budget_change_requests as requests
      on requests.id = lines.request_id
    where requests.status = 'APPLIED'
      and (p_year is null or requests.fiscal_year = p_year)
      and (v_region_ids is null or requests.region_id = any(v_region_ids))
  )
  select
    coalesce((select sum(amount)::bigint from applied_lines
      where destination_type = 'EXISTING_PROJECT'
        and materialized_transfer_id is not null), 0)::bigint,
    coalesce((select count(*)::bigint from applied_lines
      where destination_type = 'EXISTING_PROJECT'
        and materialized_transfer_id is not null), 0)::bigint,
    coalesce((select sum(lines.amount)::bigint from applied_lines as lines
      where lines.destination_type = 'PENDING_NEW_PROJECT'
        and lines.materialized_lot_id is not null
        and exists (select 1 from public.financial_unallocated_fund_movements as movements
          where movements.lot_id = lines.materialized_lot_id
            and movements.transaction_kind = 'NORMAL')), 0)::bigint,
    coalesce((select count(*)::bigint from applied_lines as lines
      where lines.destination_type = 'PENDING_NEW_PROJECT'
        and lines.materialized_lot_id is not null
        and exists (select 1 from public.financial_unallocated_fund_movements as movements
          where movements.lot_id = lines.materialized_lot_id
            and movements.transaction_kind = 'NORMAL')), 0)::bigint,
    coalesce((select sum(pending.amount)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (v_region_ids is null or pending.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_pending_new_project_funds as pending
      where pending.status = 'WAITING'
        and (p_year is null or pending.planned_project_year = p_year)
        and (v_region_ids is null or pending.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select count(*)::bigint
      from public.financial_budget_change_requests as requests
      where requests.status = 'APPLIED'
        and (p_year is null or requests.fiscal_year = p_year)
        and (v_region_ids is null or requests.region_id = any(v_region_ids))), 0)::bigint,
    coalesce((select sum(requests.total_amount - coalesce(lines.total_amount, 0))::bigint
      from public.financial_budget_change_requests as requests
      left join lateral (select sum(amount)::bigint as total_amount
        from public.financial_budget_change_request_lines
        where request_id = requests.id) as lines on true
      where requests.status = 'APPLIED'
        and (p_year is null or requests.fiscal_year = p_year)
        and (v_region_ids is null or requests.region_id = any(v_region_ids))), 0)::bigint;
end;
$$;

revoke all on function public.financial_validate_budget_change_request(uuid)
  from public, anon, authenticated;
revoke all on function public.financial_capture_budget_change_amount_snapshots()
  from public, anon, authenticated;
revoke all on function public.financial_create_budget_change_request(
  uuid,jsonb,date,text,uuid,boolean
) from public, anon;
grant execute on function public.financial_create_budget_change_request(
  uuid,jsonb,date,text,uuid,boolean
) to authenticated;
revoke all on function public.financial_submit_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_submit_budget_change_request(uuid)
  to authenticated;
revoke all on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  from public, anon;
grant execute on function public.financial_approve_budget_change_request_group(uuid,jsonb)
  to authenticated;
revoke all on function public.financial_approve_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_approve_budget_change_request(uuid)
  to authenticated;
revoke all on function public.financial_reject_budget_change_request(uuid,text)
  from public, anon;
grant execute on function public.financial_reject_budget_change_request(uuid,text)
  to authenticated;
revoke all on function public.financial_apply_budget_change_request(uuid)
  from public, anon;
grant execute on function public.financial_apply_budget_change_request(uuid)
  to authenticated;
revoke all on function public.get_financial_budget_change_requests(uuid,text,integer,uuid)
  from public, anon;
grant execute on function public.get_financial_budget_change_requests(uuid,text,integer,uuid)
  to authenticated;
revoke all on function public.get_financial_budget_change_statistics(integer,uuid)
  from public, anon;
grant execute on function public.get_financial_budget_change_statistics(integer,uuid)
  to authenticated;
revoke all on function public.get_financial_budget_change_statistics_filtered(integer,text,text)
  from public, anon;
grant execute on function public.get_financial_budget_change_statistics_filtered(integer,text,text)
  to authenticated;

do $$
declare v_apply_definition text; v_request_definition text;
begin
  select lower(pg_get_functiondef(
    'public.financial_apply_budget_change_request(uuid)'::regprocedure))
    into v_apply_definition;
  select lower(pg_get_functiondef(
    'public.get_financial_budget_change_requests(uuid,text,integer,uuid)'::regprocedure))
    into v_request_definition;
  if position('financial_unallocated_fund_movements' in v_apply_definition) = 0
     or position('materialized_movement_id' in v_apply_definition) = 0
     or position('atomic_group_apply' in v_apply_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Generic budget-adjustment APPLY definition check failed.';
  end if;
  if position('new_project_request_id' in v_request_definition) = 0
     or position('materialized_project_id' in v_request_definition) = 0 then
    raise exception using errcode = '55000', message =
      'Generic budget-adjustment queue definition check failed.';
  end if;
  if exists (
    select 1
    from public.financial_budget_change_request_lines as lines
    join public.financial_new_project_requests as requests
      on requests.id = lines.new_project_request_id
    where requests.source_budget_change_request_id <> lines.request_id
       or requests.source_budget_change_line_id <> lines.id
       or requests.source_lot_id is not null
  ) then
    raise exception using errcode = '55000', message =
      'Grouped new-project ownership integrity check failed.';
  end if;
  if exists (
    select 1
    from public.financial_budget_workflow_amount_snapshots
    where adjusted_before <> original_before + increase_before - decrease_before
       or unexecuted_before <> adjusted_before - execution_before
       or adjusted_after <> original_after + increase_after - decrease_after
       or unexecuted_after <> adjusted_after - execution_after
  ) then
    raise exception using errcode = '55000', message =
      'Budget workflow amount snapshot formula check failed.';
  end if;
end;
$$;

commit;
