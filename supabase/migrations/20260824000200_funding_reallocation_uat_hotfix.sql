-- TEST-discovered follow-up for 20260824000100_funding_reallocation_delta.sql.
--
-- UAT scenario 2 proved that the OUT parameter named `status` in
-- financial_apply_funding_reallocation_request() conflicts with unqualified
-- status columns in the linked-reversal/classification branches. The canonical
-- migration is fixed in place for future environments; this transactional
-- follow-up safely rewrites only the already-deployed function on TEST.

begin;

do $$
declare v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true;
  if not found
     or v_runtime.environment_kind <> 'TEST'
     or v_runtime.mode <> 'RECONCILIATION'
     or v_runtime.bound_project_ref is null
     or v_runtime.baseline_as_of <> date '2026-08-31'
     or v_runtime.native_start_date <> date '2026-09-01' then
    raise exception using errcode = '55000', message =
      'Funding UAT hotfix is restricted to the approved TEST/RECONCILIATION runtime.';
  end if;
  if to_regprocedure(
    'public.financial_apply_funding_reallocation_request(uuid)'
  ) is null then
    raise exception using errcode = '55000', message =
      'Funding reallocation APPLY function is missing.';
  end if;
end
$$;

create temporary table funding_reallocation_uat_hotfix_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)::numeric
    as project_alloc_total,
  (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)::numeric
    as project_exec_total,
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select count(*) from public.project_budget_adjustments)::bigint as adjustment_count,
  (select count(*) from public.financial_unallocated_fund_lots)::bigint as lot_count,
  (select count(*) from public.financial_unallocated_fund_movements)::bigint as movement_count,
  (select count(*) from public.financial_project_decrease_classifications)::bigint
    as classification_count,
  (select count(*) from public.financial_project_decrease_classification_reversals)::bigint
    as classification_reversal_count,
  (select count(*) from public.financial_funding_reallocation_requests)::bigint
    as funding_request_count,
  (select count(*) from public.financial_new_project_requests)::bigint
    as new_project_request_count,
  (select jsonb_agg(to_jsonb(runtime) order by runtime.singleton)
    from public.financial_ledger_runtime as runtime) as runtime_rows;

