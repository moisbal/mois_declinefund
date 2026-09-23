-- DRAFT MIGRATION ONLY. Run manually in the Supabase SQL editor AFTER
-- 20260819_18_add_financial_ledger.sql has been reviewed and applied.
--
-- Adds a controlled Legacy Baseline cutover. It never derives historical
-- transactions from projects.alloc / projects.exec and never deletes test rows.
-- Read-only validation of 3,895 current official projects found that
-- exec / alloc * 100 matched projects.rate within +/- 0.005 percentage points
-- for all 3,774 rows with alloc > 0 (121 rows had alloc = 0; none had exec >
-- alloc or a NULL rate). Therefore this migration treats projects.alloc as the
-- current/adjusted allocation and projects.exec as cumulative execution.

begin;

-- A system has one financial-ledger cutover. Dates are business dates in
-- Asia/Seoul; baseline_as_of is always the day before operating_start_date.
create table if not exists public.financial_ledger_cutovers (
  id uuid primary key default gen_random_uuid(),
  operating_start_date date not null,
  baseline_as_of date not null,
  timezone_name text not null default 'Asia/Seoul' check (timezone_name = 'Asia/Seoul'),
  status text not null check (status in ('PREPARING', 'REVIEWING', 'CONFIRMED', 'CANCELLED')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  confirmed_by uuid references public.profiles(id) on delete restrict,
  confirmed_at timestamptz,
  memo text,
  constraint financial_ledger_cutovers_baseline_date_check
    check (baseline_as_of = operating_start_date - 1),
  constraint financial_ledger_cutovers_confirmation_check
    check ((status <> 'CONFIRMED') or (confirmed_by is not null and confirmed_at is not null)),
  constraint financial_ledger_cutovers_memo_length_check
    check (memo is null or char_length(memo) <= 1000)
);

create unique index if not exists financial_ledger_cutovers_one_active
  on public.financial_ledger_cutovers ((true))
  where status in ('PREPARING', 'REVIEWING', 'CONFIRMED');

-- This is an immutable point-in-time financial snapshot, not a reconstructed
-- transaction. original_allocation remains NULL when the legacy source cannot
-- establish it; NULL means UNKNOWN, never zero.
create table if not exists public.project_financial_baselines (
  id uuid primary key default gen_random_uuid(),
  cutover_id uuid not null references public.financial_ledger_cutovers(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  baseline_as_of date not null,
  -- NEEDS_REVIEW rows preserve the raw legacy snapshot, including invalid
  -- values, so the snapshot itself never fails or silently "repairs" data.
  -- Non-negative values are required before a row can become VERIFIED.
  original_allocation bigint,
  adjusted_allocation bigint,
  cumulative_execution bigint,
  verification_status text not null check (verification_status in ('VERIFIED', 'NEEDS_REVIEW', 'EXCLUDED')),
  verification_note text,
  verified_by uuid references public.profiles(id) on delete restrict,
  verified_at timestamptz,
  source_type text not null check (source_type = 'LEGACY_BASELINE'),
  source_snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  ledger_budget_year_id uuid unique references public.project_budget_years(id) on delete restrict,
  constraint project_financial_baselines_amounts_required_when_verified check (
    verification_status <> 'VERIFIED'
    or (adjusted_allocation is not null and cumulative_execution is not null
        and adjusted_allocation >= 0 and cumulative_execution >= 0
        and cumulative_execution <= adjusted_allocation)
  ),
  -- verified_by / verified_at record the administrator and time of either
  -- terminal decision: VERIFIED or an explicitly approved EXCLUDED.
  constraint project_financial_baselines_verification_check check (
    (verification_status in ('VERIFIED', 'EXCLUDED') and verified_by is not null and verified_at is not null)
    or (verification_status = 'NEEDS_REVIEW' and verified_by is null and verified_at is null)
  ),
  constraint project_financial_baselines_note_length_check
    check (verification_note is null or char_length(verification_note) <= 1000),
  unique (cutover_id, project_id)
);

-- A Phase-2 correction workflow has an explicit home. This migration does not
-- expose a correction write RPC, so an old effective-date transaction can never
-- be used as a disguised baseline correction.
create table if not exists public.project_baseline_corrections (
  id uuid primary key default gen_random_uuid(),
  baseline_id uuid not null references public.project_financial_baselines(id) on delete restrict,
  status text not null check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED')),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  effective_from date not null,
  effective_to date,
  previous_values jsonb not null,
  proposed_values jsonb not null,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  applied_by uuid references public.profiles(id) on delete restrict,
  applied_at timestamptz,
  constraint project_baseline_corrections_range_check
    check (effective_to is null or effective_to >= effective_from),
  constraint project_baseline_corrections_approval_check
    check ((status not in ('APPROVED', 'APPLIED')) or (approved_by is not null and approved_at is not null))
);

-- The snapshot history begins at cutover. It intentionally makes no claim about
-- metadata before cutover; CUTOVER_SNAPSHOT identifies that boundary explicitly.
create table if not exists public.project_metadata_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  cutover_id uuid references public.financial_ledger_cutovers(id) on delete restrict,
  effective_date date not null,
  event_type text not null check (event_type in ('CUTOVER_SNAPSHOT', 'PROJECT_UPDATE', 'SMALL_CATEGORY_UPDATE')),
  snapshot jsonb not null,
  changed_by uuid references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table public.project_budget_cohorts
  add column if not exists source_type text not null default 'STANDARD'
    check (source_type in ('STANDARD', 'LEGACY_BASELINE'));

-- Do not manufacture an origin year for Legacy Baseline money. A NULL origin
-- year is an explicit UNKNOWN sentinel; STANDARD cohorts must still have one.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'project_budget_cohorts_origin_year_by_source_check'
      and conrelid = 'public.project_budget_cohorts'::regclass
  ) then
    alter table public.project_budget_cohorts
      add constraint project_budget_cohorts_origin_year_by_source_check check (
        (source_type = 'STANDARD' and origin_fiscal_year is not null and initial_allocation > 0)
        or (source_type = 'LEGACY_BASELINE' and origin_fiscal_year is null and initial_allocation >= 0)
      );
  end if;
end
$$;

-- STANDARD cohort에는 Legacy 이월이력 필드를 만들지 않는다. LEGACY_BASELINE
-- cohort는 UNKNOWN으로 시작하며, count의 NULL은 "0회"가 아니라 "알 수 없음"이다.
alter table public.project_budget_cohorts
  add column if not exists legacy_carryover_status text,
  add column if not exists legacy_prior_carryover_count smallint,
  add column if not exists carryover_verified_by uuid references public.profiles(id) on delete restrict,
  add column if not exists carryover_verified_at timestamptz,
  add column if not exists carryover_verification_note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'project_budget_cohorts_legacy_carryover_state_check'
      and conrelid = 'public.project_budget_cohorts'::regclass
  ) then
    alter table public.project_budget_cohorts
      add constraint project_budget_cohorts_legacy_carryover_state_check check (
        (source_type = 'STANDARD'
          and legacy_carryover_status is null
          and legacy_prior_carryover_count is null
          and carryover_verified_by is null
          and carryover_verified_at is null
          and carryover_verification_note is null)
        or (source_type = 'LEGACY_BASELINE' and legacy_carryover_status is not null and (
          (legacy_carryover_status = 'UNKNOWN'
            and legacy_prior_carryover_count is null
            and carryover_verified_by is null
            and carryover_verified_at is null)
          or (legacy_carryover_status = 'VERIFIED'
            and legacy_prior_carryover_count between 0 and 2
            and carryover_verified_by is not null
            and carryover_verified_at is not null
            and char_length(btrim(coalesce(carryover_verification_note, ''))) between 1 and 1000)
        ))
      );
  end if;
