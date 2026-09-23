-- Budget-change draft editing historically rebuilt generated new-project
-- drafts by physically deleting them.  New-project soft-delete guards correctly
-- prohibit that operation.  Preserve the generated draft and its audit trail by
-- soft-deleting it before the editable budget-change lines are rebuilt.

create or replace function public.financial_soft_delete_budget_change_generated_drafts(
  p_parent_request_id uuid,
  p_actor_id uuid,
  p_only_request_id uuid default null,
  p_reason text default '예산조정 작성본 재저장으로 교체된 내부 신규사업 초안'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.financial_new_project_requests%rowtype;
  v_event_id uuid;
  v_count integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  if p_parent_request_id is null or p_actor_id is null then
    raise exception using errcode = '22023', message = '예산조정 내부 초안 삭제 대상을 확인해 주세요.';
  end if;

  for v_request in
    select requests.*
    from public.financial_new_project_requests as requests
    where requests.source_budget_change_request_id = p_parent_request_id
      and (p_only_request_id is null or requests.id = p_only_request_id)
      and requests.linked_from_standalone = false
      and requests.status = 'DRAFT'
      and requests.materialized_project_id is null
      and requests.materialized_movement_id is null
      and requests.deleted_at is null
    order by requests.id
    for update
  loop
    insert into public.project_deletion_events (
      target_kind, target_id, request_id, project_id, region_id,
      project_name, fiscal_year, reason, deleted_by, deleted_at
    ) values (
      'DRAFT', v_request.id, v_request.id, null, v_request.region_id,
      coalesce(
        nullif(btrim(v_request.detail_project_name), ''),
        nullif(btrim(v_request.fund_project_name), ''),
        nullif(btrim(v_request.project_name), ''),
        '사업명 확인 필요'
      ),
      v_request.fiscal_year,
      left(btrim(p_reason), 500),
      p_actor_id,
      v_now
    )
    returning id into v_event_id;

    update public.financial_new_project_requests as requests
    set deleted_at = v_now,
        deleted_by = p_actor_id,
        deletion_event_id = v_event_id,
        source_budget_change_request_id = null,
        source_budget_change_line_id = null
    where requests.id = v_request.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.financial_soft_delete_budget_change_generated_drafts(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.financial_soft_delete_budget_change_generated_drafts(uuid, uuid, uuid, text)
  to service_role;

do $$
declare
  v_definition text;
  v_patched text;
begin
  v_definition := pg_get_functiondef(
    'public.financial_test_uat_save_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure
  );
  v_patched := replace(
    v_definition,
    $old$  delete from public.financial_new_project_requests as new_requests
  where new_requests.source_budget_change_request_id=v_request.id and new_requests.status='DRAFT';$old$,
    $new$  perform public.financial_soft_delete_budget_change_generated_drafts(
    v_request.id, v_actor_id, null,
    '예산조정 작성본 재저장으로 교체된 내부 신규사업 초안'
  );$new$
  );
  if v_patched = v_definition then
    raise exception using errcode = '55000', message =
      '기본 예산조정 저장 함수에서 물리 삭제 구문을 찾지 못했습니다.';
  end if;
  execute v_patched;

  v_definition := pg_get_functiondef(
    'public.financial_test_uat_save_budget_change_request_with_drafts(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure
  );
  v_patched := replace(
    v_definition,
    $old$    delete from public.financial_new_project_requests as requests
    where requests.id = v_generated_id
      and requests.source_budget_change_request_id = v_parent.id
      and requests.source_budget_change_line_id = v_line.id
      and requests.linked_from_standalone = false
      and requests.status = 'DRAFT';$old$,
    $new$    perform public.financial_soft_delete_budget_change_generated_drafts(
      v_parent.id, v_actor_id, v_generated_id,
      '독립 신규사업 초안 연결로 교체된 내부 신규사업 초안'
    );$new$
  );
  if v_patched = v_definition then
    raise exception using errcode = '55000', message =
      '독립 초안 연결 함수에서 물리 삭제 구문을 찾지 못했습니다.';
  end if;
  execute v_patched;
end;
$$;

notify pgrst, 'reload schema';