create or replace function public.financial_apply_funding_reallocation_request(p_request_id uuid)
returns table (
  request_id uuid,
  status text,
  materialized_table text,
  materialized_record_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_funding_reallocation_requests%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_movement public.financial_unallocated_fund_movements%rowtype;
  v_original_movement public.financial_unallocated_fund_movements%rowtype;
  v_transfer public.project_fund_transfers%rowtype;
  v_adjustment public.project_budget_adjustments%rowtype;
  v_classification public.financial_project_decrease_classifications%rowtype;
  v_source_budget_year_id uuid;
  v_destination_project_id uuid;
  v_destination_budget_year_id uuid;
  v_region_id uuid;
  v_fiscal_year integer;
  v_budget_cohort_id uuid;
  v_source_project_id uuid;
  v_destination_region_id uuid;
  v_destination_year integer;
  v_amount bigint;
  v_before bigint;
  v_after bigint;
  v_remaining bigint;
  v_reversed bigint;
  v_record_origin text;
  v_evidence_id uuid;
  v_effective_date date;
  v_memo text;
  v_materialized_table text;
  v_materialized_record_id uuid;
  v_classification_id uuid;
  v_classification_reversal_id uuid;
  v_is_correction boolean;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_funding_reallocation_requests
  where id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Funding request was not found.';
  end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.id, v_request.status,
      v_request.materialized_table, v_request.materialized_record_id;
    return;
  end if;
  if v_request.status <> 'APPROVED' then
    raise exception using errcode = '23514', message = 'Only an APPROVED funding request can be applied.';
  end if;
  if v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Requester cannot apply their own funding request.';
  end if;
  v_region_id := public.financial_validate_funding_reallocation_payload(
    v_request.request_type, v_request.payload
  );
  if v_region_id <> v_request.region_id then
    raise exception using errcode = '23514', message = 'Funding request region changed before apply.';
  end if;

  if v_request.request_type = 'CREATE_UNALLOCATED_LOT' then
    v_source_budget_year_id := (v_request.payload ->> 'source_budget_year_id')::uuid;
    v_amount := (v_request.payload ->> 'amount')::bigint;
    v_before := (v_request.payload ->> 'decrease_amount_before')::bigint;
    v_after := (v_request.payload ->> 'decrease_amount_after')::bigint;
    v_record_origin := v_request.payload ->> 'record_origin';
    v_evidence_id := nullif(v_request.payload ->> 'evidence_id', '')::uuid;
    v_effective_date := (v_request.payload ->> 'effective_date')::date;

    select position.region_id, position.fiscal_year, position.budget_cohort_id,
      position.source_project_id
      into v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id
    from public.financial_assert_decrease_delta_position(
      v_source_budget_year_id, v_before, v_after, v_amount, false
    ) as position;
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, -v_amount, 0, v_amount, v_record_origin, false
    );
    perform 1 from public.project_budget_years where id = v_source_budget_year_id for update;
    perform public.financial_assert_funding_origin_evidence(
      v_region_id, v_record_origin, v_effective_date, v_evidence_id
    );
    perform public.financial_require_available_amount(
      v_source_budget_year_id, v_amount, 'Decrease delta exceeds source-wallet available funds.'
    );

    insert into public.financial_unallocated_fund_lots (
      region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
      original_amount, reason, effective_date, record_origin, evidence_id,
      idempotency_key, request_fingerprint, created_by, confirmed_by
    ) values (
      v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id,
      v_source_budget_year_id, v_amount, btrim(v_request.payload ->> 'reason'),
      v_effective_date, v_record_origin, v_evidence_id,
      v_request.idempotency_key, v_request.request_fingerprint, v_request.requested_by, v_actor_id
    ) returning * into v_lot;

    insert into public.financial_project_decrease_classifications (
      region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
      outcome_type, amount, decrease_amount_before, decrease_amount_after,
      canonical_table, canonical_record_id, lot_id, record_origin, evidence_id,
      idempotency_key, request_fingerprint, created_by
    ) values (
      v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id,
      v_source_budget_year_id, 'UNALLOCATED_LOT', v_amount, v_before, v_after,
      'financial_unallocated_fund_lots', v_lot.id, v_lot.id,
      v_record_origin, v_evidence_id, v_request.idempotency_key,
      v_request.request_fingerprint, v_request.requested_by
    ) returning id into v_classification_id;
    v_materialized_table := 'financial_unallocated_fund_lots';
    v_materialized_record_id := v_lot.id;
    perform public.financial_write_audit(v_source_project_id, v_region_id,
      'UNALLOCATED_FUND_LOT_CONFIRMED', v_materialized_table, v_lot.id, v_actor_id,
      jsonb_build_object('amount', v_amount, 'classification_id', v_classification_id,
        'decrease_amount_before', v_before, 'decrease_amount_after', v_after,
        'budget_cohort_id', v_budget_cohort_id));

  elsif v_request.request_type in ('ALLOCATE_UNALLOCATED_EXISTING', 'RETURN_UNALLOCATED') then
    select * into v_lot from public.financial_unallocated_fund_lots
    where id = (v_request.payload ->> 'lot_id')::uuid;
    if not found then raise exception using errcode = 'P0002', message = 'Waiting-fund lot was not found.'; end if;
    v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot.id);
    v_amount := (v_request.payload ->> 'amount')::bigint;
    if v_amount > v_remaining then
      raise exception using errcode = '23514', message = 'Allocation/return exceeds locked waiting-fund balance.';
    end if;
    v_record_origin := v_request.payload ->> 'record_origin';
    v_evidence_id := nullif(v_request.payload ->> 'evidence_id', '')::uuid;
    v_effective_date := (v_request.payload ->> 'effective_date')::date;
    v_memo := nullif(btrim(v_request.payload ->> 'memo'), '');
    if v_record_origin <> v_lot.record_origin then
      raise exception using errcode = '23514', message = 'A waiting-fund movement cannot change record_origin.';
    end if;
    perform public.financial_assert_funding_origin_evidence(
      v_lot.region_id, v_record_origin, v_effective_date, v_evidence_id
    );

    if v_request.request_type = 'ALLOCATE_UNALLOCATED_EXISTING' then
      v_destination_project_id := (v_request.payload ->> 'destination_project_id')::uuid;
      select region_id, year into v_destination_region_id, v_destination_year
      from public.projects
      where id = v_destination_project_id and project_code is not null;
      if v_destination_region_id is null or v_destination_region_id <> v_lot.region_id
         or v_destination_year is distinct from v_lot.fiscal_year then
        raise exception using errcode = '23514', message =
          'Waiting funds may be allocated only to an existing same-region, same-year project.';
      end if;
      perform public.financial_assert_project_baseline_ready(
        v_destination_project_id, v_amount, 0, 0, v_record_origin, false
      );
      v_destination_budget_year_id := public.financial_get_or_create_budget_year(
        v_destination_project_id, v_lot.budget_cohort_id, v_lot.fiscal_year, v_actor_id
      );
      insert into public.financial_unallocated_fund_movements (
        lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
        destination_project_id, destination_budget_year_id, amount,
        effective_date, record_origin, evidence_id, memo,
        idempotency_key, request_fingerprint, created_by, confirmed_by
      ) values (
        v_lot.id, v_lot.region_id, v_lot.budget_cohort_id,
        'ALLOCATE_EXISTING_PROJECT', 'NORMAL', v_destination_project_id,
        v_destination_budget_year_id, v_amount, v_effective_date, v_record_origin,
        v_evidence_id, v_memo, v_request.idempotency_key, v_request.request_fingerprint,
        v_request.requested_by, v_actor_id
      ) returning * into v_movement;
    else
      -- Pool RETURN is canonical here. Do not create a project adjustment too.
      insert into public.financial_unallocated_fund_movements (
        lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
        amount, effective_date, record_origin, evidence_id, memo,
        idempotency_key, request_fingerprint, created_by, confirmed_by
      ) values (
        v_lot.id, v_lot.region_id, v_lot.budget_cohort_id, 'RETURN', 'NORMAL',
        v_amount, v_effective_date, v_record_origin, v_evidence_id, v_memo,
        v_request.idempotency_key, v_request.request_fingerprint,
        v_request.requested_by, v_actor_id
      ) returning * into v_movement;
    end if;
    v_materialized_table := 'financial_unallocated_fund_movements';
    v_materialized_record_id := v_movement.id;
    perform public.financial_write_audit(v_lot.source_project_id, v_lot.region_id,
      case when v_movement.movement_type = 'RETURN'
        then 'UNALLOCATED_FUND_RETURNED' else 'UNALLOCATED_FUND_ALLOCATED' end,
      v_materialized_table, v_movement.id, v_actor_id,
      jsonb_build_object('lot_id', v_lot.id, 'amount', v_amount,
        'remaining_amount', v_remaining - v_amount,
        'destination_project_id', v_destination_project_id));

  elsif v_request.request_type = 'REVERSE_UNALLOCATED_MOVEMENT' then
    select * into v_original_movement
    from public.financial_unallocated_fund_movements
    where id = (v_request.payload ->> 'original_movement_id')::uuid
      and transaction_kind = 'NORMAL';
    if not found then raise exception using errcode = 'P0002', message = 'Normal waiting-fund movement was not found.'; end if;
    if v_original_movement.movement_type = 'RESTORE_SOURCE' then
      raise exception using errcode = '23514', message =
        'A linked decrease restoration cannot be reversed outside its classification chain.';
    end if;
    v_remaining := public.financial_lock_unallocated_lot_remaining(v_original_movement.lot_id);
    select * into v_lot from public.financial_unallocated_fund_lots
    where id = v_original_movement.lot_id;
    v_amount := (v_request.payload ->> 'amount')::bigint;
    select coalesce(sum(amount), 0)::bigint into v_reversed
    from public.financial_unallocated_fund_movements
    where reversal_of = v_original_movement.id and transaction_kind = 'REVERSAL';
    if v_amount > v_original_movement.amount - v_reversed then
      raise exception using errcode = '23514', message = 'Movement reversal exceeds unreversed amount.';
    end if;
    v_record_origin := v_request.payload ->> 'record_origin';
    v_evidence_id := nullif(v_request.payload ->> 'evidence_id', '')::uuid;
    v_effective_date := (v_request.payload ->> 'effective_date')::date;
    v_memo := nullif(btrim(v_request.payload ->> 'memo'), '');
    if v_record_origin <> v_lot.record_origin then
      raise exception using errcode = '23514', message = 'A movement reversal cannot change record_origin.';
    end if;
    perform public.financial_assert_funding_origin_evidence(
      v_lot.region_id, v_record_origin, v_effective_date, v_evidence_id
    );
    if v_original_movement.destination_budget_year_id is not null then
      perform 1 from public.project_budget_years
      where id = v_original_movement.destination_budget_year_id for update;
      perform public.financial_require_available_amount(
        v_original_movement.destination_budget_year_id, v_amount,
        'Destination wallet lacks funds required for allocation reversal.'
      );
    end if;
    insert into public.financial_unallocated_fund_movements (
      lot_id, region_id, budget_cohort_id, movement_type, transaction_kind, reversal_of,
      destination_project_id, destination_budget_year_id, new_project_request_id,
      amount, effective_date, record_origin, evidence_id, memo,
      idempotency_key, request_fingerprint, created_by, confirmed_by
    ) values (
      v_original_movement.lot_id, v_original_movement.region_id,
      v_original_movement.budget_cohort_id, v_original_movement.movement_type,
      'REVERSAL', v_original_movement.id, v_original_movement.destination_project_id,
      v_original_movement.destination_budget_year_id, v_original_movement.new_project_request_id,
      v_amount, v_effective_date, v_record_origin, v_evidence_id, v_memo,
      v_request.idempotency_key, v_request.request_fingerprint,
      v_request.requested_by, v_actor_id
    ) returning * into v_movement;
    v_materialized_table := 'financial_unallocated_fund_movements';
    v_materialized_record_id := v_movement.id;

  elsif v_request.request_type = 'REVERSE_DECREASE_CLASSIFICATION' then
    select * into v_classification
    from public.financial_project_decrease_classifications
    where id = (v_request.payload ->> 'classification_id')::uuid
    for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'Decrease classification was not found.';
    end if;
    v_amount := (v_request.payload ->> 'amount')::bigint;
    v_before := (v_request.payload ->> 'decrease_amount_before')::bigint;
    v_after := (v_request.payload ->> 'decrease_amount_after')::bigint;
    v_record_origin := v_request.payload ->> 'record_origin';
    v_evidence_id := nullif(v_request.payload ->> 'evidence_id', '')::uuid;
    v_effective_date := (v_request.payload ->> 'effective_date')::date;
    v_memo := nullif(btrim(v_request.payload ->> 'memo'), '');
    if v_classification.region_id <> v_request.region_id
       or v_record_origin <> v_classification.record_origin then
      raise exception using errcode = '23514', message =
        'Decrease reversal must preserve classification region and record_origin.';
    end if;
    perform public.financial_assert_decrease_delta_position(
      v_classification.source_budget_year_id, v_before, v_after, v_amount, true
    );
    select coalesce(sum(amount), 0)::bigint into v_reversed
    from public.financial_project_decrease_classification_reversals
    where classification_id = v_classification.id;
    if v_amount > v_classification.amount - v_reversed then
      raise exception using errcode = '23514', message =
        'Decrease reversal exceeds the classification unreversed amount.';
    end if;
    perform public.financial_assert_funding_origin_evidence(
      v_classification.region_id, v_record_origin, v_effective_date, v_evidence_id
    );
    perform public.financial_assert_project_baseline_ready(
      v_classification.source_project_id, v_amount, 0, -v_amount, v_record_origin, false
    );

    if v_classification.outcome_type = 'UNALLOCATED_LOT' then
      select * into v_lot from public.financial_unallocated_fund_lots
      where id = v_classification.lot_id;
      v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot.id);
      if v_amount > v_remaining then
        raise exception using errcode = '23514', message =
          'Only the still-waiting lot balance can be restored to its source wallet.';
      end if;
      insert into public.financial_unallocated_fund_movements (
        lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
        destination_project_id, destination_budget_year_id, amount,
        effective_date, record_origin, evidence_id, memo,
        idempotency_key, request_fingerprint, created_by, confirmed_by
      ) values (
        v_lot.id, v_lot.region_id, v_lot.budget_cohort_id, 'RESTORE_SOURCE', 'NORMAL',
        v_lot.source_project_id, v_lot.source_budget_year_id, v_amount,
        v_effective_date, v_record_origin, v_evidence_id, v_memo,
        v_request.idempotency_key, v_request.request_fingerprint,
        v_request.requested_by, v_actor_id
      ) returning * into v_movement;
      v_materialized_table := 'financial_unallocated_fund_movements';
      v_materialized_record_id := v_movement.id;
    elsif v_classification.outcome_type = 'EXISTING_PROJECT_TRANSFER' then
      select transfers.* into v_transfer from public.project_fund_transfers as transfers
      where transfers.id = v_classification.transfer_id and transfers.status = 'CONFIRMED'
        and transfers.transaction_kind = 'NORMAL';
      if not found then raise exception using errcode = 'P0002', message = 'Classified transfer was not found.'; end if;
      perform 1 from public.project_budget_years
      where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
      order by id for update;
      select coalesce(sum(reversals.amount), 0)::bigint into v_reversed
      from public.project_fund_transfers as reversals
      where reversals.reversal_of = v_transfer.id
        and reversals.transaction_kind = 'REVERSAL'
        and reversals.status = 'CONFIRMED';
      if v_amount > v_transfer.amount - v_reversed then
        raise exception using errcode = '23514', message = 'Transfer reversal exceeds unreversed canonical amount.';
      end if;
      perform public.financial_require_available_amount(
        v_transfer.destination_budget_year_id, v_amount,
        'Transfer destination lacks funds required to reverse the decrease.'
      );
      insert into public.project_fund_transfers (
        source_budget_year_id, destination_budget_year_id, amount, status,
        transaction_kind, reversal_of, reason_code, memo, effective_date,
        idempotency_key, created_by, submitted_at, confirmed_by, confirmed_at,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_transfer.destination_budget_year_id, v_transfer.source_budget_year_id,
        v_amount, 'CONFIRMED', 'REVERSAL', v_transfer.id, 'DECREASE_CORRECTION', v_memo,
        v_effective_date, v_request.idempotency_key, v_request.requested_by,
        v_request.submitted_at, v_actor_id, clock_timestamp(),
        v_record_origin, v_evidence_id, v_request.request_fingerprint
      ) returning * into v_transfer;
      v_materialized_table := 'project_fund_transfers';
      v_materialized_record_id := v_transfer.id;
    else
      select adjustments.* into v_adjustment
      from public.project_budget_adjustments as adjustments
      where adjustments.id = v_classification.adjustment_id
        and adjustments.status = 'CONFIRMED'
        and adjustments.transaction_kind = 'NORMAL';
      if not found then raise exception using errcode = 'P0002', message = 'Classified adjustment was not found.'; end if;
      perform 1 from public.project_budget_years
      where id = v_adjustment.budget_year_id for update;
      select coalesce(sum(reversals.amount), 0)::bigint into v_reversed
      from public.project_budget_adjustments as reversals
      where reversals.reversal_of = v_adjustment.id
        and reversals.transaction_kind = 'REVERSAL'
        and reversals.status = 'CONFIRMED';
      if v_amount > v_adjustment.amount - v_reversed then
        raise exception using errcode = '23514', message = 'Adjustment reversal exceeds unreversed canonical amount.';
      end if;
      insert into public.project_budget_adjustments (
        budget_year_id, adjustment_type, amount, status, transaction_kind,
        reversal_of, reason_code, memo, effective_date, idempotency_key,
        created_by, confirmed_by, confirmed_at, record_origin, evidence_id,
        request_fingerprint
      ) values (
        v_adjustment.budget_year_id, v_adjustment.adjustment_type, v_amount,
        'CONFIRMED', 'REVERSAL', v_adjustment.id, 'DECREASE_CORRECTION', v_memo,
        v_effective_date, v_request.idempotency_key, v_request.requested_by,
        v_actor_id, clock_timestamp(), v_record_origin, v_evidence_id,
        v_request.request_fingerprint
      ) returning * into v_adjustment;
      v_materialized_table := 'project_budget_adjustments';
      v_materialized_record_id := v_adjustment.id;
    end if;

    insert into public.financial_project_decrease_classification_reversals (
      classification_id, region_id, fiscal_year, budget_cohort_id,
      source_project_id, source_budget_year_id, amount,
      decrease_amount_before, decrease_amount_after,
      canonical_table, canonical_record_id, movement_id, transfer_id, adjustment_id,
      record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
    ) values (
      v_classification.id, v_classification.region_id, v_classification.fiscal_year,
      v_classification.budget_cohort_id, v_classification.source_project_id,
      v_classification.source_budget_year_id, v_amount, v_before, v_after,
      v_materialized_table, v_materialized_record_id,
      case when v_materialized_table = 'financial_unallocated_fund_movements'
        then v_materialized_record_id end,
      case when v_materialized_table = 'project_fund_transfers'
        then v_materialized_record_id end,
      case when v_materialized_table = 'project_budget_adjustments'
        then v_materialized_record_id end,
      v_record_origin, v_evidence_id, v_request.idempotency_key,
      v_request.request_fingerprint, v_request.requested_by
    ) returning id into v_classification_reversal_id;
    perform public.financial_write_audit(v_classification.source_project_id,
      v_classification.region_id, 'DECREASE_CLASSIFICATION_REVERSED',
      'financial_project_decrease_classification_reversals',
      v_classification_reversal_id, v_actor_id,
      jsonb_build_object('classification_id', v_classification.id,
        'canonical_table', v_materialized_table,
        'canonical_record_id', v_materialized_record_id,
        'amount', v_amount, 'decrease_amount_before', v_before,
        'decrease_amount_after', v_after));

  elsif v_request.request_type in ('CREATE_DECREASE_TRANSFER', 'CREATE_DIRECT_ADJUSTMENT') then
    v_source_budget_year_id := (v_request.payload ->> 'source_budget_year_id')::uuid;
    v_amount := (v_request.payload ->> 'amount')::bigint;
    v_before := (v_request.payload ->> 'decrease_amount_before')::bigint;
    v_after := (v_request.payload ->> 'decrease_amount_after')::bigint;
    v_record_origin := v_request.payload ->> 'record_origin';
    v_evidence_id := nullif(v_request.payload ->> 'evidence_id', '')::uuid;
    v_effective_date := (v_request.payload ->> 'effective_date')::date;
    v_memo := nullif(btrim(v_request.payload ->> 'memo'), '');
    v_is_correction := false;
    select position.region_id, position.fiscal_year, position.budget_cohort_id,
      position.source_project_id
      into v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id
    from public.financial_assert_decrease_delta_position(
      v_source_budget_year_id, v_before, v_after, v_amount, v_is_correction
    ) as position;
    if v_region_id <> v_request.region_id then
      raise exception using errcode = '23514', message = 'Decrease source region changed before apply.';
    end if;
    perform public.financial_assert_funding_origin_evidence(
      v_region_id, v_record_origin, v_effective_date, v_evidence_id
    );
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, -v_amount, 0, v_amount, v_record_origin, false
    );

    if v_request.request_type = 'CREATE_DECREASE_TRANSFER' then
      v_destination_project_id := (v_request.payload ->> 'destination_project_id')::uuid;
      select region_id, year into v_destination_region_id, v_destination_year
      from public.projects where id = v_destination_project_id and project_code is not null;
      if v_destination_region_id is null or v_destination_region_id <> v_region_id
         or v_destination_year is distinct from v_fiscal_year
         or v_destination_project_id = v_source_project_id then
        raise exception using errcode = '23514', message =
          'Decrease transfer requires a distinct same-region, same-year destination project.';
      end if;
      v_destination_budget_year_id := public.financial_get_or_create_budget_year(
        v_destination_project_id, v_budget_cohort_id, v_fiscal_year, v_actor_id
      );
      -- Project logical state is already locked by the delta helper. Lock both
      -- wallets in deterministic UUID order before checking/creating money rows.
      perform 1 from public.project_budget_years
      where id = any(array[v_source_budget_year_id, v_destination_budget_year_id])
      order by id for update;
      perform public.financial_require_available_amount(
        v_source_budget_year_id, v_amount, 'Decrease transfer exceeds source-wallet available funds.'
      );
      insert into public.project_fund_transfers (
        source_budget_year_id, destination_budget_year_id, amount, status,
        transaction_kind, reason_code, memo, effective_date, idempotency_key,
        created_by, submitted_at, confirmed_by, confirmed_at,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_budget_year_id, v_destination_budget_year_id, v_amount, 'CONFIRMED',
        'NORMAL', nullif(btrim(v_request.payload ->> 'reason_code'), ''), v_memo,
        v_effective_date, v_request.idempotency_key, v_request.requested_by,
        v_request.submitted_at, v_actor_id, clock_timestamp(),
        v_record_origin, v_evidence_id, v_request.request_fingerprint
      ) returning * into v_transfer;
      insert into public.financial_project_decrease_classifications (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        outcome_type, amount, decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, transfer_id, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by
      ) values (
        v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id,
        v_source_budget_year_id, 'EXISTING_PROJECT_TRANSFER', v_amount, v_before, v_after,
        'project_fund_transfers', v_transfer.id, v_transfer.id,
        v_record_origin, v_evidence_id, v_request.idempotency_key,
        v_request.request_fingerprint, v_request.requested_by
      ) returning id into v_classification_id;
      v_materialized_table := 'project_fund_transfers';
      v_materialized_record_id := v_transfer.id;
    else
      if (v_request.payload ->> 'adjustment_type') not in ('RETURN', 'EXTERNAL_DECREASE')
         or v_after <= v_before then
        raise exception using errcode = '23514', message =
          'Standalone decrease adjustments are limited to RETURN/EXTERNAL_DECREASE positive deltas.';
      end if;
      perform 1 from public.project_budget_years
      where id = v_source_budget_year_id for update;
      perform public.financial_require_available_amount(
        v_source_budget_year_id, v_amount, 'Direct adjustment exceeds source-wallet available funds.'
      );
      insert into public.project_budget_adjustments (
        budget_year_id, adjustment_type, amount, status, transaction_kind,
        reason_code, memo, effective_date, idempotency_key, created_by,
        confirmed_by, confirmed_at, record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_budget_year_id, v_request.payload ->> 'adjustment_type', v_amount,
        'CONFIRMED', 'NORMAL', nullif(btrim(v_request.payload ->> 'reason_code'), ''),
        v_memo, v_effective_date, v_request.idempotency_key, v_request.requested_by,
        v_actor_id, clock_timestamp(), v_record_origin, v_evidence_id,
        v_request.request_fingerprint
      ) returning * into v_adjustment;
      insert into public.financial_project_decrease_classifications (
        region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
        outcome_type, amount, decrease_amount_before, decrease_amount_after,
        canonical_table, canonical_record_id, adjustment_id, record_origin, evidence_id,
        idempotency_key, request_fingerprint, created_by
      ) values (
        v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id,
        v_source_budget_year_id,
        'DIRECT_RETURN',
        v_amount, v_before, v_after, 'project_budget_adjustments',
        v_adjustment.id, v_adjustment.id, v_record_origin, v_evidence_id,
        v_request.idempotency_key, v_request.request_fingerprint, v_request.requested_by
      ) returning id into v_classification_id;
      v_materialized_table := 'project_budget_adjustments';
      v_materialized_record_id := v_adjustment.id;
    end if;
    perform public.financial_write_audit(v_source_project_id, v_region_id,
      'DECREASE_DELTA_MATERIALIZED', v_materialized_table, v_materialized_record_id,
      v_actor_id, jsonb_build_object('classification_id', v_classification_id,
        'decrease_amount_before', v_before, 'decrease_amount_after', v_after,
        'amount', v_amount));

  elsif v_request.request_type in ('CLASSIFY_EXISTING_TRANSFER', 'CLASSIFY_EXISTING_ADJUSTMENT') then
    v_amount := (v_request.payload ->> 'amount')::bigint;
    v_before := (v_request.payload ->> 'decrease_amount_before')::bigint;
    v_after := (v_request.payload ->> 'decrease_amount_after')::bigint;
    v_source_budget_year_id := null;
    v_is_correction := false;
    if v_request.request_type = 'CLASSIFY_EXISTING_TRANSFER' then
      select transfers.* into v_transfer from public.project_fund_transfers as transfers
      where transfers.id = (v_request.payload ->> 'materialized_record_id')::uuid
        and transfers.status = 'CONFIRMED' and transfers.transaction_kind = 'NORMAL';
      if not found or v_transfer.amount <> v_amount then
        raise exception using errcode = '23514', message = 'Classification must match one confirmed transfer exactly.';
      end if;
      if exists (
        select 1 from public.project_fund_transfers as reversals
        where reversals.reversal_of = v_transfer.id
          and reversals.transaction_kind = 'REVERSAL'
          and reversals.status = 'CONFIRMED'
      ) then
        raise exception using errcode = '23514', message =
          'A transfer with existing reversals cannot be classified as a new decrease delta.';
      end if;
      v_source_budget_year_id := v_transfer.source_budget_year_id;
      v_record_origin := v_transfer.record_origin;
      v_evidence_id := v_transfer.evidence_id;
    else
      select adjustments.* into v_adjustment
      from public.project_budget_adjustments as adjustments
      where adjustments.id = (v_request.payload ->> 'materialized_record_id')::uuid
        and adjustments.status = 'CONFIRMED'
        and adjustments.transaction_kind = 'NORMAL';
      if not found or v_adjustment.amount <> v_amount
         or v_adjustment.adjustment_type not in ('RETURN', 'EXTERNAL_DECREASE') then
        raise exception using errcode = '23514', message = 'Classification must match one confirmed adjustment exactly.';
      end if;
      if exists (
        select 1 from public.project_budget_adjustments as reversals
        where reversals.reversal_of = v_adjustment.id
          and reversals.transaction_kind = 'REVERSAL'
          and reversals.status = 'CONFIRMED'
      ) then
        raise exception using errcode = '23514', message =
          'An adjustment with existing reversals cannot be classified as a new decrease delta.';
      end if;
      v_source_budget_year_id := v_adjustment.budget_year_id;
      v_record_origin := v_adjustment.record_origin;
      v_evidence_id := v_adjustment.evidence_id;
      if v_after <= v_before then
        raise exception using errcode = '23514', message =
          'Adjustment type does not match the decrease snapshot direction.';
      end if;
    end if;
    select position.region_id, position.fiscal_year, position.budget_cohort_id,
      position.source_project_id
      into v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id
    from public.financial_assert_decrease_delta_position(
      v_source_budget_year_id, v_before, v_after, v_amount, v_is_correction
    ) as position;
    if v_region_id <> v_request.region_id then
      raise exception using errcode = '23514', message = 'Classification source region changed before apply.';
    end if;
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, 0, 0, v_amount, v_record_origin, false
    );
    insert into public.financial_project_decrease_classifications (
      region_id, fiscal_year, budget_cohort_id, source_project_id, source_budget_year_id,
      outcome_type, amount, decrease_amount_before, decrease_amount_after,
      canonical_table, canonical_record_id, transfer_id, adjustment_id,
      record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
    ) values (
      v_region_id, v_fiscal_year, v_budget_cohort_id, v_source_project_id,
      v_source_budget_year_id,
      case when v_request.request_type = 'CLASSIFY_EXISTING_TRANSFER'
        then 'EXISTING_PROJECT_TRANSFER'
        else 'DIRECT_RETURN' end,
      v_amount, v_before, v_after,
      case when v_request.request_type = 'CLASSIFY_EXISTING_TRANSFER'
        then 'project_fund_transfers' else 'project_budget_adjustments' end,
      coalesce(v_transfer.id, v_adjustment.id), v_transfer.id, v_adjustment.id,
      v_record_origin, v_evidence_id, v_request.idempotency_key,
      v_request.request_fingerprint, v_request.requested_by
    ) returning id into v_classification_id;
    v_materialized_table := 'financial_project_decrease_classifications';
    v_materialized_record_id := v_classification_id;
  end if;

  update public.financial_funding_reallocation_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
      materialized_table = v_materialized_table,
      materialized_record_id = v_materialized_record_id
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status,
    v_request.materialized_table, v_request.materialized_record_id;