end
$$;

alter table public.project_budget_years
  add column if not exists legacy_baseline_id uuid unique
    references public.project_financial_baselines(id) on delete restrict;

alter table public.project_carryovers
  add column if not exists effective_date date;
do $$
begin
  if exists (
    select 1 from public.project_carryovers where effective_date is null
  ) then
    raise exception using errcode = '23502', message =
      'effective_date가 없는 기존 이월 원장 행이 있습니다. 날짜를 추정하지 말고 별도 검토·정정 후 Cutover migration을 다시 실행하세요.';
  end if;
end
$$;
alter table public.project_carryovers
  alter column effective_date set not null;

create index if not exists idx_project_financial_baselines_cutover_status
  on public.project_financial_baselines(cutover_id, verification_status);
create index if not exists idx_project_financial_baselines_project
  on public.project_financial_baselines(project_id, baseline_as_of);
create index if not exists idx_project_metadata_history_project_date
  on public.project_metadata_history(project_id, effective_date desc, recorded_at desc);
create index if not exists idx_project_fund_transfers_effective_confirmed
  on public.project_fund_transfers(effective_date, status)
  where status = 'CONFIRMED';
create index if not exists idx_project_execution_records_effective_confirmed
  on public.project_execution_records(execution_date, status)
  where status = 'CONFIRMED';
create index if not exists idx_project_carryovers_effective_confirmed
  on public.project_carryovers(effective_date, status)
  where status = 'CONFIRMED';
create index if not exists idx_project_budget_adjustments_effective_confirmed
  on public.project_budget_adjustments(effective_date, status)
  where status = 'CONFIRMED';

-- Replace the migration-18 trigger helper only after the Legacy fields exist.
-- For STANDARD cohorts its original origin_fiscal_year calculation is unchanged.
create or replace function public.financial_validate_wallet_relationship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.project_budget_years%rowtype;
  v_destination public.project_budget_years%rowtype;
  v_origin_year integer;
  v_legacy_status text;
  v_legacy_prior_count smallint;
  v_legacy_baseline_fiscal_year integer;
  v_original public.project_carryovers%rowtype;
  v_expected_sequence smallint;
  v_expected_type text;
begin
  if tg_table_name = 'project_fund_transfers' then
    select * into v_source from public.project_budget_years where id = new.source_budget_year_id;
    select * into v_destination from public.project_budget_years where id = new.destination_budget_year_id;
    if not found then
      raise exception using errcode = '23503', message = '재원 위치를 찾을 수 없습니다.';
    end if;
    if v_source.budget_cohort_id <> v_destination.budget_cohort_id
       or v_source.fiscal_year <> v_destination.fiscal_year then
      raise exception using errcode = '23514', message = '재원이동은 동일 cohort와 동일 회계연도 내에서만 가능합니다.';
    end if;
    return new;
  end if;

  if tg_table_name = 'project_carryovers' then
    select * into v_source from public.project_budget_years where id = new.source_budget_year_id;
    select * into v_destination from public.project_budget_years where id = new.destination_budget_year_id;
    if not found then
      raise exception using errcode = '23503', message = '재원 위치를 찾을 수 없습니다.';
    end if;
    if v_source.budget_cohort_id <> v_destination.budget_cohort_id then
      raise exception using errcode = '23514', message = '이월은 동일 cohort를 유지해야 합니다.';
    end if;

    if new.transaction_kind = 'NORMAL' then
      select origin_fiscal_year, legacy_carryover_status, legacy_prior_carryover_count
        into v_origin_year, v_legacy_status, v_legacy_prior_count
      from public.project_budget_cohorts
      where id = v_source.budget_cohort_id;
      if v_destination.fiscal_year <> v_source.fiscal_year + 1 then
        raise exception using errcode = '23514', message = '이월 목적 회계연도는 원천 회계연도의 다음 연도여야 합니다.';
      end if;
      if v_origin_year is not null then
        v_expected_sequence := v_destination.fiscal_year - v_origin_year;
      else
        if v_legacy_status is distinct from 'VERIFIED' or v_legacy_prior_count is null then
          raise exception using errcode = '55000',
            message = 'UNKNOWN Legacy Baseline 재원은 증빙 기반 관리자 검증 전에는 이월할 수 없습니다.';
        end if;
        select fiscal_year into v_legacy_baseline_fiscal_year
        from public.project_budget_years
        where budget_cohort_id = v_source.budget_cohort_id
          and legacy_baseline_id is not null;
        if v_legacy_baseline_fiscal_year is null then
          raise exception using errcode = '23503', message = 'Legacy Baseline 기준 재원 위치를 찾을 수 없습니다.';
        end if;
        v_expected_sequence := v_legacy_prior_count
          + (v_source.fiscal_year - v_legacy_baseline_fiscal_year) + 1;
      end if;
      if v_expected_sequence not in (1, 2) or new.carryover_sequence <> v_expected_sequence then
        raise exception using errcode = '23514', message = '확정된 이월이력 기준으로 최대 2회까지만 이월할 수 있습니다.';
      end if;
      v_expected_type := case when v_expected_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
      if new.carryover_type <> v_expected_type then
        raise exception using errcode = '23514', message = '이월 유형은 확정된 이월이력 기준으로 자동 결정됩니다.';
      end if;
    else
      select * into v_original from public.project_carryovers where id = new.reversal_of;
      if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then
        raise exception using errcode = '23514', message = '확정된 일반 이월만 reversal할 수 있습니다.';
      end if;
      if new.source_budget_year_id <> v_original.destination_budget_year_id
         or new.destination_budget_year_id <> v_original.source_budget_year_id
         or new.carryover_sequence <> v_original.carryover_sequence
         or new.carryover_type <> v_original.carryover_type
         or v_destination.fiscal_year <> v_source.fiscal_year - 1 then
        raise exception using errcode = '23514', message = '이월 reversal은 원거래의 반대 방향과 동일 이월정보를 사용해야 합니다.';
      end if;
    end if;
    return new;
  end if;

  raise exception using errcode = '22023', message = '지원하지 않는 원장 관계 검증 대상입니다.';
end;
$$;

create or replace function public.financial_require_admin()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
begin
  select actor_id, actor_role into v_actor_id, v_role from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '재정원장 Cutover는 관리자만 처리할 수 있습니다.';
  end if;
  return v_actor_id;
