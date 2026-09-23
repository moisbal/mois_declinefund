-- Keep execution reversals compatible with the origin/evidence policy added to
-- immutable ledger records.  The public server action forwards an authenticated
-- administrator JWT, so EXECUTE must be available to authenticated callers; the
-- function still enforces the administrator role internally.

create or replace function public.create_execution_reversal(
  p_original_execution_id uuid,
  p_amount bigint,
  p_memo text,
  p_execution_date date,
  p_idempotency_key uuid
)
returns table(execution_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_original public.project_execution_records%rowtype;
  v_reversal public.project_execution_records%rowtype;
  v_reversed_amount bigint;
  v_project_id uuid;
  v_region_id uuid;
  v_fingerprint text;
begin
  select actor_id, actor_role
    into v_actor_id, v_role
  from public.financial_require_actor();

  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '집행 역분개는 관리자만 생성할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_execution_date is null then
    raise exception using errcode = '22023', message = '집행 역분개 금액, 효력일, 요청키는 필수입니다.';
  end if;

  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'operation', 'EXECUTION_REVERSAL',
    'original_execution_id', p_original_execution_id,
    'amount', p_amount,
    'memo', nullif(btrim(p_memo), ''),
    'execution_date', p_execution_date
  ));

  select * into v_reversal
  from public.project_execution_records
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_reversal.request_fingerprint,
      v_fingerprint,
      '집행 역분개'
    );
    return query select v_reversal.id, v_reversal.status;
    return;
  end if;

  select * into v_original
  from public.project_execution_records
  where id = p_original_execution_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then
    raise exception using errcode = '23514', message = '확정된 일반 집행만 역분개할 수 있습니다.';
  end if;

  perform 1
  from public.project_budget_years
  where id = v_original.budget_year_id
  for update;

  select coalesce(sum(amount), 0)
    into v_reversed_amount
  from public.project_execution_records
  where reversal_of = v_original.id
    and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then
    raise exception using errcode = '23514', message = '원 집행의 미반전 금액을 초과할 수 없습니다.';
  end if;

  select projects.id, projects.region_id
    into v_project_id, v_region_id
  from public.project_budget_years wallet
  join public.projects projects on projects.id = wallet.project_id
  where wallet.id = v_original.budget_year_id;

  perform public.financial_assert_funding_origin_evidence(
    v_region_id,
    v_original.record_origin,
    p_execution_date,
    v_original.evidence_id
  );

  insert into public.project_execution_records (
    budget_year_id,
    amount,
    execution_date,
    status,
    transaction_kind,
    reversal_of,
    memo,
    idempotency_key,
    created_by,
    confirmed_by,
    confirmed_at,
    record_origin,
    evidence_id,
    request_fingerprint
  ) values (
    v_original.budget_year_id,
    p_amount,
    p_execution_date,
    'CONFIRMED',
    'REVERSAL',
    v_original.id,
    nullif(btrim(p_memo), ''),
    p_idempotency_key,
    v_actor_id,
    v_actor_id,
    clock_timestamp(),
    v_original.record_origin,
    v_original.evidence_id,
    v_fingerprint
  )
  returning * into v_reversal;

  perform public.financial_write_audit(
    v_project_id,
    v_region_id,
    'EXECUTION_REVERSED',
    'project_execution_records',
    v_reversal.id,
    v_actor_id,
    jsonb_build_object(
      'reversal_of', v_original.id,
      'amount', p_amount,
      'execution_date', p_execution_date,
      'record_origin', v_original.record_origin
    )
  );

  return query select v_reversal.id, v_reversal.status;
end;
$$;

revoke all on function public.create_execution_reversal(uuid, bigint, text, date, uuid)
  from public, anon;
grant execute on function public.create_execution_reversal(uuid, bigint, text, date, uuid)
  to authenticated, service_role;