end;
$$;

create or replace function public.financial_apply_new_project_request(p_request_id uuid)
returns table (
  request_id uuid, project_id uuid, project_code text,
  movement_id uuid, budget_year_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_project_id uuid;
  v_budget_year_id uuid;
  v_movement_id uuid;
  v_remaining bigint;
  v_fingerprint text;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_new_project_requests
  where id = p_request_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'New-project request was not found.';
  end if;
  if v_request.status = 'APPLIED' then
    select movements.destination_budget_year_id into v_budget_year_id
    from public.financial_unallocated_fund_movements as movements
    where movements.id = v_request.materialized_movement_id
      and movements.new_project_request_id = v_request.id;
    if v_request.materialized_project_id is null
       or v_request.materialized_movement_id is null or v_budget_year_id is null then
      raise exception using errcode = '55000', message =
        'APPLIED new-project request has incomplete materialized references.';
    end if;
    return query select v_request.id, v_request.materialized_project_id,
      v_request.official_project_code, v_request.materialized_movement_id,
      v_budget_year_id;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'A different admin may apply only an APPROVED new-project request.';
  end if;
  if exists (select 1 from public.projects as existing_projects
      where existing_projects.project_code = v_request.official_project_code
         or existing_projects.project_id = v_request.official_project_code) then
    raise exception using errcode = '23505', message = 'Approved project_code now conflicts with an existing project.';
  end if;
  select * into v_lot from public.financial_unallocated_fund_lots
  where id = v_request.source_lot_id;
  if not found or v_lot.region_id <> v_request.region_id
     or v_lot.fiscal_year <> v_request.fiscal_year then
    raise exception using errcode = '23514', message = 'Approved project source lot no longer matches region/year.';
  end if;
  v_remaining := public.financial_lock_unallocated_lot_remaining(v_lot.id);
  if v_request.requested_amount > v_remaining then
    raise exception using errcode = '23514', message = 'New-project funding exceeds locked waiting-fund balance.';
  end if;
  perform public.financial_assert_funding_origin_evidence(
    v_lot.region_id, v_lot.record_origin, v_lot.effective_date, v_lot.evidence_id
  );

  -- No max(sequence)+1 inference. The only code written is the admin-reviewed
  -- official_project_code, protected again by the projects unique index.
  insert into public.projects (
    project_id, project_code, region_id, year, project_name, fund_project_name, detail_project_name,
    project_period, project_start_year, project_end_year, status, business_type,
    large_category_id, middle_category_id, total_budget,
    original_alloc, increase_amount, decrease_amount,
    alloc, exec, rate
  ) values (
    v_request.official_project_code, v_request.official_project_code,
    v_request.region_id, v_request.fiscal_year,
    v_request.project_name, v_request.fund_project_name, v_request.detail_project_name,
    v_request.project_period, v_request.project_start_year, v_request.project_end_year,
    v_request.project_status, v_request.business_type, v_request.large_category_id,
    v_request.middle_category_id, v_request.requested_amount,
    0, v_request.requested_amount, 0, v_request.requested_amount, 0, 0
  ) returning id into v_project_id;

  v_budget_year_id := public.financial_get_or_create_budget_year(
    v_project_id, v_lot.budget_cohort_id, v_request.fiscal_year, v_actor_id
  );
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'request_id', v_request.id, 'source_lot_id', v_lot.id,
    'destination_project_id', v_project_id, 'amount', v_request.requested_amount,
    'record_origin', v_lot.record_origin, 'evidence_id', v_lot.evidence_id
  ));
  insert into public.financial_unallocated_fund_movements (
    lot_id, region_id, budget_cohort_id, movement_type, transaction_kind,
    destination_project_id, destination_budget_year_id, new_project_request_id,
    amount, effective_date, record_origin, evidence_id, memo,
    idempotency_key, request_fingerprint, created_by, confirmed_by
  ) values (
    v_lot.id, v_lot.region_id, v_lot.budget_cohort_id,
    'ALLOCATE_NEW_PROJECT', 'NORMAL', v_project_id, v_budget_year_id, v_request.id,
    v_request.requested_amount, v_lot.effective_date, v_lot.record_origin,
    v_lot.evidence_id, 'Approved new-project waiting-fund allocation',
    v_request.idempotency_key, v_fingerprint, v_request.requested_by, v_actor_id
  ) returning id into v_movement_id;

  update public.financial_new_project_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
      materialized_project_id = v_project_id, materialized_movement_id = v_movement_id
  where id = v_request.id;
  perform public.financial_write_audit(v_project_id, v_request.region_id,
    'NEW_PROJECT_APPLIED', 'financial_new_project_requests', v_request.id, v_actor_id,
    jsonb_build_object('project_code', v_request.official_project_code,
      'source_lot_id', v_lot.id, 'amount', v_request.requested_amount,
      'budget_cohort_id', v_lot.budget_cohort_id,
      'destination_budget_year_id', v_budget_year_id,
      'movement_id', v_movement_id));
  return query select v_request.id, v_project_id, v_request.official_project_code,
    v_movement_id, v_budget_year_id;