end;
$$;

-- Cohort location remains immutable. The sole exception is the one-way,
-- evidence-backed UNKNOWN -> VERIFIED transition for Legacy carryover history.
create or replace function public.financial_prevent_location_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'project_budget_cohorts' then
    if tg_op = 'UPDATE'
       and old.source_type = 'LEGACY_BASELINE'
       and old.legacy_carryover_status = 'UNKNOWN'
       and new.source_type is not distinct from old.source_type
       and new.origin_project_id is not distinct from old.origin_project_id
       and new.origin_fiscal_year is not distinct from old.origin_fiscal_year
       and new.initial_allocation is not distinct from old.initial_allocation
       and new.allocation_type is not distinct from old.allocation_type
       and new.memo is not distinct from old.memo
       and new.idempotency_key is not distinct from old.idempotency_key
       and new.created_by is not distinct from old.created_by
       and new.created_at is not distinct from old.created_at
       and new.legacy_carryover_status = 'VERIFIED'
       and new.legacy_prior_carryover_count between 0 and 2
       and new.carryover_verified_by is not null
       and new.carryover_verified_at is not null
       and char_length(btrim(coalesce(new.carryover_verification_note, ''))) between 1 and 1000
    then
      return new;
    end if;
  end if;
  raise exception using errcode = '55000', message = '재원 cohort 및 위치는 생성 후 수정 또는 삭제할 수 없습니다. Legacy 이월이력은 증빙 검증 RPC로 한 번만 확정할 수 있습니다.';
end;
$$;

