-- TEST-only hotfix: qualify request-line columns inside the APPLY output scope.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime from public.financial_ledger_runtime where singleton = true;
  if not found or v_runtime.environment_kind <> 'TEST'
     or v_runtime.bound_project_ref <> 'reviewtestxxxxxxxxxx'
     or to_regprocedure('public.financial_apply_budget_change_request(uuid)') is null then
    raise exception using errcode = '55000', message =
      'Budget-change APPLY hotfix requires the approved TEST base delta.';
  end if;
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
  v_source_wallet public.project_budget_years%rowtype;
  v_destination_budget_year_id uuid;
  v_destination_region uuid;
  v_destination_year integer;
  v_transfer_id uuid;
  v_lot_id uuid;
  v_pending_id uuid;
  v_classification_before bigint;
  v_classification_after bigint;
  v_line_key uuid;
  v_line_fingerprint text;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_budget_change_requests
  where id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '예산 조정 요청을 찾을 수 없습니다.';
  end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.id, v_request.status, 0::bigint;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = '승인된 예산 조정만 요청자와 다른 관리자가 적용할 수 있습니다.';
  end if;
  perform public.financial_validate_budget_change_request(v_request.id);
  perform public.financial_assert_funding_origin_evidence(
    v_request.region_id, 'SYSTEM_NATIVE', v_request.effective_date, null
  );
  select * into v_source_wallet from public.project_budget_years
  where id = v_request.source_budget_year_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '출처 사업 재원을 찾을 수 없습니다.';
  end if;
  perform public.financial_require_available_amount(
    v_source_wallet.id, v_request.total_amount, '감액액이 현재 미집행액을 초과합니다.'
  );
  select coalesce(sum(classification_effect), 0)::bigint
    into v_classification_before
  from public.financial_project_decrease_classification_effects
  where source_project_id = v_request.source_project_id;
  perform 1 from public.financial_assert_decrease_delta_position(
    v_source_wallet.id, v_classification_before,
    v_classification_before + v_request.total_amount,
    v_request.total_amount, false
  );
  perform public.financial_assert_project_baseline_ready(
    v_request.source_project_id, -v_request.total_amount, 0,
    v_request.total_amount, 'SYSTEM_NATIVE', false
  );

  v_classification_after := v_classification_before;
  for v_line in
    select request_lines.* from public.financial_budget_change_request_lines as request_lines
    where request_lines.request_id = v_request.id
    order by request_lines.line_no for update of request_lines
  loop
    v_line_key := gen_random_uuid();
    v_line_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
      'request_id', v_request.id, 'line_id', v_line.id,
      'destination_type', v_line.destination_type, 'amount', v_line.amount
    ));
    if v_line.destination_type = 'EXISTING_PROJECT' then
      select region_id, year into v_destination_region, v_destination_year
      from public.projects where id = v_line.destination_project_id;
      if not found or v_destination_region <> v_request.region_id
         or v_destination_year > v_request.fiscal_year
         or v_line.destination_project_id = v_request.source_project_id then
        raise exception using errcode = '23514', message = '목적지 사업의 지역 또는 연도가 변경되었습니다.';
      end if;
      perform public.financial_assert_project_baseline_ready(
        v_line.destination_project_id, v_line.amount, 0, 0, 'SYSTEM_NATIVE', false
      );
      v_destination_budget_year_id := public.financial_get_or_create_budget_year(
        v_line.destination_project_id, v_source_wallet.budget_cohort_id,
        v_source_wallet.fiscal_year, v_actor_id
      );
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
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        outcome_type, amount, decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, transfer_id, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year, v_source_wallet.budget_cohort_id,
        v_request.source_project_id, v_source_wallet.id, 'EXISTING_PROJECT_TRANSFER',
        v_line.amount, v_classification_after, v_classification_after + v_line.amount,
        'project_fund_transfers', v_transfer_id, v_transfer_id, 'SYSTEM_NATIVE', null,
        gen_random_uuid(), v_line_fingerprint, v_request.requested_by
      );
      update public.financial_budget_change_request_lines
      set materialized_transfer_id = v_transfer_id
      where id = v_line.id;
    else
      insert into public.financial_unallocated_fund_lots (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        original_amount, reason, effective_date, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by, confirmed_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year, v_source_wallet.budget_cohort_id,
        v_request.source_project_id, v_source_wallet.id, v_line.amount,
        '신규사업 예정 · ' || v_line.planned_project_name,
        v_request.effective_date, 'SYSTEM_NATIVE', null, v_line_key,
        v_line_fingerprint, v_request.requested_by, v_actor_id
      ) returning id into v_lot_id;
      insert into public.financial_project_decrease_classifications (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        outcome_type, amount, decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, lot_id, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year, v_source_wallet.budget_cohort_id,
        v_request.source_project_id, v_source_wallet.id, 'UNALLOCATED_LOT',
        v_line.amount, v_classification_after, v_classification_after + v_line.amount,
        'financial_unallocated_fund_lots', v_lot_id, v_lot_id, 'SYSTEM_NATIVE', null,
        gen_random_uuid(), v_line_fingerprint, v_request.requested_by
      );
      insert into public.financial_pending_new_project_funds (
        region_id, fiscal_year, planned_project_name, planned_project_year,
        amount, lot_id, source_request_id, source_line_id, created_by
      ) values (
        v_request.region_id, v_source_wallet.fiscal_year,
        v_line.planned_project_name, v_line.planned_project_year,
        v_line.amount, v_lot_id, v_request.id, v_line.id, v_request.requested_by
      ) returning id into v_pending_id;
      update public.financial_budget_change_request_lines
      set materialized_lot_id = v_lot_id, pending_fund_id = v_pending_id
      where id = v_line.id;
    end if;
    v_classification_after := v_classification_after + v_line.amount;
  end loop;
  if v_classification_after - v_classification_before <> v_request.total_amount then
    raise exception using errcode = '23514', message = '예산 조정 적용 차액이 0원이 아닙니다.';
  end if;
  update public.financial_budget_change_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  perform public.financial_write_audit(
    v_request.source_project_id, v_request.region_id,
    'BUDGET_REALLOCATION_APPLIED', 'financial_budget_change_requests',
    v_request.id, v_actor_id,
    jsonb_build_object('amount', v_request.total_amount, 'gap_amount', 0)
  );
  return query select v_request.id, v_request.status, 0::bigint;
end;
$$;

revoke all on function public.financial_apply_budget_change_request(uuid) from public, anon;
grant execute on function public.financial_apply_budget_change_request(uuid) to authenticated;

commit;