end;
$$;

-- Replacing an existing function preserves ownership and its ACL. Reassert the
-- intended public surface explicitly so this follow-up also fails closed.
revoke all on function public.financial_apply_funding_reallocation_request(uuid)
  from public, anon;
grant execute on function public.financial_apply_funding_reallocation_request(uuid)
  to authenticated;
revoke all on function public.financial_apply_new_project_request(uuid)
  from public, anon;
grant execute on function public.financial_apply_new_project_request(uuid)
  to authenticated;

do $$
declare
  v_funding text;
  v_new_project text;
begin
  select lower(pg_catalog.pg_get_functiondef(
    'public.financial_apply_funding_reallocation_request(uuid)'::regprocedure
  )) into v_funding;
  select lower(pg_catalog.pg_get_functiondef(
    'public.financial_apply_new_project_request(uuid)'::regprocedure
  )) into v_new_project;

  if position('and status = ''confirmed''' in v_funding) > 0
     or position('transfers.status = ''confirmed''' in v_funding) = 0
     or position('adjustments.status = ''confirmed''' in v_funding) = 0
     or position('reversals.status = ''confirmed''' in v_funding) = 0 then
    raise exception using errcode = '55000', message =
      'Funding APPLY output-column qualification postcondition failed.';
  end if;
  if v_new_project ~ 'where[[:space:]]+project_code[[:space:]]*='
     or v_new_project ~ 'or[[:space:]]+project_id[[:space:]]*='
     or position('existing_projects.project_code' in v_new_project) = 0
     or position('existing_projects.project_id' in v_new_project) = 0 then
    raise exception using errcode = '55000', message =
      'New-project APPLY output-column qualification postcondition failed.';
  end if;
