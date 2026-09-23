begin;

do $$
declare v_runtime record;
begin
  select environment_kind, mode, bound_project_ref into v_runtime
  from public.financial_ledger_runtime where singleton=true;
  if v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx' then
    raise exception using errcode='55000', message='Approved TEST budget-adjustment runtime is required.';
  end if;
  if to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is null
     or to_regprocedure('public.financial_validate_budget_change_request(uuid)') is null then
    raise exception using errcode='55000', message='Generic budget-adjustment engine prerequisites are missing.';
  end if;
end;
$$;

create temporary table budget_adjustment_draft_upsert_snapshot on commit drop as
select
  (select count(*) from public.financial_budget_change_requests)::bigint request_count,
  (select count(*) from public.financial_budget_change_request_lines)::bigint line_count,
  (select count(*) from public.financial_new_project_requests)::bigint new_request_count,
  (select count(*) from public.projects)::bigint project_count,
  (select coalesce(sum(coalesce(alloc,0)),0) from public.projects)::numeric project_allocation,
  (select coalesce(sum(coalesce(exec,0)),0) from public.projects)::numeric project_execution,
  (select count(*) from public.project_fund_transfers)::bigint transfer_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint movement_count;

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
  where requests.id=p_request_id for update;
  if not found or v_request.status<>'DRAFT'
     or v_request.requested_by<>v_actor_id
     or (v_role='local_user' and v_request.region_id<>v_actor_region_id) then
    raise exception using errcode='42501', message='요청자만 작성 중인 예산조정을 제출할 수 있습니다.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_request.adjustment_fingerprint,0));
  if exists (
    select 1 from public.financial_budget_change_requests as requests
    where requests.id<>v_request.id
      and requests.adjustment_fingerprint=v_request.adjustment_fingerprint
      and requests.status in ('SUBMITTED','APPROVED','APPLIED')
      and requests.duplicate_of_request_id is null
  ) then
    raise exception using errcode='23505', message='동일 예산조정이 이미 승인 요청되었거나 적용되었습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  update public.financial_new_project_requests as new_requests
  set status='SUBMITTED', submitted_by=v_actor_id, submitted_at=clock_timestamp()
  where new_requests.source_budget_change_request_id=v_request.id
    and new_requests.status='DRAFT';
  update public.financial_budget_change_requests as requests
  set status='SUBMITTED', submitted_by=v_actor_id, submitted_at=clock_timestamp()
  where requests.id=v_request.id returning requests.* into v_request;
  perform public.financial_validate_budget_change_request(v_request.id);
  return query select v_request.id,v_request.status;
end;
$$;

