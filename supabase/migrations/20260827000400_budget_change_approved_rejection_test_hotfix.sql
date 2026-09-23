-- TEST-only workflow correction: an approved request that has not been
-- applied must still be cancellable through the authenticated admin RPC.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or v_runtime.mode <> 'TEST'
     or to_regclass('public.financial_test_uat_project_bootstraps') is null
     or to_regprocedure('public.financial_reject_budget_change_request(uuid,text)') is null then
    raise exception using errcode = '55000', message =
      'Approved-request rejection hotfix requires the approved TEST UAT workflow.';
  end if;
end;
$$;

create or replace function public.financial_reject_budget_change_request(
  p_request_id uuid,
  p_reason text
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_budget_change_requests%rowtype;
begin
  perform public.financial_require_test_uat_bootstrap_runtime();
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '반려 사유를 입력해 주세요.';
  end if;
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found or v_request.status not in ('SUBMITTED', 'APPROVED')
     or v_request.requested_by = v_actor_id
     or exists (select 1 from public.financial_budget_change_request_lines as lines
       where lines.request_id = v_request.id
         and (lines.materialized_transfer_id is not null
           or lines.materialized_lot_id is not null
           or lines.pending_fund_id is not null)) then
    raise exception using errcode = '42501', message =
      '적용 전인 제출·승인 예산 조정만 요청자와 다른 관리자가 반려할 수 있습니다.';
  end if;
  update public.financial_budget_change_requests
  set status = 'REJECTED', rejected_by = v_actor_id,
      rejected_at = clock_timestamp(), rejection_reason = btrim(p_reason)
  where id = v_request.id returning * into v_request;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_REJECTED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('reason', v_request.rejection_reason,
      'previous_status', case when v_request.approved_by is null then 'SUBMITTED' else 'APPROVED' end)
  );
  return query select v_request.id, v_request.status;
end;
$$;

revoke all on function public.financial_reject_budget_change_request(uuid,text)
  from public, anon;
grant execute on function public.financial_reject_budget_change_request(uuid,text)
  to authenticated;

commit;
