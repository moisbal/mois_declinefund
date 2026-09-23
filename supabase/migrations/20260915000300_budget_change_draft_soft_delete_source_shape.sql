-- Follow-up for TEST environments where 20260915000200 was already applied.
-- The source-shape constraint requires the parent request and line references
-- to be cleared together when an internal generated draft is retired.

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

notify pgrst, 'reload schema';