create or replace function public.financial_test_uat_save_budget_change_request(
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
  v_actor_id uuid;
  v_bootstrap record;
  v_request public.financial_budget_change_requests%rowtype;
  v_source_budget_year_id uuid;
  v_source_revision bigint;
  v_total bigint:=0;
  v_fingerprint text;
  v_item jsonb;
  v_kind text;
  v_amount bigint;
  v_line_no integer:=0;
  v_line_id uuid;
  v_new_request_id uuid;
  v_new_fingerprint text;
  v_destination_key text;
  v_destination_keys text[]:=array[]::text[];
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  select actor.actor_id into v_actor_id
  from public.financial_require_actor() as actor;
  if p_source_project_id is null or p_idempotency_key is null or p_effective_date is null
     or char_length(btrim(coalesce(p_reason,''))) not between 1 and 1000
     or jsonb_typeof(p_destinations)<>'array'
     or jsonb_array_length(p_destinations) not between 1 and 20 then
    raise exception using errcode='22023', message='예산조정 작성값을 확인해 주세요.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select requests.* into v_request
  from public.financial_budget_change_requests as requests
  where requests.idempotency_key=p_idempotency_key for update;
  if not found then
    return query
    select created.request_id,created.status,created.gap_amount
    from public.financial_test_uat_create_budget_change_request(
      p_source_project_id,p_source_budget_year_id,p_destinations,p_effective_date,
      p_reason,p_idempotency_key,p_submit
    ) as created;
    return;
  end if;
  if v_request.requested_by<>v_actor_id then
    raise exception using errcode='42501', message='요청 식별키가 다른 사용자에게 속해 있습니다.';
  end if;
  if v_request.status<>'DRAFT' then
    raise exception using errcode='23505', message='이미 승인 요청된 예산조정입니다.';
  end if;
  if v_request.source_project_id<>p_source_project_id then
    raise exception using errcode='23514', message='작성 중인 예산조정의 출처 사업을 변경할 수 없습니다.';
  end if;
  select * into v_bootstrap
  from public.financial_test_uat_bootstrap_project(p_source_project_id);
  v_source_budget_year_id:=coalesce(p_source_budget_year_id,v_request.source_budget_year_id,
    v_bootstrap.source_budget_year_id);
  if v_source_budget_year_id is null or not exists (
    select 1 from public.project_budget_years as wallets
    where wallets.id=v_source_budget_year_id and wallets.project_id=p_source_project_id
  ) then
    raise exception using errcode='23514', message='출처 사업 재원을 확인해 주세요.';
  end if;

  for v_item in select value from jsonb_array_elements(p_destinations) loop
    v_kind:=v_item->>'destination_type';
    if coalesce(v_item->>'amount','') !~ '^[1-9][0-9]*$'
       or v_kind not in ('EXISTING_PROJECT','PENDING_NEW_PROJECT') then
      raise exception using errcode='22023', message='모든 목적지 금액은 0보다 큰 원 단위 정수여야 합니다.';
    end if;
    v_amount:=(v_item->>'amount')::bigint;
    v_total:=v_total+v_amount;
    if v_kind='EXISTING_PROJECT' then
      v_destination_key:='EXISTING:'||coalesce(v_item->>'destination_project_id','');
    elsif coalesce(v_item->>'note','') like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      v_destination_key:='REGISTERED:'||substring(v_item->>'note' from 30);
    else
      v_destination_key:='PLANNED:'||coalesce(v_item->>'planned_project_year','')||':'||
        lower(btrim(coalesce(v_item->>'planned_project_name','')));
    end if;
    if v_destination_key=any(v_destination_keys) then
      raise exception using errcode='23505', message='같은 목적지를 중복하여 선택할 수 없습니다.';
    end if;
    v_destination_keys:=array_append(v_destination_keys,v_destination_key);
  end loop;
  perform public.financial_require_available_amount(
    v_source_budget_year_id,v_total,'감액액이 현재 미집행액을 초과합니다.');
  v_source_revision:=public.financial_budget_change_visible_decrease(p_source_project_id);
  if v_request.source_adjustment_revision<>v_source_revision then
    raise exception using errcode='40001', message='출처 사업 금액이 변경되었습니다. 새로고침 후 다시 작성해 주세요.';
  end if;
  v_fingerprint:=public.financial_budget_change_adjustment_fingerprint(
    p_source_project_id,v_source_budget_year_id,v_source_revision,v_total,p_destinations,p_effective_date);
  perform pg_advisory_xact_lock(hashtextextended(v_fingerprint,0));
  if p_submit and exists (
    select 1 from public.financial_budget_change_requests as requests
    where requests.id<>v_request.id
      and requests.adjustment_fingerprint=v_fingerprint
      and requests.status in ('SUBMITTED','APPROVED','APPLIED')
      and requests.duplicate_of_request_id is null
  ) then
    raise exception using errcode='23505', message='동일 예산조정이 이미 승인 요청되었거나 적용되었습니다.';
  end if;
  if exists (
    select 1 from public.financial_new_project_requests as new_requests
    where new_requests.source_budget_change_request_id=v_request.id
      and (new_requests.status<>'DRAFT' or new_requests.materialized_project_id is not null)
  ) or exists (
    select 1 from public.financial_budget_change_request_lines as lines
    where lines.request_id=v_request.id
      and (lines.materialized_transfer_id is not null or lines.materialized_lot_id is not null
        or lines.pending_fund_id is not null)
  ) then
    raise exception using errcode='23514', message='물질화가 시작된 예산조정 작성본은 수정할 수 없습니다.';
  end if;

  update public.financial_budget_change_request_lines as lines
  set new_project_request_id=null where lines.request_id=v_request.id;
  delete from public.financial_new_project_requests as new_requests
  where new_requests.source_budget_change_request_id=v_request.id and new_requests.status='DRAFT';
  delete from public.financial_budget_change_request_lines as lines where lines.request_id=v_request.id;
  update public.financial_budget_change_requests as requests
  set source_budget_year_id=v_source_budget_year_id,total_amount=v_total,
      decrease_amount_before=v_source_revision,decrease_amount_after=v_source_revision+v_total,
      effective_date=p_effective_date,reason=btrim(p_reason),request_fingerprint=v_fingerprint,
      adjustment_fingerprint=v_fingerprint,source_adjustment_revision=v_source_revision,
      submitted_by=null,submitted_at=null
  where requests.id=v_request.id returning requests.* into v_request;

  for v_item in select value from jsonb_array_elements(p_destinations) loop
    v_line_no:=v_line_no+1;
    v_kind:=v_item->>'destination_type';
    insert into public.financial_budget_change_request_lines (
      request_id,line_no,destination_type,destination_project_id,
      planned_project_name,planned_project_year,amount,note,
      planned_fund_project_name,planned_detail_project_name,planned_project_period,
      planned_project_start_year,planned_project_end_year,planned_project_status,
      planned_business_type,planned_large_category_id,planned_middle_category_id
    ) values (
      v_request.id,v_line_no,v_kind,
      case when v_kind='EXISTING_PROJECT' then (v_item->>'destination_project_id')::uuid else null end,
      case when v_kind='PENDING_NEW_PROJECT' then btrim(v_item->>'planned_project_name') else null end,
      case when v_kind='PENDING_NEW_PROJECT' then (v_item->>'planned_project_year')::integer else null end,
      (v_item->>'amount')::bigint,nullif(btrim(coalesce(v_item->>'note','')),''),
      nullif(btrim(coalesce(v_item->>'planned_fund_project_name','')),''),
      nullif(btrim(coalesce(v_item->>'planned_detail_project_name','')),''),
      nullif(btrim(coalesce(v_item->>'planned_project_period','')),''),
      nullif(v_item->>'planned_project_start_year','')::integer,
      nullif(v_item->>'planned_project_end_year','')::integer,
      nullif(btrim(coalesce(v_item->>'planned_project_status','')),''),
      nullif(v_item->>'planned_business_type',''),
      nullif(v_item->>'planned_large_category_id','')::uuid,
      nullif(v_item->>'planned_middle_category_id','')::uuid
    ) returning id into v_line_id;
    if v_kind='PENDING_NEW_PROJECT'
       and coalesce(v_item->>'note','') not like 'REGISTERED_NEXT_YEAR_PROJECT:%' then
      v_new_request_id:=gen_random_uuid();
      v_new_fingerprint:=public.financial_request_fingerprint(jsonb_build_object(
        'budget_change_request_id',v_request.id,'budget_change_line_id',v_line_id,
        'project_name',btrim(v_item->>'planned_project_name'),
        'fiscal_year',(v_item->>'planned_project_year')::integer,
        'requested_amount',(v_item->>'amount')::bigint));
      insert into public.financial_new_project_requests (
        id,region_id,fiscal_year,project_name,fund_project_name,detail_project_name,
        project_period,project_start_year,project_end_year,project_status,business_type,
        large_category_id,middle_category_id,source_lot_id,requested_amount,status,
        idempotency_key,request_fingerprint,requested_by,requested_at,
        source_budget_change_request_id,source_budget_change_line_id
      ) values (
        v_new_request_id,v_request.region_id,(v_item->>'planned_project_year')::integer,
        btrim(v_item->>'planned_project_name'),
        nullif(btrim(coalesce(v_item->>'planned_fund_project_name','')),''),
        coalesce(nullif(btrim(coalesce(v_item->>'planned_detail_project_name','')),''),
          btrim(v_item->>'planned_project_name')),
        nullif(btrim(coalesce(v_item->>'planned_project_period','')),''),
        nullif(v_item->>'planned_project_start_year','')::integer,
        nullif(v_item->>'planned_project_end_year','')::integer,
        coalesce(nullif(btrim(coalesce(v_item->>'planned_project_status','')),''),'정상추진'),
        nullif(v_item->>'planned_business_type',''),
        nullif(v_item->>'planned_large_category_id','')::uuid,
        nullif(v_item->>'planned_middle_category_id','')::uuid,
        null,(v_item->>'amount')::bigint,'DRAFT',gen_random_uuid(),v_new_fingerprint,
        v_actor_id,clock_timestamp(),v_request.id,v_line_id
      );
      update public.financial_budget_change_request_lines as lines
      set new_project_request_id=v_new_request_id where lines.id=v_line_id;
    end if;
  end loop;
  perform public.financial_validate_budget_change_request(v_request.id);
  if p_submit then
    return query select submitted.request_id,submitted.status,0::bigint
    from public.financial_submit_budget_change_request(v_request.id) as submitted;
    return;
  end if;
  perform public.financial_write_audit(
    v_request.source_project_id,v_request.region_id,'BUDGET_REALLOCATION_DRAFTED',
    'financial_budget_change_requests',v_request.id,v_actor_id,
    jsonb_build_object('amount',v_total,'destination_count',v_line_no,'gap_amount',0,
      'grouped_new_project_count',(select count(*) from public.financial_budget_change_request_lines as lines
        where lines.request_id=v_request.id and lines.new_project_request_id is not null)));
  return query select v_request.id,v_request.status,0::bigint;
exception
  when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed then
    raise exception using errcode='22023', message='사업 또는 금액 입력값을 확인해 주세요.';
end;
$$;

revoke all on function public.financial_test_uat_save_budget_change_request(
  uuid,uuid,jsonb,date,text,uuid,boolean
) from public,anon;
grant execute on function public.financial_test_uat_save_budget_change_request(
  uuid,uuid,jsonb,date,text,uuid,boolean
) to authenticated;
revoke all on function public.financial_submit_budget_change_request(uuid) from public,anon;
grant execute on function public.financial_submit_budget_change_request(uuid) to authenticated;

do $$
declare
  v_before budget_adjustment_draft_upsert_snapshot%rowtype;
  v_after budget_adjustment_draft_upsert_snapshot%rowtype;
  v_save text;
  v_submit text;
begin
  select * into v_before from budget_adjustment_draft_upsert_snapshot;
  select
    (select count(*) from public.financial_budget_change_requests)::bigint,
    (select count(*) from public.financial_budget_change_request_lines)::bigint,
    (select count(*) from public.financial_new_project_requests)::bigint,
    (select count(*) from public.projects)::bigint,
    (select coalesce(sum(coalesce(alloc,0)),0) from public.projects)::numeric,
    (select coalesce(sum(coalesce(exec,0)),0) from public.projects)::numeric,
    (select count(*) from public.project_fund_transfers)::bigint,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode='55000', message='Draft upsert migration changed TEST business rows.';
  end if;
  select lower(pg_get_functiondef(
    'public.financial_test_uat_save_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure))
    into v_save;
  select lower(pg_get_functiondef('public.financial_submit_budget_change_request(uuid)'::regprocedure))
    into v_submit;
  if position('status=''draft''' in v_save)=0
     or position('source_budget_change_request_id' in v_save)=0
     or position('financial_validate_budget_change_request' in v_save)=0
     or position('new_requests.status=''draft''' in v_submit)=0 then
    raise exception using errcode='55000', message='Draft upsert definition verification failed.';
  end if;
end;
$$;

commit;