create or replace function public.verify_legacy_carryover_history(
  p_budget_cohort_id uuid,
  p_legacy_prior_carryover_count smallint,
  p_verification_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_cohort public.project_budget_cohorts%rowtype;
  v_region_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if p_legacy_prior_carryover_count is null
     or p_legacy_prior_carryover_count not in (0, 1, 2)
     or char_length(btrim(coalesce(p_verification_note, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = '증빙 검증된 과거 이월횟수(0~2)와 검증 메모는 필수입니다.';
  end if;
  select * into v_cohort
  from public.project_budget_cohorts
  where id = p_budget_cohort_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Legacy 재원 cohort를 찾을 수 없습니다.';
  end if;
  select region_id into v_region_id
  from public.projects
  where id = v_cohort.origin_project_id;
  if v_cohort.source_type <> 'LEGACY_BASELINE'
     or v_cohort.legacy_carryover_status <> 'UNKNOWN'
     or v_cohort.origin_fiscal_year is not null then
    raise exception using errcode = '23514', message = 'UNKNOWN 상태의 Legacy Baseline cohort만 이월이력을 확정할 수 있습니다.';
  end if;
  update public.project_budget_cohorts
  set legacy_carryover_status = 'VERIFIED',
      legacy_prior_carryover_count = p_legacy_prior_carryover_count,
      carryover_verified_by = v_actor_id,
      carryover_verified_at = clock_timestamp(),
      carryover_verification_note = btrim(p_verification_note)
  where id = v_cohort.id;
  perform public.financial_write_audit(
    v_cohort.origin_project_id, v_region_id, 'VERIFY_LEGACY_CARRYOVER_HISTORY',
    'project_budget_cohorts', v_cohort.id, v_actor_id,
    jsonb_build_object('legacy_prior_carryover_count', p_legacy_prior_carryover_count,
      'verification_note', btrim(p_verification_note))
  );
end;
$$;

-- While a cutover is being prepared or reviewed, legacy financial source values
-- are frozen. The trigger does not change rows; it only rejects concurrent writes.
create or replace function public.financial_block_legacy_financial_write_during_cutover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.financial_ledger_cutovers
    where status in ('PREPARING', 'REVIEWING')
  ) then
    raise exception using errcode = '55000', message = 'Legacy Baseline Cutover 중에는 기존 배분·집행 금액을 변경할 수 없습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_financial_cutover_freeze on public.projects;
create trigger projects_financial_cutover_freeze
  before update of alloc, exec, rate, original_alloc, increase_amount, decrease_amount on public.projects
  for each row execute function public.financial_block_legacy_financial_write_during_cutover();

create or replace function public.financial_validate_baseline_cutover()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline_as_of date;
begin
  select baseline_as_of into v_baseline_as_of
  from public.financial_ledger_cutovers where id = new.cutover_id;
  if v_baseline_as_of is null or new.baseline_as_of <> v_baseline_as_of then
    raise exception using errcode = '23514', message = 'Baseline 기준일은 Cutover 기준일과 일치해야 합니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists project_financial_baselines_validate_cutover on public.project_financial_baselines;
create trigger project_financial_baselines_validate_cutover
  before insert or update of cutover_id, baseline_as_of on public.project_financial_baselines
  for each row execute function public.financial_validate_baseline_cutover();

create or replace function public.financial_assert_post_baseline_effective_date(
  p_project_id uuid,
  p_effective_date date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_baseline_as_of date;
begin
  if p_effective_date is null then
    raise exception using errcode = '22023', message = '재정효력일은 필수입니다.';
  end if;
  select baselines.baseline_as_of into v_baseline_as_of
  from public.project_financial_baselines as baselines
  join public.financial_ledger_cutovers as cutovers on cutovers.id = baselines.cutover_id
  where baselines.project_id = p_project_id
    and baselines.verification_status = 'VERIFIED'
    and cutovers.status = 'CONFIRMED'
  order by baselines.created_at desc
  limit 1;
  if v_baseline_as_of is not null and p_effective_date <= v_baseline_as_of then
    raise exception using errcode = '23514',
      message = 'Cutover 이전 또는 Baseline 기준일의 재정거래는 일반 원장에 입력할 수 없습니다. Baseline Correction 절차를 사용하세요.';
  end if;
end;
$$;

create or replace function public.financial_enforce_post_cutover_effective_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_project_id uuid;
  v_destination_project_id uuid;
begin
  if tg_table_name = 'project_fund_transfers' then
    select project_id into v_source_project_id from public.project_budget_years where id = new.source_budget_year_id;
    select project_id into v_destination_project_id from public.project_budget_years where id = new.destination_budget_year_id;
    perform public.financial_assert_post_baseline_effective_date(v_source_project_id, new.effective_date);
    perform public.financial_assert_post_baseline_effective_date(v_destination_project_id, new.effective_date);
  elsif tg_table_name = 'project_execution_records' then
    select project_id into v_source_project_id from public.project_budget_years where id = new.budget_year_id;
    perform public.financial_assert_post_baseline_effective_date(v_source_project_id, new.execution_date);
  elsif tg_table_name = 'project_carryovers' then
    select project_id into v_source_project_id from public.project_budget_years where id = new.source_budget_year_id;
    select project_id into v_destination_project_id from public.project_budget_years where id = new.destination_budget_year_id;
    perform public.financial_assert_post_baseline_effective_date(v_source_project_id, new.effective_date);
    perform public.financial_assert_post_baseline_effective_date(v_destination_project_id, new.effective_date);
  elsif tg_table_name = 'project_budget_adjustments' then
    select project_id into v_source_project_id from public.project_budget_years where id = new.budget_year_id;
    perform public.financial_assert_post_baseline_effective_date(v_source_project_id, new.effective_date);
  end if;
  return new;
end;
$$;

drop trigger if exists project_fund_transfers_effective_date_guard on public.project_fund_transfers;
create trigger project_fund_transfers_effective_date_guard before insert on public.project_fund_transfers
  for each row execute function public.financial_enforce_post_cutover_effective_date();
drop trigger if exists project_execution_records_effective_date_guard on public.project_execution_records;
create trigger project_execution_records_effective_date_guard before insert on public.project_execution_records
  for each row execute function public.financial_enforce_post_cutover_effective_date();
drop trigger if exists project_carryovers_effective_date_guard on public.project_carryovers;
create trigger project_carryovers_effective_date_guard before insert on public.project_carryovers
  for each row execute function public.financial_enforce_post_cutover_effective_date();
drop trigger if exists project_budget_adjustments_effective_date_guard on public.project_budget_adjustments;
create trigger project_budget_adjustments_effective_date_guard before insert on public.project_budget_adjustments
  for each row execute function public.financial_enforce_post_cutover_effective_date();

-- Baseline execution is a snapshot component, not a synthetic execution row.
create or replace function public.financial_get_budget_year_balance(p_budget_year_id uuid)
returns table (accounting_balance bigint, reserved_amount bigint, available_to_commit bigint)
language sql
stable
security definer
set search_path = public
as $$
  with wallet as (
    select id, project_id, budget_cohort_id, fiscal_year, legacy_baseline_id
    from public.project_budget_years where id = p_budget_year_id
  ), components as (
    select
      coalesce((select sum(cohorts.initial_allocation)::numeric
        from public.project_budget_cohorts as cohorts
        join wallet on wallet.budget_cohort_id = cohorts.id
        where (cohorts.source_type = 'STANDARD'
               and cohorts.origin_project_id = wallet.project_id
               and cohorts.origin_fiscal_year = wallet.fiscal_year)
           -- A Legacy Baseline cohort has UNKNOWN origin_fiscal_year. Count its
           -- initial amount only in its one baseline wallet, never again after
           -- a future transfer or carryover creates another wallet.
           or (cohorts.source_type = 'LEGACY_BASELINE'
               and wallet.legacy_baseline_id is not null)), 0::numeric) as initial_amount,
      coalesce((select baselines.cumulative_execution::numeric from public.project_financial_baselines as baselines
        join wallet on wallet.legacy_baseline_id = baselines.id), 0::numeric) as baseline_execution,
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where destination_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as transfer_in,
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where source_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as transfer_out,
      coalesce((select sum(amount)::numeric from public.project_carryovers
        where destination_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as carryover_in,
      coalesce((select sum(amount)::numeric from public.project_carryovers
        where source_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as carryover_out,
      coalesce((select sum(case when transaction_kind = 'REVERSAL' then amount::numeric else -amount::numeric end)
        from public.project_execution_records where budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as execution_effect,
      coalesce((select sum((case adjustment_type when 'CORRECTION_INCREASE' then amount::numeric else -amount::numeric end)
        * case when transaction_kind = 'REVERSAL' then -1 else 1 end)
        from public.project_budget_adjustments where budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as adjustment_effect,
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where source_budget_year_id = p_budget_year_id and status = 'PENDING_APPROVAL'), 0::numeric) as pending_reservation
  ), totals as (
    select initial_amount - baseline_execution + transfer_in - transfer_out + carryover_in - carryover_out
      + execution_effect + adjustment_effect as accounting_amount, pending_reservation from components
  ) select accounting_amount::bigint, pending_reservation::bigint,
    (accounting_amount - pending_reservation)::bigint from totals;
$$;

create or replace function public.financial_create_ledger_cutover(
  p_operating_start_date date,
  p_memo text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_actor_id uuid; v_cutover_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if p_operating_start_date is null then raise exception using errcode = '22023', message = 'Ledger 운영 시작일은 필수입니다.'; end if;
  if exists (select 1 from public.financial_ledger_cutovers where status in ('PREPARING', 'REVIEWING', 'CONFIRMED')) then
    raise exception using errcode = '23505', message = '진행 중이거나 확정된 Ledger Cutover가 이미 있습니다.';
  end if;
  insert into public.financial_ledger_cutovers (operating_start_date, baseline_as_of, status, created_by, memo)
  values (p_operating_start_date, p_operating_start_date - 1, 'PREPARING', v_actor_id, nullif(btrim(p_memo), ''))
  returning id into v_cutover_id;
  return v_cutover_id;
end;
$$;

create or replace function public.financial_prepare_legacy_baselines(p_cutover_id uuid)
returns table (baseline_candidates integer, auto_excluded integer, needs_review integer)
language plpgsql
security definer
set search_path = public
as $$
declare v_actor_id uuid; v_baseline_as_of date;
begin
  v_actor_id := public.financial_require_admin();
  select baseline_as_of into v_baseline_as_of from public.financial_ledger_cutovers
  where id = p_cutover_id and status = 'PREPARING' for update;
  if v_baseline_as_of is null then raise exception using errcode = '23514', message = 'PREPARING 상태의 Cutover만 Baseline snapshot을 만들 수 있습니다.'; end if;
  lock table public.projects in share row exclusive mode;
  insert into public.project_financial_baselines (
    cutover_id, project_id, baseline_as_of, original_allocation, adjusted_allocation,
    cumulative_execution, verification_status, verification_note, source_type, source_snapshot
  )
  select p_cutover_id, projects.id, v_baseline_as_of, projects.original_alloc, projects.alloc, projects.exec,
    'NEEDS_REVIEW',
    case when projects.project_code is null then '공식 원장 식별코드 없음: 테스트로 간주하지 않고 관리자 검토 대기'
         when projects.alloc is null or projects.exec is null then '조정배분액 또는 누적집행액 NULL'
         when projects.alloc < 0 or projects.exec < 0 then '음수 재정값'
         else '자동 대사 대기' end,
    'LEGACY_BASELINE',
    jsonb_build_object('project_id', projects.project_id, 'project_code', projects.project_code,
      'original_alloc', projects.original_alloc, 'alloc', projects.alloc, 'exec', projects.exec,
      'captured_at', clock_timestamp())
  from public.projects as projects
  on conflict (cutover_id, project_id) do nothing;
  update public.financial_ledger_cutovers set status = 'REVIEWING' where id = p_cutover_id;
  return query select
    count(*)::integer,
    0::integer,
    count(*) filter (where baselines.verification_status = 'NEEDS_REVIEW')::integer
  from public.project_financial_baselines as baselines
  join public.projects as projects on projects.id = baselines.project_id
  where baselines.cutover_id = p_cutover_id;
end;
$$;

-- A code-less project is not a test project.  It remains NEEDS_REVIEW until an
-- administrator explicitly verifies it or approves a documented exclusion.
create or replace function public.financial_review_legacy_baseline(
  p_baseline_id uuid,
  p_verification_status text,
  p_verification_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_cutover_id uuid;
  v_baseline public.project_financial_baselines%rowtype;
  v_region_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if p_verification_status is null or p_verification_status not in ('VERIFIED', 'EXCLUDED')
     or char_length(btrim(coalesce(p_verification_note, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'VERIFIED 또는 EXCLUDED 상태와 검토 근거 메모는 필수입니다.';
  end if;

  select cutover_id into v_cutover_id
  from public.project_financial_baselines
  where id = p_baseline_id;
  if v_cutover_id is null then
    raise exception using errcode = 'P0002', message = '검토할 Legacy Baseline을 찾을 수 없습니다.';
  end if;
  perform 1 from public.financial_ledger_cutovers
  where id = v_cutover_id and status = 'REVIEWING'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'REVIEWING 상태의 Cutover Baseline만 검토할 수 있습니다.';
  end if;
  select * into v_baseline
  from public.project_financial_baselines
  where id = p_baseline_id
  for update;
  if not found or v_baseline.verification_status <> 'NEEDS_REVIEW' then
    raise exception using errcode = '23514', message = 'NEEDS_REVIEW 상태의 Legacy Baseline만 한 번 검토할 수 있습니다.';
  end if;
  select region_id into v_region_id
  from public.projects
  where id = v_baseline.project_id;
  if p_verification_status = 'VERIFIED'
     and (v_baseline.adjusted_allocation is null or v_baseline.cumulative_execution is null
          or v_baseline.adjusted_allocation < 0 or v_baseline.cumulative_execution < 0
          or v_baseline.cumulative_execution > v_baseline.adjusted_allocation) then
    raise exception using errcode = '23514', message = 'VERIFIED Baseline에는 0 이상이며 누적집행액을 포괄하는 조정배분액이 필요합니다.';
  end if;

  update public.project_financial_baselines
  set verification_status = p_verification_status,
      verification_note = btrim(p_verification_note),
      verified_by = v_actor_id,
      verified_at = clock_timestamp()
  where id = v_baseline.id;
  perform public.financial_write_audit(
    v_baseline.project_id, v_region_id, 'REVIEW_LEGACY_BASELINE',
    'project_financial_baselines', v_baseline.id, v_actor_id,
    jsonb_build_object('verification_status', p_verification_status,
      'verification_note', btrim(p_verification_note))
  );
end;
$$;

create or replace function public.financial_verify_reconciled_legacy_baselines(p_cutover_id uuid)
returns table (verified_count integer, remaining_needs_review integer)
language plpgsql
security definer
set search_path = public
as $$
declare v_actor_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  perform 1 from public.financial_ledger_cutovers where id = p_cutover_id and status = 'REVIEWING' for update;
  if not found then raise exception using errcode = '23514', message = 'REVIEWING 상태의 Cutover만 자동 대사 검증할 수 있습니다.'; end if;
  -- project_code only gates automatic reconciliation. It never classifies a
  -- project as a test row or EXCLUDED; code-less rows remain NEEDS_REVIEW for
  -- the administrator's explicit VERIFIED/EXCLUDED decision.
  update public.project_financial_baselines as baselines
  set verification_status = 'VERIFIED', verified_by = v_actor_id, verified_at = clock_timestamp(), verification_note = 'Cutover freeze 중 projects 값과 자동 대사 완료'
  from public.projects as projects
  where baselines.cutover_id = p_cutover_id and baselines.project_id = projects.id
    and baselines.verification_status = 'NEEDS_REVIEW' and projects.project_code is not null
    and baselines.adjusted_allocation is not distinct from projects.alloc
    and baselines.cumulative_execution is not distinct from projects.exec
    and projects.alloc is not null and projects.exec is not null
    and projects.alloc >= 0 and projects.exec >= 0
    and projects.exec <= projects.alloc;
  return query select
    count(*) filter (where verification_status = 'VERIFIED')::integer,
    count(*) filter (where verification_status = 'NEEDS_REVIEW')::integer
  from public.project_financial_baselines where cutover_id = p_cutover_id;
end;
$$;

create or replace function public.financial_capture_project_metadata_history(
  p_project_id uuid,
  p_cutover_id uuid,
  p_effective_date date,
  p_event_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_metadata_history (project_id, cutover_id, effective_date, event_type, snapshot, changed_by)
  select projects.id, p_cutover_id, p_effective_date, p_event_type,
    jsonb_build_object(
      'project_name', projects.project_name,
      'fund_project_name', projects.fund_project_name,
      'detail_project_name', projects.detail_project_name,
      'status', projects.status,
      'region_id', projects.region_id,
      'sido', projects.sido,
      'sigungu', projects.sigungu,
      'region_type', projects.region_type,
      'large_category_id', projects.large_category_id,
      'middle_category_id', projects.middle_category_id,
      'business_type', projects.business_type,
      'standard_small_category_ids', coalesce((select jsonb_agg(small_category_id order by small_category_id)
        from public.project_small_categories where project_id = projects.id), '[]'::jsonb),
      'custom_small_categories', coalesce((select jsonb_agg(input_value order by id)
        from public.project_custom_small_categories where project_id = projects.id and validation_status = 'CONFIRMED'), '[]'::jsonb)
    ), auth.uid()
  from public.projects where id = p_project_id;
end;
$$;

create or replace function public.financial_metadata_history_project_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cutover_id uuid;
begin
  if old.status is not distinct from new.status
     and old.large_category_id is not distinct from new.large_category_id
     and old.middle_category_id is not distinct from new.middle_category_id
     and old.business_type is not distinct from new.business_type
     and old.project_name is not distinct from new.project_name
     and old.fund_project_name is not distinct from new.fund_project_name
     and old.detail_project_name is not distinct from new.detail_project_name
     and old.region_id is not distinct from new.region_id
     and old.sido is not distinct from new.sido
     and old.sigungu is not distinct from new.sigungu
     and old.region_type is not distinct from new.region_type then
    return new;
  end if;
  select baselines.cutover_id into v_cutover_id
  from public.project_financial_baselines as baselines
  join public.financial_ledger_cutovers as cutovers on cutovers.id = baselines.cutover_id
  where baselines.project_id = new.id and baselines.verification_status = 'VERIFIED' and cutovers.status = 'CONFIRMED'
  limit 1;
  if v_cutover_id is not null then
    perform public.financial_capture_project_metadata_history(new.id, v_cutover_id,
      timezone('Asia/Seoul', clock_timestamp())::date, 'PROJECT_UPDATE');
  end if;
  return new;
end;
$$;

create or replace function public.financial_metadata_history_small_category_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_project_id uuid; v_cutover_id uuid;
begin
  if tg_op = 'DELETE' then v_project_id := old.project_id; else v_project_id := new.project_id; end if;
  select baselines.cutover_id into v_cutover_id
  from public.project_financial_baselines as baselines
  join public.financial_ledger_cutovers as cutovers on cutovers.id = baselines.cutover_id
  where baselines.project_id = v_project_id and baselines.verification_status = 'VERIFIED' and cutovers.status = 'CONFIRMED'
  limit 1;
  if v_cutover_id is not null then
    perform public.financial_capture_project_metadata_history(v_project_id, v_cutover_id,
      timezone('Asia/Seoul', clock_timestamp())::date, 'SMALL_CATEGORY_UPDATE');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists projects_metadata_history_after_cutover on public.projects;
create trigger projects_metadata_history_after_cutover
  after update of status, large_category_id, middle_category_id, business_type, project_name, fund_project_name,
    detail_project_name, region_id, sido, sigungu, region_type on public.projects
  for each row
  execute function public.financial_metadata_history_project_trigger();
drop trigger if exists project_small_categories_metadata_history_after_cutover on public.project_small_categories;
create trigger project_small_categories_metadata_history_after_cutover
  after insert or update or delete on public.project_small_categories
  for each row execute function public.financial_metadata_history_small_category_trigger();
drop trigger if exists project_custom_small_categories_metadata_history_after_cutover on public.project_custom_small_categories;
create trigger project_custom_small_categories_metadata_history_after_cutover
  after insert or update or delete on public.project_custom_small_categories
  for each row execute function public.financial_metadata_history_small_category_trigger();

create or replace function public.financial_confirm_ledger_cutover(p_cutover_id uuid)
returns table (confirmed_baselines integer, excluded_baselines integer)
language plpgsql
security definer
set search_path = public
as $$
declare v_actor_id uuid; v_cutover record; v_baseline record; v_cohort_id uuid; v_budget_year_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_cutover from public.financial_ledger_cutovers where id = p_cutover_id and status = 'REVIEWING' for update;
  if not found then raise exception using errcode = '23514', message = 'REVIEWING 상태의 Cutover만 확정할 수 있습니다.'; end if;
  if exists (
    select 1 from public.projects as projects left join public.project_financial_baselines as baselines
      on baselines.cutover_id = p_cutover_id and baselines.project_id = projects.id
    where baselines.id is null
      or baselines.verification_status not in ('VERIFIED', 'EXCLUDED')
  ) then raise exception using errcode = '23514', message = '모든 사업 Baseline은 VERIFIED 또는 관리자 승인 EXCLUDED 상태여야 합니다.'; end if;
  for v_baseline in select * from public.project_financial_baselines
    where cutover_id = p_cutover_id and verification_status = 'VERIFIED' order by project_id
  loop
    insert into public.project_budget_cohorts (
      origin_project_id, origin_fiscal_year, initial_allocation, allocation_type, source_type,
      legacy_carryover_status, memo, idempotency_key, created_by
    ) values (
      v_baseline.project_id, null, v_baseline.adjusted_allocation,
      'INITIAL', 'LEGACY_BASELINE', 'UNKNOWN',
      'Legacy Baseline Cutover ' || v_cutover.baseline_as_of::text, gen_random_uuid(), v_actor_id
    ) returning id into v_cohort_id;
    insert into public.project_budget_years (project_id, budget_cohort_id, fiscal_year, legacy_baseline_id, created_by)
    values (v_baseline.project_id, v_cohort_id, extract(year from v_cutover.baseline_as_of)::integer, v_baseline.id, v_actor_id)
    returning id into v_budget_year_id;
    update public.project_financial_baselines set ledger_budget_year_id = v_budget_year_id where id = v_baseline.id;
  end loop;
  update public.financial_ledger_cutovers
  set status = 'CONFIRMED', confirmed_by = v_actor_id, confirmed_at = clock_timestamp()
  where id = p_cutover_id;
  for v_baseline in select * from public.project_financial_baselines where cutover_id = p_cutover_id and verification_status = 'VERIFIED'
  loop
    perform public.financial_capture_project_metadata_history(v_baseline.project_id, p_cutover_id,
      v_cutover.baseline_as_of, 'CUTOVER_SNAPSHOT');
  end loop;
  return query select
    count(*) filter (where verification_status = 'VERIFIED')::integer,
    count(*) filter (where verification_status = 'EXCLUDED')::integer
  from public.project_financial_baselines where cutover_id = p_cutover_id;
end;
$$;

drop function if exists public.create_execution_reversal(uuid, bigint, text, uuid);
create function public.create_execution_reversal(
  p_original_execution_id uuid, p_amount bigint, p_memo text, p_execution_date date, p_idempotency_key uuid
)
returns table (execution_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare v_actor_id uuid; v_role text; v_original public.project_execution_records%rowtype;
  v_reversal public.project_execution_records%rowtype; v_reversed_amount bigint; v_project_id uuid; v_region_id uuid;
begin
  select actor_id, actor_role into v_actor_id, v_role from public.financial_require_actor();
  if v_role <> 'admin' then raise exception using errcode = '42501', message = '집행 reversal은 관리자만 생성할 수 있습니다.'; end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_execution_date is null then raise exception using errcode = '22023', message = '집행 reversal 금액, 효력일, 요청키는 필수입니다.'; end if;
  select * into v_reversal from public.project_execution_records where idempotency_key = p_idempotency_key;
  if found then return query select v_reversal.id, v_reversal.status; return; end if;
  select * into v_original from public.project_execution_records where id = p_original_execution_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then raise exception using errcode = '23514', message = '확정된 일반 집행만 reversal할 수 있습니다.'; end if;
  perform 1 from public.project_budget_years where id = v_original.budget_year_id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount from public.project_execution_records where reversal_of = v_original.id and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then raise exception using errcode = '23514', message = '원 집행의 미반전 금액을 초과할 수 없습니다.'; end if;
  insert into public.project_execution_records (budget_year_id, amount, execution_date, status, transaction_kind, reversal_of, memo, idempotency_key, created_by, confirmed_by, confirmed_at)
  values (v_original.budget_year_id, p_amount, p_execution_date, 'CONFIRMED', 'REVERSAL', v_original.id, nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()) returning * into v_reversal;
  select projects.id, projects.region_id into v_project_id, v_region_id from public.project_budget_years wallet join public.projects projects on projects.id = wallet.project_id where wallet.id = v_original.budget_year_id;
  perform public.financial_write_audit(v_project_id, v_region_id, 'EXECUTION_REVERSED', 'project_execution_records', v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount, 'execution_date', p_execution_date));
  return query select v_reversal.id, v_reversal.status;
end;
$$;

drop function if exists public.create_budget_adjustment_reversal(uuid, bigint, text, uuid);
create function public.create_budget_adjustment_reversal(
  p_original_adjustment_id uuid, p_amount bigint, p_memo text, p_effective_date date, p_idempotency_key uuid
)
returns table (adjustment_id uuid, status text)
language plpgsql security definer set search_path = public as $$
declare v_actor_id uuid; v_role text; v_original public.project_budget_adjustments%rowtype;
  v_reversal public.project_budget_adjustments%rowtype; v_reversed_amount bigint; v_project_id uuid; v_region_id uuid;
begin
  select actor_id, actor_role into v_actor_id, v_role from public.financial_require_actor();
  if v_role <> 'admin' then raise exception using errcode = '42501', message = '예산 조정 reversal은 관리자만 생성할 수 있습니다.'; end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null then raise exception using errcode = '22023', message = '조정 reversal 금액, 효력일, 요청키는 필수입니다.'; end if;
  select * into v_reversal from public.project_budget_adjustments where idempotency_key = p_idempotency_key;
  if found then return query select v_reversal.id, v_reversal.status; return; end if;
  select * into v_original from public.project_budget_adjustments where id = p_original_adjustment_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then raise exception using errcode = '23514', message = '확정된 일반 조정만 reversal할 수 있습니다.'; end if;
  perform 1 from public.project_budget_years where id = v_original.budget_year_id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount from public.project_budget_adjustments where reversal_of = v_original.id and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then raise exception using errcode = '23514', message = '원 조정의 미반전 금액을 초과할 수 없습니다.'; end if;
  if v_original.adjustment_type = 'CORRECTION_INCREASE' then perform public.financial_require_available_amount(v_original.budget_year_id, p_amount, '사용가능 재원이 부족하여 조정 reversal을 확정할 수 없습니다.'); end if;
  insert into public.project_budget_adjustments (budget_year_id, adjustment_type, amount, status, transaction_kind, reversal_of, reason_code, memo, effective_date, idempotency_key, created_by, confirmed_by, confirmed_at)
  values (v_original.budget_year_id, v_original.adjustment_type, p_amount, 'CONFIRMED', 'REVERSAL', v_original.id, 'REVERSAL', nullif(btrim(p_memo), ''), p_effective_date, p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()) returning * into v_reversal;
  select projects.id, projects.region_id into v_project_id, v_region_id from public.project_budget_years wallet join public.projects projects on projects.id = wallet.project_id where wallet.id = v_original.budget_year_id;
  perform public.financial_write_audit(v_project_id, v_region_id, 'BUDGET_ADJUSTMENT_REVERSED', 'project_budget_adjustments', v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount, 'effective_date', p_effective_date));
  return query select v_reversal.id, v_reversal.status;
end;
$$;

-- Existing carryover RPCs did not accept an effective date. Replace them before
-- granting access so an input date is mandatory for both normal and reversal rows.
drop function if exists public.create_carryover(uuid, uuid, bigint, text, uuid);
create function public.create_carryover(
  p_source_budget_year_id uuid, p_destination_project_id uuid, p_amount bigint,
  p_memo text, p_effective_date date, p_idempotency_key uuid
)
returns table (carryover_id uuid, carryover_type text, carryover_sequence smallint)
language plpgsql security definer set search_path = public as $$
declare v_actor_id uuid; v_role text; v_source public.project_budget_years%rowtype; v_source_region_id uuid;
  v_destination_region_id uuid; v_destination_year integer; v_destination_budget_year_id uuid;
  v_origin_year integer; v_legacy_status text; v_legacy_prior_count smallint; v_legacy_baseline_fiscal_year integer;
  v_sequence smallint; v_type text; v_carryover public.project_carryovers%rowtype;
begin
  select actor_id, actor_role into v_actor_id, v_role from public.financial_require_actor();
  if v_role <> 'admin' then raise exception using errcode = '42501', message = '이월 처리는 관리자만 확정할 수 있습니다.'; end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null then raise exception using errcode = '22023', message = '이월 금액, 효력일, 요청키는 필수입니다.'; end if;
  select * into v_carryover from public.project_carryovers where idempotency_key = p_idempotency_key;
  if found then return query select v_carryover.id, v_carryover.carryover_type, v_carryover.carryover_sequence; return; end if;
  select * into v_source from public.project_budget_years where id = p_source_budget_year_id;
  if not found then raise exception using errcode = 'P0002', message = '이월 원천 재원 위치를 찾을 수 없습니다.'; end if;
  select region_id into v_source_region_id from public.projects where id = v_source.project_id;
  select region_id, year into v_destination_region_id, v_destination_year from public.projects where id = p_destination_project_id and project_code is not null;
  if v_destination_region_id is null or v_destination_region_id <> v_source_region_id or v_destination_year is distinct from v_source.fiscal_year + 1 then raise exception using errcode = '23514', message = '이월 수신 사업은 동일 지역의 다음 회계연도 사업이어야 합니다.'; end if;
  select origin_fiscal_year, legacy_carryover_status, legacy_prior_carryover_count
    into v_origin_year, v_legacy_status, v_legacy_prior_count
  from public.project_budget_cohorts where id = v_source.budget_cohort_id;
  if v_origin_year is not null then
    v_sequence := v_destination_year - v_origin_year;
  else
    if v_legacy_status is distinct from 'VERIFIED' or v_legacy_prior_count is null then
      raise exception using errcode = '55000',
        message = 'UNKNOWN Legacy Baseline 재원은 증빙 기반 관리자 검증 전에는 이월할 수 없습니다.';
    end if;
    select fiscal_year into v_legacy_baseline_fiscal_year
    from public.project_budget_years
    where budget_cohort_id = v_source.budget_cohort_id and legacy_baseline_id is not null;
    if v_legacy_baseline_fiscal_year is null then
      raise exception using errcode = '23503', message = 'Legacy Baseline 기준 재원 위치를 찾을 수 없습니다.';
    end if;
    v_sequence := v_legacy_prior_count + (v_source.fiscal_year - v_legacy_baseline_fiscal_year) + 1;
  end if;
  if v_sequence not in (1, 2) then raise exception using errcode = '23514', message = '확정된 이월이력 기준으로 최대 2회까지만 이월할 수 있습니다.'; end if;
  v_type := case when v_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
  v_destination_budget_year_id := public.financial_get_or_create_budget_year(p_destination_project_id, v_source.budget_cohort_id, v_destination_year, v_actor_id);
  perform 1 from public.project_budget_years where id = any(array[p_source_budget_year_id, v_destination_budget_year_id]) order by id for update;
  perform public.financial_require_available_amount(p_source_budget_year_id, p_amount, '예약액을 반영한 사용가능 재원이 부족하여 이월할 수 없습니다.');
  insert into public.project_carryovers (source_budget_year_id, destination_budget_year_id, amount, carryover_sequence, carryover_type, status, transaction_kind, memo, effective_date, idempotency_key, created_by, confirmed_by, confirmed_at)
  values (p_source_budget_year_id, v_destination_budget_year_id, p_amount, v_sequence, v_type, 'CONFIRMED', 'NORMAL', nullif(btrim(p_memo), ''), p_effective_date, p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()) returning * into v_carryover;
  perform public.financial_write_audit(v_source.project_id, v_source_region_id, 'CARRYOVER_CONFIRMED', 'project_carryovers', v_carryover.id, v_actor_id, jsonb_build_object('amount', p_amount, 'effective_date', p_effective_date, 'carryover_type', v_type));
  return query select v_carryover.id, v_carryover.carryover_type, v_carryover.carryover_sequence;
end;
$$;

drop function if exists public.create_carryover_reversal(uuid, bigint, text, uuid);
create function public.create_carryover_reversal(
  p_original_carryover_id uuid, p_amount bigint, p_memo text, p_effective_date date, p_idempotency_key uuid
)
returns table (carryover_id uuid, carryover_type text, carryover_sequence smallint)
language plpgsql security definer set search_path = public as $$
declare v_actor_id uuid; v_role text; v_original public.project_carryovers%rowtype; v_reversal public.project_carryovers%rowtype; v_reversed_amount bigint; v_project_id uuid; v_region_id uuid;
begin
  select actor_id, actor_role into v_actor_id, v_role from public.financial_require_actor();
  if v_role <> 'admin' then raise exception using errcode = '42501', message = '이월 reversal은 관리자만 생성할 수 있습니다.'; end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null then raise exception using errcode = '22023', message = '이월 reversal 금액, 효력일, 요청키는 필수입니다.'; end if;
  select * into v_reversal from public.project_carryovers where idempotency_key = p_idempotency_key;
  if found then return query select v_reversal.id, v_reversal.carryover_type, v_reversal.carryover_sequence; return; end if;
  select * into v_original from public.project_carryovers where id = p_original_carryover_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then raise exception using errcode = '23514', message = '확정된 일반 이월만 reversal할 수 있습니다.'; end if;
  perform 1 from public.project_budget_years where id = any(array[v_original.source_budget_year_id, v_original.destination_budget_year_id]) order by id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount from public.project_carryovers where reversal_of = v_original.id and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then raise exception using errcode = '23514', message = '원 이월의 미반전 금액을 초과할 수 없습니다.'; end if;
  perform public.financial_require_available_amount(v_original.destination_budget_year_id, p_amount, '이월 수신 사업의 사용가능 재원이 부족하여 reversal할 수 없습니다.');
  insert into public.project_carryovers (source_budget_year_id, destination_budget_year_id, amount, carryover_sequence, carryover_type, status, transaction_kind, reversal_of, memo, effective_date, idempotency_key, created_by, confirmed_by, confirmed_at)
  values (v_original.destination_budget_year_id, v_original.source_budget_year_id, p_amount, v_original.carryover_sequence, v_original.carryover_type, 'CONFIRMED', 'REVERSAL', v_original.id, nullif(btrim(p_memo), ''), p_effective_date, p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()) returning * into v_reversal;
  select projects.id, projects.region_id into v_project_id, v_region_id from public.project_budget_years wallet join public.projects projects on projects.id = wallet.project_id where wallet.id = v_reversal.source_budget_year_id;
  perform public.financial_write_audit(v_project_id, v_region_id, 'CARRYOVER_REVERSED', 'project_carryovers', v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount, 'effective_date', p_effective_date));
  return query select v_reversal.id, v_reversal.carryover_type, v_reversal.carryover_sequence;
end;
$$;

alter table public.financial_ledger_cutovers enable row level security;
alter table public.project_financial_baselines enable row level security;
alter table public.project_baseline_corrections enable row level security;
alter table public.project_metadata_history enable row level security;

create policy financial_ledger_cutovers_select_admin on public.financial_ledger_cutovers for select to authenticated using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);
create policy project_financial_baselines_select_region_or_admin on public.project_financial_baselines for select to authenticated using (
  exists (select 1 from public.projects join public.profiles on profiles.id = auth.uid()
    where projects.id = project_financial_baselines.project_id and (profiles.role = 'admin' or profiles.region_id = projects.region_id))
);
create policy project_baseline_corrections_select_admin on public.project_baseline_corrections for select to authenticated using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);
create policy project_metadata_history_select_region_or_admin on public.project_metadata_history for select to authenticated using (
  exists (select 1 from public.projects join public.profiles on profiles.id = auth.uid()
    where projects.id = project_metadata_history.project_id and (profiles.role = 'admin' or profiles.region_id = projects.region_id))
);

revoke all on table public.financial_ledger_cutovers, public.project_financial_baselines,
  public.project_baseline_corrections, public.project_metadata_history from anon, authenticated;
grant select on public.financial_ledger_cutovers, public.project_financial_baselines,
  public.project_baseline_corrections, public.project_metadata_history to authenticated;

revoke all on function public.financial_require_admin() from public, anon, authenticated;
revoke all on function public.financial_block_legacy_financial_write_during_cutover() from public, anon, authenticated;
revoke all on function public.financial_validate_baseline_cutover() from public, anon, authenticated;
revoke all on function public.financial_assert_post_baseline_effective_date(uuid, date) from public, anon, authenticated;
revoke all on function public.financial_enforce_post_cutover_effective_date() from public, anon, authenticated;
revoke all on function public.financial_capture_project_metadata_history(uuid, uuid, date, text) from public, anon, authenticated;
revoke all on function public.financial_metadata_history_project_trigger() from public, anon, authenticated;
revoke all on function public.financial_metadata_history_small_category_trigger() from public, anon, authenticated;
revoke all on function public.financial_create_ledger_cutover(date, text) from public, anon;
revoke all on function public.financial_prepare_legacy_baselines(uuid) from public, anon;
revoke all on function public.financial_verify_reconciled_legacy_baselines(uuid) from public, anon;
revoke all on function public.financial_review_legacy_baseline(uuid, text, text) from public, anon;
revoke all on function public.financial_confirm_ledger_cutover(uuid) from public, anon;
revoke all on function public.verify_legacy_carryover_history(uuid, smallint, text) from public, anon;
revoke all on function public.create_carryover(uuid, uuid, bigint, text, date, uuid) from public, anon;
revoke all on function public.create_carryover_reversal(uuid, bigint, text, date, uuid) from public, anon;
revoke all on function public.create_execution_reversal(uuid, bigint, text, date, uuid) from public, anon;
revoke all on function public.create_budget_adjustment_reversal(uuid, bigint, text, date, uuid) from public, anon;
grant execute on function public.financial_create_ledger_cutover(date, text) to authenticated;
grant execute on function public.financial_prepare_legacy_baselines(uuid) to authenticated;
grant execute on function public.financial_verify_reconciled_legacy_baselines(uuid) to authenticated;
grant execute on function public.financial_review_legacy_baseline(uuid, text, text) to authenticated;
grant execute on function public.financial_confirm_ledger_cutover(uuid) to authenticated;
grant execute on function public.verify_legacy_carryover_history(uuid, smallint, text) to authenticated;
grant execute on function public.create_carryover(uuid, uuid, bigint, text, date, uuid) to authenticated;
grant execute on function public.create_carryover_reversal(uuid, bigint, text, date, uuid) to authenticated;
grant execute on function public.create_execution_reversal(uuid, bigint, text, date, uuid) to authenticated;
grant execute on function public.create_budget_adjustment_reversal(uuid, bigint, text, date, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
