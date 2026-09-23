begin;

create temp table direct_validation_hotfix_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric as movement_amount;

do $patch$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.financial_complete_new_project_request(uuid)'::regprocedure
  ) into v_definition;
  if position('or v_request.large_category_id is null or v_request.middle_category_id is null' in v_definition) > 0 then
    v_definition := replace(
      v_definition,
      E'\n     or v_request.large_category_id is null or v_request.middle_category_id is null',
      ''
    );
    execute v_definition;
  end if;
  select pg_get_functiondef(
    'public.financial_complete_new_project_request(uuid)'::regprocedure
  ) into v_definition;
  if position('v_request.business_type not in' in v_definition) = 0
     or position('v_request.large_category_id is null' in v_definition) > 0 then
    raise exception using errcode = '55000', message =
      '기존 신규사업 제출 검증 규칙과 직접 처리 검증 규칙을 일치시키지 못했습니다.';
  end if;
end;
$patch$;

do $$
declare
  v_before direct_validation_hotfix_snapshot%rowtype;
  v_after direct_validation_hotfix_snapshot%rowtype;
begin
  select * into v_before from direct_validation_hotfix_snapshot;
  select
    (select count(*) from public.projects)::bigint,
    (select count(*) from public.financial_unallocated_fund_movements)::bigint,
    (select coalesce(sum(amount), 0) from public.financial_unallocated_fund_movements)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '검증 규칙 보정 중 사업 또는 원장 데이터가 변경되었습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
