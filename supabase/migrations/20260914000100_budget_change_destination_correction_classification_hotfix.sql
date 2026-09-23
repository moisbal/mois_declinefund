-- Link destination-transfer corrections to the canonical decrease
-- classification reversal chain. This is schema/function-only and does not
-- mutate existing business or monetary rows.

begin;

do $$
begin
  if to_regclass('public.financial_budget_change_destination_corrections') is null
     or to_regprocedure(
       'public.financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)'
     ) is null then
    raise exception using errcode = '55000', message =
      '목적지 정정 분류 연결의 선행 마이그레이션을 찾을 수 없습니다.';
  end if;
end;
$$;

create temporary table budget_change_correction_classification_guard on commit drop as
select
  (select count(*) from public.project_fund_transfers)::bigint as transfer_count,
  (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric as transfer_amount,
  (select count(*) from public.financial_project_decrease_classifications)::bigint as classification_count,
  (select coalesce(sum(amount), 0) from public.financial_project_decrease_classifications)::numeric
    as classification_amount,
  (select count(*) from public.financial_project_decrease_classification_reversals)::bigint
    as reversal_count,
  (select coalesce(sum(amount), 0)
    from public.financial_project_decrease_classification_reversals)::numeric as reversal_amount;

create or replace function public.financial_reclassify_budget_change_destination_transfer(
  p_original_transfer_id uuid,
  p_reversal_transfer_id uuid,
  p_replacement_transfer_id uuid,
  p_actor_id uuid,
  p_correction_idempotency_key uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_classification public.financial_project_decrease_classifications%rowtype;
  v_original public.project_fund_transfers%rowtype;
  v_reversal public.project_fund_transfers%rowtype;
  v_replacement public.project_fund_transfers%rowtype;
  v_current_decrease bigint;
  v_reversal_classification_id uuid;
begin
  select classifications.* into v_classification
  from public.financial_project_decrease_classifications as classifications
  where classifications.transfer_id = p_original_transfer_id
  for update;
  if not found then
    raise exception using errcode = '23514', message =
      '원 예산이관의 감액 분류를 찾을 수 없습니다.';
  end if;
  select transfers.* into v_original
  from public.project_fund_transfers as transfers
  where transfers.id = p_original_transfer_id;
  select transfers.* into v_reversal
  from public.project_fund_transfers as transfers
  where transfers.id = p_reversal_transfer_id;
  select transfers.* into v_replacement
  from public.project_fund_transfers as transfers
  where transfers.id = p_replacement_transfer_id;
  if v_original.id is null or v_reversal.id is null or v_replacement.id is null
     or v_reversal.transaction_kind <> 'REVERSAL'
     or v_reversal.reversal_of <> v_original.id
     or v_replacement.transaction_kind <> 'NORMAL'
     or v_original.source_budget_year_id <> v_replacement.source_budget_year_id
     or v_original.amount <> v_reversal.amount
     or v_original.amount <> v_replacement.amount
     or v_original.record_origin <> v_reversal.record_origin
     or v_original.record_origin <> v_replacement.record_origin
     or v_original.evidence_id is distinct from v_reversal.evidence_id
     or v_original.evidence_id is distinct from v_replacement.evidence_id then
    raise exception using errcode = '23514', message =
      '목적지 정정 이관과 감액 분류의 연결 정보가 일치하지 않습니다.';
  end if;
  select coalesce(sum(effects.classification_effect), 0)::bigint
    into v_current_decrease
  from public.financial_project_decrease_classification_effects as effects
  where effects.source_project_id = v_classification.source_project_id;
  if v_current_decrease < v_classification.amount then
    raise exception using errcode = '23514', message =
      '목적지 정정 전 현재 감액 분류 금액을 확인할 수 없습니다.';
  end if;

  insert into public.financial_project_decrease_classification_reversals (
    classification_id, region_id, fiscal_year, budget_cohort_id,
    source_project_id, source_budget_year_id, amount,
    decrease_amount_before, decrease_amount_after,
    canonical_table, canonical_record_id, transfer_id,
    record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
  ) values (
    v_classification.id, v_classification.region_id, v_classification.fiscal_year,
    v_classification.budget_cohort_id, v_classification.source_project_id,
    v_classification.source_budget_year_id, v_classification.amount,
    v_current_decrease, v_current_decrease - v_classification.amount,
    'project_fund_transfers', v_reversal.id, v_reversal.id,
    v_reversal.record_origin, v_reversal.evidence_id, gen_random_uuid(),
    public.financial_request_fingerprint(jsonb_build_object(
      'correction_idempotency_key', p_correction_idempotency_key,
      'phase', 'CLASSIFICATION_REVERSAL',
      'classification_id', v_classification.id,
      'transfer_id', v_reversal.id
    )), p_actor_id
  ) returning id into v_reversal_classification_id;

  insert into public.financial_project_decrease_classifications (
    region_id, fiscal_year, budget_cohort_id, source_project_id,
    source_budget_year_id, outcome_type, amount,
    decrease_amount_before, decrease_amount_after,
    canonical_table, canonical_record_id, transfer_id,
    record_origin, evidence_id, idempotency_key, request_fingerprint, created_by
  ) values (
    v_classification.region_id, v_classification.fiscal_year,
    v_classification.budget_cohort_id, v_classification.source_project_id,
    v_classification.source_budget_year_id, 'EXISTING_PROJECT_TRANSFER',
    v_classification.amount,
    v_current_decrease - v_classification.amount, v_current_decrease,
    'project_fund_transfers', v_replacement.id, v_replacement.id,
    v_replacement.record_origin, v_replacement.evidence_id, gen_random_uuid(),
    public.financial_request_fingerprint(jsonb_build_object(
      'correction_idempotency_key', p_correction_idempotency_key,
      'phase', 'REPLACEMENT_CLASSIFICATION',
      'reversed_classification_id', v_classification.id,
      'reversal_classification_id', v_reversal_classification_id,
      'transfer_id', v_replacement.id
    )), p_actor_id
  );
end;
$$;

do $patch$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef(
    'public.financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)'::regprocedure
  ) into v_definition;
  if position('financial_reclassify_budget_change_destination_transfer' in v_definition) = 0 then
    v_original := v_definition;
    v_definition := replace(v_definition,
      '    ) returning id into v_replacement_id;
  else',
      '    ) returning id into v_replacement_id;
    perform public.financial_reclassify_budget_change_destination_transfer(
      v_transfer.id, v_reversal_id, v_replacement_id,
      v_actor_id, p_idempotency_key
    );
  else');
    if v_definition = v_original
       or position('financial_reclassify_budget_change_destination_transfer' in v_definition) = 0 then
      raise exception using errcode = '55000', message =
        '목적지 정정 함수에 감액 분류 연결 패치를 적용하지 못했습니다.';
    end if;
    execute v_definition;
  end if;
end;
$patch$;

revoke all on function public.financial_reclassify_budget_change_destination_transfer(
  uuid,uuid,uuid,uuid,uuid
) from public, anon, authenticated, service_role;

do $$
declare
  v_before budget_change_correction_classification_guard%rowtype;
  v_after budget_change_correction_classification_guard%rowtype;
  v_definition text;
begin
  select * into v_before from budget_change_correction_classification_guard;
  select
    (select count(*) from public.project_fund_transfers)::bigint,
    (select coalesce(sum(amount), 0) from public.project_fund_transfers)::numeric,
    (select count(*) from public.financial_project_decrease_classifications)::bigint,
    (select coalesce(sum(amount), 0)
      from public.financial_project_decrease_classifications)::numeric,
    (select count(*)
      from public.financial_project_decrease_classification_reversals)::bigint,
    (select coalesce(sum(amount), 0)
      from public.financial_project_decrease_classification_reversals)::numeric
  into v_after;
  if row(v_before.*) is distinct from row(v_after.*) then
    raise exception using errcode = '55000', message =
      '목적지 정정 분류 패치가 기존 원장 또는 분류 행을 변경했습니다.';
  end if;
  select pg_get_functiondef(
    'public.financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)'::regprocedure
  ) into v_definition;
  if position('financial_reclassify_budget_change_destination_transfer' in v_definition) = 0 then
    raise exception using errcode = '55000', message =
      '목적지 정정 함수의 감액 분류 연결 사후검증에 실패했습니다.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