end
$$;

do $$
declare v_snapshot funding_reallocation_uat_hotfix_snapshot%rowtype;
begin
  select * into v_snapshot from funding_reallocation_uat_hotfix_snapshot;
  if (select count(*) from public.projects) <> v_snapshot.project_count
     or (select coalesce(sum(coalesce(alloc, 0)), 0) from public.projects)
        <> v_snapshot.project_alloc_total
     or (select coalesce(sum(coalesce(exec, 0)), 0) from public.projects)
        <> v_snapshot.project_exec_total
     or (select count(*) from public.project_fund_transfers) <> v_snapshot.transfer_count
     or (select count(*) from public.project_budget_adjustments) <> v_snapshot.adjustment_count
     or (select count(*) from public.financial_unallocated_fund_lots) <> v_snapshot.lot_count
     or (select count(*) from public.financial_unallocated_fund_movements) <> v_snapshot.movement_count
     or (select count(*) from public.financial_project_decrease_classifications)
        <> v_snapshot.classification_count
     or (select count(*) from public.financial_project_decrease_classification_reversals)
        <> v_snapshot.classification_reversal_count
     or (select count(*) from public.financial_funding_reallocation_requests)
        <> v_snapshot.funding_request_count
     or (select count(*) from public.financial_new_project_requests)
        <> v_snapshot.new_project_request_count
     or (select jsonb_agg(to_jsonb(runtime) order by runtime.singleton)
        from public.financial_ledger_runtime as runtime) is distinct from v_snapshot.runtime_rows then
    raise exception using errcode = '55000', message =
      'Funding UAT hotfix must not mutate TEST data or runtime policy.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
