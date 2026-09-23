-- Applied after 20260914000500. A completed new-project origin request is itself a
-- funding relationship and must block deletion even if a damaged legacy row shows zero amounts.

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton=true;
  if not found or v_runtime.environment_kind <> 'TEST' or v_runtime.mode <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.soft_delete_financial_new_project(text,uuid,text)') is null then
    raise exception using errcode='55000', message='확인된 TEST 신규사업 삭제 기반에서만 이 보강을 적용할 수 있습니다.';
  end if;
end;
$$;

do $patch$
declare v_definition text;
begin
  select pg_get_functiondef('public.get_financial_new_project_deletion_eligibility(text,uuid)'::regprocedure) into v_definition;
  v_definition := replace(v_definition,
    $$  else
    v_reason := public.financial_new_project_deletion_block_reason(v_project.id);
  end if;$$,
    $$  elsif v_request.materialized_movement_id is not null
     or v_request.source_lot_id is not null
     or v_request.source_budget_change_request_id is not null
     or v_request.source_budget_change_line_id is not null
     or coalesce(v_request.requested_amount, 0) <> 0 then
    v_reason := '신규사업 등록 시 재원 연결 또는 예산조정 이력이 있어 삭제할 수 없습니다.';
  else
    v_reason := public.financial_new_project_deletion_block_reason(v_project.id);
  end if;$$);
  if v_definition not like '%신규사업 등록 시 재원 연결 또는 예산조정 이력이 있어%' then
    raise exception using errcode='55000', message='삭제 자격 함수 보강 위치를 찾지 못했습니다.';
  end if;
  execute v_definition;

  select pg_get_functiondef('public.soft_delete_financial_new_project(text,uuid,text)'::regprocedure) into v_definition;
  v_definition := replace(v_definition,
    $$  if v_request.deleted_at is not null then
    raise exception using errcode = '23505', message = '이미 삭제된 신규사업입니다.';
  end if;
  v_reason := public.financial_new_project_deletion_block_reason(v_project.id);$$,
    $$  if v_request.deleted_at is not null then
    raise exception using errcode = '23505', message = '이미 삭제된 신규사업입니다.';
  end if;
  if v_request.materialized_movement_id is not null
     or v_request.source_lot_id is not null
     or v_request.source_budget_change_request_id is not null
     or v_request.source_budget_change_line_id is not null
     or coalesce(v_request.requested_amount, 0) <> 0 then
    raise exception using errcode = '23514', message =
      '신규사업 등록 시 재원 연결 또는 예산조정 이력이 있어 삭제할 수 없습니다.';
  end if;
  v_reason := public.financial_new_project_deletion_block_reason(v_project.id);$$);
  if v_definition not like '%신규사업 등록 시 재원 연결 또는 예산조정 이력이 있어%' then
    raise exception using errcode='55000', message='삭제 실행 함수 보강 위치를 찾지 못했습니다.';
  end if;
  execute v_definition;
end;
$patch$;

do $$
begin
  if pg_get_functiondef('public.get_financial_new_project_deletion_eligibility(text,uuid)'::regprocedure)
       not like '%v_request.source_lot_id is not null%'
     or pg_get_functiondef('public.soft_delete_financial_new_project(text,uuid,text)'::regprocedure)
       not like '%v_request.source_lot_id is not null%' then
    raise exception using errcode='55000', message='등록 시 재원 연결 이력 차단 보강이 적용되지 않았습니다.';
  end if;
end;
$$;
