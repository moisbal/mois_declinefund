-- DRAFT MIGRATION ONLY. Review and run manually in the Supabase SQL editor.
--
-- Purpose: add an immutable, cohort-based financial ledger without changing
-- legacy projects.alloc / projects.exec / projects.rate or converting existing
-- imported rows. Existing project values remain display/reference values until
-- an administrator explicitly creates a budget cohort for a project.
--
-- Safety decisions based on the current application:
--   * projects are row-level/year-level imported records (project_code is unique).
--   * there is no existing cross-region transfer approval workflow.
--   * therefore cross-region transfers are blocked by the RPCs, including admins,
--     until an approved business rule and a two-party workflow are introduced.
--   * transfer submission creates a PENDING_APPROVAL reservation; only an admin
--     can confirm it. Executions, carryovers, and adjustments are confirmed only
--     through their dedicated RPCs.

begin;

create extension if not exists "pgcrypto";

create table if not exists public.project_budget_cohorts (
  id uuid primary key default gen_random_uuid(),
  origin_project_id uuid not null references public.projects(id) on delete restrict,
  -- NULL is reserved for LEGACY_BASELINE cohorts whose original allocation year
  -- cannot be evidenced. STANDARD cohorts remain validated by the creation RPC
  -- and by the source-type constraint added in migration 19.
  origin_fiscal_year integer check (origin_fiscal_year is null or origin_fiscal_year between 2000 and 2200),
  -- A zero amount is valid only for a verified Legacy Baseline snapshot. The
  -- STANDARD-cohort rule remains enforced by the source-type constraint in 19
  -- and by create_project_budget_cohort().
  initial_allocation bigint not null check (initial_allocation >= 0),
  allocation_type text not null check (allocation_type in ('INITIAL', 'EXTERNAL_INCREASE')),
  memo text,
  idempotency_key uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint project_budget_cohorts_memo_length_check check (memo is null or char_length(memo) <= 1000)
);

create table if not exists public.project_budget_years (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  budget_cohort_id uuid not null references public.project_budget_cohorts(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  unique (project_id, budget_cohort_id, fiscal_year)
);

create table if not exists public.project_fund_transfers (
  id uuid primary key default gen_random_uuid(),
  source_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  destination_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  amount bigint not null check (amount > 0),
  status text not null check (status in ('DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'REJECTED', 'WITHDRAWN')),
  transaction_kind text not null check (transaction_kind in ('NORMAL', 'REVERSAL')),
  reversal_of uuid references public.project_fund_transfers(id) on delete restrict,
  reason_code text,
  memo text,
  effective_date date not null,
  idempotency_key uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  submitted_at timestamptz,
  confirmed_by uuid references public.profiles(id) on delete restrict,
  confirmed_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  withdrawn_by uuid references public.profiles(id) on delete restrict,
  withdrawn_at timestamptz,
  resolution_note text,
  constraint project_fund_transfers_distinct_wallets_check check (source_budget_year_id <> destination_budget_year_id),
  constraint project_fund_transfers_reversal_shape_check check (
    (transaction_kind = 'NORMAL' and reversal_of is null)
    or (transaction_kind = 'REVERSAL' and reversal_of is not null and reversal_of <> id)
  ),
  constraint project_fund_transfers_text_length_check check (
    (reason_code is null or char_length(reason_code) <= 100)
    and (memo is null or char_length(memo) <= 1000)
    and (resolution_note is null or char_length(resolution_note) <= 1000)
  )
);

create table if not exists public.project_execution_records (
  id uuid primary key default gen_random_uuid(),
  budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  amount bigint not null check (amount > 0),
  execution_date date not null,
  status text not null check (status in ('CONFIRMED')),
  transaction_kind text not null check (transaction_kind in ('NORMAL', 'REVERSAL')),
  reversal_of uuid references public.project_execution_records(id) on delete restrict,
  memo text,
  idempotency_key uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default clock_timestamp(),
  constraint project_execution_records_reversal_shape_check check (
    (transaction_kind = 'NORMAL' and reversal_of is null)
    or (transaction_kind = 'REVERSAL' and reversal_of is not null and reversal_of <> id)
  ),
  constraint project_execution_records_memo_length_check check (memo is null or char_length(memo) <= 1000)
);

create table if not exists public.project_carryovers (
  id uuid primary key default gen_random_uuid(),
  source_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  destination_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  amount bigint not null check (amount > 0),
  carryover_sequence smallint not null check (carryover_sequence between 1 and 2),
  carryover_type text not null check (carryover_type in ('MYEONGSI', 'SAGO')),
  status text not null check (status in ('CONFIRMED')),
  transaction_kind text not null check (transaction_kind in ('NORMAL', 'REVERSAL')),
  reversal_of uuid references public.project_carryovers(id) on delete restrict,
  memo text,
  idempotency_key uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default clock_timestamp(),
  constraint project_carryovers_distinct_wallets_check check (source_budget_year_id <> destination_budget_year_id),
  constraint project_carryovers_reversal_shape_check check (
    (transaction_kind = 'NORMAL' and reversal_of is null)
    or (transaction_kind = 'REVERSAL' and reversal_of is not null and reversal_of <> id)
  ),
  constraint project_carryovers_memo_length_check check (memo is null or char_length(memo) <= 1000)
);

create table if not exists public.project_budget_adjustments (
  id uuid primary key default gen_random_uuid(),
  budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  adjustment_type text not null check (
    adjustment_type in ('RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_INCREASE', 'CORRECTION_DECREASE')
  ),
  amount bigint not null check (amount > 0),
  status text not null check (status in ('CONFIRMED')),
  transaction_kind text not null check (transaction_kind in ('NORMAL', 'REVERSAL')),
  reversal_of uuid references public.project_budget_adjustments(id) on delete restrict,
  reason_code text,
  memo text,
  effective_date date not null,
  idempotency_key uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default clock_timestamp(),
  constraint project_budget_adjustments_reversal_shape_check check (
    (transaction_kind = 'NORMAL' and reversal_of is null)
    or (transaction_kind = 'REVERSAL' and reversal_of is not null and reversal_of <> id)
  ),
  constraint project_budget_adjustments_text_length_check check (
    (reason_code is null or char_length(reason_code) <= 100)
    and (memo is null or char_length(memo) <= 1000)
  )
);

create index if not exists idx_project_budget_cohorts_origin
  on public.project_budget_cohorts(origin_project_id, origin_fiscal_year);
create index if not exists idx_project_budget_years_project_fiscal
  on public.project_budget_years(project_id, fiscal_year);
create index if not exists idx_project_budget_years_cohort_fiscal
  on public.project_budget_years(budget_cohort_id, fiscal_year);
create index if not exists idx_project_fund_transfers_source_status
  on public.project_fund_transfers(source_budget_year_id, status);
create index if not exists idx_project_fund_transfers_destination_status
  on public.project_fund_transfers(destination_budget_year_id, status);
create index if not exists idx_project_fund_transfers_reversal
  on public.project_fund_transfers(reversal_of) where reversal_of is not null;
create index if not exists idx_project_execution_records_wallet_status
  on public.project_execution_records(budget_year_id, status);
create index if not exists idx_project_execution_records_reversal
  on public.project_execution_records(reversal_of) where reversal_of is not null;
create index if not exists idx_project_carryovers_source_status
  on public.project_carryovers(source_budget_year_id, status);
create index if not exists idx_project_carryovers_destination_status
  on public.project_carryovers(destination_budget_year_id, status);
create index if not exists idx_project_carryovers_reversal
  on public.project_carryovers(reversal_of) where reversal_of is not null;
create index if not exists idx_project_budget_adjustments_wallet_status
  on public.project_budget_adjustments(budget_year_id, status);
create index if not exists idx_project_budget_adjustments_reversal
  on public.project_budget_adjustments(reversal_of) where reversal_of is not null;

-- Wallet locations can never pre-date the cohort that they carry.
create or replace function public.financial_validate_budget_year_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origin_fiscal_year integer;
begin
  select origin_fiscal_year into v_origin_fiscal_year
  from public.project_budget_cohorts
  where id = new.budget_cohort_id;

  if not found then
    raise exception using errcode = '23503', message = '재원 cohort를 찾을 수 없습니다.';
  end if;
  if v_origin_fiscal_year is not null and new.fiscal_year < v_origin_fiscal_year then
    raise exception using errcode = '23514', message = '재원 위치의 회계연도는 최초 재원연도보다 이를 수 없습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists project_budget_years_validate_location on public.project_budget_years;
create trigger project_budget_years_validate_location
  before insert or update of budget_cohort_id, fiscal_year on public.project_budget_years
  for each row execute function public.financial_validate_budget_year_location();

-- Cross-wallet invariants cannot be expressed as CHECK constraints alone.
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
      select origin_fiscal_year into v_origin_year
      from public.project_budget_cohorts
      where id = v_source.budget_cohort_id;
      if v_origin_year is null then
        raise exception using errcode = '55000',
          message = '최초 배분연도 또는 과거 이월횟수가 확인되지 않은 Legacy Baseline 재원은 일반 이월로 처리할 수 없습니다. 관리자 검토 절차를 사용하세요.';
      end if;
      if v_destination.fiscal_year <> v_source.fiscal_year + 1 then
        raise exception using errcode = '23514', message = '이월 목적 회계연도는 원천 회계연도의 다음 연도여야 합니다.';
      end if;
      v_expected_sequence := v_destination.fiscal_year - v_origin_year;
      if v_expected_sequence not in (1, 2) or new.carryover_sequence <> v_expected_sequence then
        raise exception using errcode = '23514', message = '이월은 최초 재원연도 기준으로 최대 2회까지만 가능합니다.';
      end if;
      v_expected_type := case when v_expected_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
      if new.carryover_type <> v_expected_type then
        raise exception using errcode = '23514', message = '이월 유형은 cohort의 최초 재원연도를 기준으로 자동 결정됩니다.';
      end if;
    else
      select * into v_original
      from public.project_carryovers
      where id = new.reversal_of;
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

drop trigger if exists project_fund_transfers_validate_wallet_relationship on public.project_fund_transfers;
create trigger project_fund_transfers_validate_wallet_relationship
  before insert or update of source_budget_year_id, destination_budget_year_id, transaction_kind, reversal_of
  on public.project_fund_transfers
  for each row execute function public.financial_validate_wallet_relationship();

drop trigger if exists project_carryovers_validate_wallet_relationship on public.project_carryovers;
create trigger project_carryovers_validate_wallet_relationship
  before insert or update of source_budget_year_id, destination_budget_year_id, transaction_kind, reversal_of,
    carryover_sequence, carryover_type on public.project_carryovers
  for each row execute function public.financial_validate_wallet_relationship();

-- Confirmed ledger rows are immutable. Corrections use explicit reversal rows.
create or replace function public.financial_prevent_confirmed_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.status = 'CONFIRMED' then
    raise exception using errcode = '55000', message = '확정된 재정거래는 삭제할 수 없습니다. Reversal 거래를 생성하세요.';
  end if;
  if tg_op = 'UPDATE' and old.status = 'CONFIRMED' and new is distinct from old then
    raise exception using errcode = '55000', message = '확정된 재정거래는 수정할 수 없습니다. Reversal 거래를 생성하세요.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.financial_prevent_location_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception using errcode = '55000', message = '재원 cohort 및 위치는 생성 후 수정 또는 삭제할 수 없습니다.';
end;
$$;

-- Once a project has an explicit cohort, legacy summary columns must no longer
-- become a second writable financial source. They remain intact as historical
-- imported values, while the ledger page becomes the financial source of truth.
create or replace function public.financial_prevent_legacy_budget_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.alloc is distinct from old.alloc
      or new.exec is distinct from old.exec
      or new.rate is distinct from old.rate
      or new.original_alloc is distinct from old.original_alloc
      or new.increase_amount is distinct from old.increase_amount
      or new.decrease_amount is distinct from old.decrease_amount)
     and exists (
       select 1 from public.project_budget_years
       where project_id = old.id
     ) then
    raise exception using errcode = '55000', message =
      '재원 cohort가 생성된 사업의 예산·집행액은 재정원장 RPC로만 처리할 수 있습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists project_budget_cohorts_immutable on public.project_budget_cohorts;
create trigger project_budget_cohorts_immutable
  before update or delete on public.project_budget_cohorts
  for each row execute function public.financial_prevent_location_mutation();
drop trigger if exists project_budget_years_immutable on public.project_budget_years;
create trigger project_budget_years_immutable
  before update or delete on public.project_budget_years
  for each row execute function public.financial_prevent_location_mutation();
drop trigger if exists projects_prevent_legacy_budget_mutation_when_ledger_exists on public.projects;
create trigger projects_prevent_legacy_budget_mutation_when_ledger_exists
  before update of alloc, exec, rate, original_alloc, increase_amount, decrease_amount on public.projects
  for each row execute function public.financial_prevent_legacy_budget_mutation();

drop trigger if exists project_fund_transfers_immutable on public.project_fund_transfers;
create trigger project_fund_transfers_immutable
  before update or delete on public.project_fund_transfers
  for each row execute function public.financial_prevent_confirmed_mutation();
drop trigger if exists project_execution_records_immutable on public.project_execution_records;
create trigger project_execution_records_immutable
  before update or delete on public.project_execution_records
  for each row execute function public.financial_prevent_confirmed_mutation();
drop trigger if exists project_carryovers_immutable on public.project_carryovers;
create trigger project_carryovers_immutable
  before update or delete on public.project_carryovers
  for each row execute function public.financial_prevent_confirmed_mutation();
drop trigger if exists project_budget_adjustments_immutable on public.project_budget_adjustments;
create trigger project_budget_adjustments_immutable
  before update or delete on public.project_budget_adjustments
  for each row execute function public.financial_prevent_confirmed_mutation();

-- Internal helpers. These are deliberately not granted to authenticated users.
create or replace function public.financial_require_actor()
returns table (actor_id uuid, actor_role text, actor_region_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  actor_id := auth.uid();
  if actor_id is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 재정원장을 처리할 수 있습니다.';
  end if;
  select role::text, region_id into actor_role, actor_region_id
  from public.profiles
  where id = actor_id;
  if actor_role is null or actor_role not in ('admin', 'local_user') then
    raise exception using errcode = '42501', message = '재정원장 처리 권한이 없습니다.';
  end if;
  if actor_role = 'local_user' and actor_region_id is null then
    raise exception using errcode = '42501', message = '지역 정보가 없는 사용자는 재정원장을 처리할 수 없습니다.';
  end if;
  return next;
end;
$$;

create or replace function public.financial_get_or_create_budget_year(
  p_project_id uuid,
  p_budget_cohort_id uuid,
  p_fiscal_year integer,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.project_budget_years (project_id, budget_cohort_id, fiscal_year, created_by)
  values (p_project_id, p_budget_cohort_id, p_fiscal_year, p_created_by)
  on conflict (project_id, budget_cohort_id, fiscal_year) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id
    from public.project_budget_years
    where project_id = p_project_id
      and budget_cohort_id = p_budget_cohort_id
      and fiscal_year = p_fiscal_year;
  end if;
  return v_id;
end;
$$;

create or replace function public.financial_write_audit(
  p_project_id uuid,
  p_region_id uuid,
  p_action text,
  p_entity text,
  p_record_id uuid,
  p_actor_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (
    project_id, region_id, changed_by, action, field_name, old_value, new_value,
    changed_at, created_at, updated_at
  ) values (
    p_project_id,
    p_region_id::text,
    p_actor_id,
    p_action,
    p_entity,
    null,
    jsonb_build_object('record_id', p_record_id, 'payload', coalesce(p_payload, '{}'::jsonb))::text,
    clock_timestamp(), clock_timestamp(), clock_timestamp()
  );
end;
$$;

-- Only confirmed rows affect accounting balance. Pending transfer outflows are
-- returned separately as reservations and are never treated as actual balance.
create or replace function public.financial_get_budget_year_balance(p_budget_year_id uuid)
returns table (
  accounting_balance bigint,
  reserved_amount bigint,
  available_to_commit bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with wallet as (
    select id, project_id, budget_cohort_id, fiscal_year
    from public.project_budget_years
    where id = p_budget_year_id
  ),
  components as (
    select
      coalesce((
        select sum(cohorts.initial_allocation)::numeric
        from public.project_budget_cohorts as cohorts
        join wallet on wallet.budget_cohort_id = cohorts.id
        where cohorts.origin_project_id = wallet.project_id
          and cohorts.origin_fiscal_year = wallet.fiscal_year
      ), 0::numeric) as initial_amount,
      coalesce((
        select sum(transfers.amount)::numeric
        from public.project_fund_transfers as transfers
        where transfers.destination_budget_year_id = p_budget_year_id
          and transfers.status = 'CONFIRMED'
      ), 0::numeric) as transfer_in,
      coalesce((
        select sum(transfers.amount)::numeric
        from public.project_fund_transfers as transfers
        where transfers.source_budget_year_id = p_budget_year_id
          and transfers.status = 'CONFIRMED'
      ), 0::numeric) as transfer_out,
      coalesce((
        select sum(carryovers.amount)::numeric
        from public.project_carryovers as carryovers
        where carryovers.destination_budget_year_id = p_budget_year_id
          and carryovers.status = 'CONFIRMED'
      ), 0::numeric) as carryover_in,
      coalesce((
        select sum(carryovers.amount)::numeric
        from public.project_carryovers as carryovers
        where carryovers.source_budget_year_id = p_budget_year_id
          and carryovers.status = 'CONFIRMED'
      ), 0::numeric) as carryover_out,
      coalesce((
        select sum(case when executions.transaction_kind = 'REVERSAL'
          then executions.amount::numeric else -executions.amount::numeric end)
        from public.project_execution_records as executions
        where executions.budget_year_id = p_budget_year_id
          and executions.status = 'CONFIRMED'
      ), 0::numeric) as execution_effect,
      coalesce((
        select sum(
          (case adjustments.adjustment_type
            when 'CORRECTION_INCREASE' then adjustments.amount::numeric
            when 'RETURN' then -adjustments.amount::numeric
            when 'EXTERNAL_DECREASE' then -adjustments.amount::numeric
            when 'CORRECTION_DECREASE' then -adjustments.amount::numeric
            else 0::numeric
          end) * (case when adjustments.transaction_kind = 'REVERSAL' then -1 else 1 end)
        )
        from public.project_budget_adjustments as adjustments
        where adjustments.budget_year_id = p_budget_year_id
          and adjustments.status = 'CONFIRMED'
      ), 0::numeric) as adjustment_effect,
      coalesce((
        select sum(transfers.amount)::numeric
        from public.project_fund_transfers as transfers
        where transfers.source_budget_year_id = p_budget_year_id
          and transfers.status = 'PENDING_APPROVAL'
      ), 0::numeric) as pending_reservation
  ), totals as (
    select
      initial_amount + transfer_in - transfer_out + carryover_in - carryover_out
        + execution_effect + adjustment_effect as accounting_amount,
      pending_reservation
    from components
  )
  select
    accounting_amount::bigint,
    pending_reservation::bigint,
    (accounting_amount - pending_reservation)::bigint
  from totals;
$$;

create or replace function public.financial_require_available_amount(
  p_budget_year_id uuid,
  p_amount bigint,
  p_message text default '사용가능 재원이 부족합니다.'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available bigint;
begin
  select available_to_commit into v_available
  from public.financial_get_budget_year_balance(p_budget_year_id);
  if v_available is null or v_available < p_amount then
    raise exception using errcode = '23514', message = p_message;
  end if;
end;
$$;

create or replace function public.create_project_budget_cohort(
  p_project_id uuid,
  p_origin_fiscal_year integer,
  p_initial_allocation bigint,
  p_allocation_type text,
  p_memo text,
  p_idempotency_key uuid
)
returns table (cohort_id uuid, budget_year_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_project_region_id uuid;
  v_project_year integer;
  v_cohort public.project_budget_cohorts%rowtype;
  v_budget_year_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '최초 재원 cohort 생성은 관리자만 할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_initial_allocation is null or p_initial_allocation <= 0
     or p_origin_fiscal_year is null or p_origin_fiscal_year not between 2000 and 2200
     or p_allocation_type not in ('INITIAL', 'EXTERNAL_INCREASE') then
    raise exception using errcode = '22023', message = '최초 재원 입력값이 올바르지 않습니다.';
  end if;
  if p_memo is not null and char_length(btrim(p_memo)) > 1000 then
    raise exception using errcode = '22023', message = '메모는 1,000자 이하여야 합니다.';
  end if;

  select region_id, year into v_project_region_id, v_project_year
  from public.projects
  where id = p_project_id and project_code is not null;
  if v_project_region_id is null then
    raise exception using errcode = 'P0002', message = '최초 재원을 연결할 사업을 찾을 수 없습니다.';
  end if;
  if v_project_year is not null and v_project_year <> p_origin_fiscal_year then
    raise exception using errcode = '23514', message = '최초 재원연도는 선택한 사업의 사업연도와 일치해야 합니다.';
  end if;

  select * into v_cohort
  from public.project_budget_cohorts
  where idempotency_key = p_idempotency_key;
  if found then
    v_budget_year_id := public.financial_get_or_create_budget_year(
      v_cohort.origin_project_id, v_cohort.id, v_cohort.origin_fiscal_year, v_actor_id
    );
    return query select v_cohort.id, v_budget_year_id;
    return;
  end if;

  begin
    insert into public.project_budget_cohorts (
      origin_project_id, origin_fiscal_year, initial_allocation, allocation_type, memo,
      idempotency_key, created_by
    ) values (
      p_project_id, p_origin_fiscal_year, p_initial_allocation, p_allocation_type,
      nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id
    ) returning * into v_cohort;
  exception when unique_violation then
    select * into v_cohort from public.project_budget_cohorts where idempotency_key = p_idempotency_key;
  end;

  v_budget_year_id := public.financial_get_or_create_budget_year(
    v_cohort.origin_project_id, v_cohort.id, v_cohort.origin_fiscal_year, v_actor_id
  );
  perform public.financial_write_audit(
    p_project_id, v_project_region_id, 'CREATE_BUDGET_COHORT', 'project_budget_cohorts', v_cohort.id,
    v_actor_id, jsonb_build_object(
      'budget_year_id', v_budget_year_id,
      'origin_fiscal_year', v_cohort.origin_fiscal_year,
      'initial_allocation', v_cohort.initial_allocation,
      'allocation_type', v_cohort.allocation_type,
      'idempotency_key', v_cohort.idempotency_key
    )
  );
  return query select v_cohort.id, v_budget_year_id;
end;
$$;

create or replace function public.create_or_submit_transfer(
  p_source_budget_year_id uuid,
  p_destination_project_id uuid,
  p_amount bigint,
  p_reason_code text,
  p_memo text,
  p_effective_date date,
  p_idempotency_key uuid,
  p_submit boolean default true
)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_source public.project_budget_years%rowtype;
  v_destination_budget_year_id uuid;
  v_source_region_id uuid;
  v_destination_region_id uuid;
  v_destination_project_year integer;
  v_transfer public.project_fund_transfers%rowtype;
  v_requested_status text := case when coalesce(p_submit, true) then 'PENDING_APPROVAL' else 'DRAFT' end;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null then
    raise exception using errcode = '22023', message = '재원이동 금액, 일자, 요청키는 필수이며 금액은 양수여야 합니다.';
  end if;
  if (p_reason_code is not null and char_length(btrim(p_reason_code)) > 100)
     or (p_memo is not null and char_length(btrim(p_memo)) > 1000) then
    raise exception using errcode = '22023', message = '재원이동 사유 또는 메모 길이가 올바르지 않습니다.';
  end if;

  select * into v_transfer from public.project_fund_transfers where idempotency_key = p_idempotency_key;
  if found then
    if v_transfer.created_by <> v_actor_id and v_role <> 'admin' then
      raise exception using errcode = '42501', message = '다른 사용자의 재원이동 요청키에는 접근할 수 없습니다.';
    end if;
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;

  select * into v_source
  from public.project_budget_years
  where id = p_source_budget_year_id;
  if not found then
    raise exception using errcode = 'P0002', message = '원천 재원 위치를 찾을 수 없습니다.';
  end if;
  select region_id into v_source_region_id
  from public.projects
  where id = v_source.project_id;
  select region_id, year into v_destination_region_id, v_destination_project_year
  from public.projects
  where id = p_destination_project_id and project_code is not null;
  if v_destination_region_id is null then
    raise exception using errcode = 'P0002', message = '수신 사업을 찾을 수 없습니다.';
  end if;
  if v_source.project_id = p_destination_project_id then
    raise exception using errcode = '23514', message = '원천 사업과 수신 사업은 달라야 합니다.';
  end if;
  if v_destination_project_year is distinct from v_source.fiscal_year then
    raise exception using errcode = '23514', message = '재원이동 수신 사업은 원천 재원과 같은 회계연도 사업이어야 합니다.';
  end if;
  if v_source_region_id <> v_destination_region_id then
    raise exception using errcode = '42501', message = '타 지자체 간 재원이동은 현행 승인업무 규칙이 없어 시스템에서 차단됩니다.';
  end if;
  if v_role = 'local_user' and v_source_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '본인 지역의 재원만 이동 요청할 수 있습니다.';
  end if;

  v_destination_budget_year_id := public.financial_get_or_create_budget_year(
    p_destination_project_id, v_source.budget_cohort_id, v_source.fiscal_year, v_actor_id
  );
  perform 1 from public.project_budget_years
  where id = any(array[p_source_budget_year_id, v_destination_budget_year_id])
  order by id for update;
  if v_requested_status = 'PENDING_APPROVAL' then
    perform public.financial_require_available_amount(
      p_source_budget_year_id, p_amount, '예약액을 반영한 사용가능 재원이 부족합니다.'
    );
  end if;

  begin
    insert into public.project_fund_transfers (
      source_budget_year_id, destination_budget_year_id, amount, status, transaction_kind,
      reason_code, memo, effective_date, idempotency_key, created_by, submitted_at
    ) values (
      p_source_budget_year_id, v_destination_budget_year_id, p_amount, v_requested_status, 'NORMAL',
      nullif(btrim(p_reason_code), ''), nullif(btrim(p_memo), ''), p_effective_date,
      p_idempotency_key, v_actor_id,
      case when v_requested_status = 'PENDING_APPROVAL' then clock_timestamp() else null end
    ) returning * into v_transfer;
  exception when unique_violation then
    select * into v_transfer from public.project_fund_transfers where idempotency_key = p_idempotency_key;
  end;

  perform public.financial_write_audit(
    v_source.project_id, v_source_region_id,
    case when v_requested_status = 'PENDING_APPROVAL' then 'TRANSFER_SUBMITTED' else 'TRANSFER_DRAFTED' end,
    'project_fund_transfers', v_transfer.id, v_actor_id,
    jsonb_build_object('amount', v_transfer.amount, 'status', v_transfer.status,
      'destination_budget_year_id', v_destination_budget_year_id, 'idempotency_key', v_transfer.idempotency_key)
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

create or replace function public.submit_transfer(p_transfer_id uuid)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_transfer public.project_fund_transfers%rowtype;
  v_source_region_id uuid;
  v_destination_region_id uuid;
  v_source_project_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_transfer
  from public.project_fund_transfers
  where id = p_transfer_id;
  if not found then
    raise exception using errcode = 'P0002', message = '재원이동 요청을 찾을 수 없습니다.';
  end if;
  select source_projects.region_id, destination_projects.region_id, source_wallet.project_id
  into v_source_region_id, v_destination_region_id, v_source_project_id
  from public.project_budget_years as source_wallet
  join public.projects as source_projects on source_projects.id = source_wallet.project_id
  join public.project_budget_years as destination_wallet on destination_wallet.id = v_transfer.destination_budget_year_id
  join public.projects as destination_projects on destination_projects.id = destination_wallet.project_id
  where source_wallet.id = v_transfer.source_budget_year_id;
  perform 1 from public.project_budget_years
  where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
  order by id for update;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id for update;
  if v_transfer.status = 'PENDING_APPROVAL' then
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;
  if v_transfer.status <> 'DRAFT' then
    raise exception using errcode = '23514', message = '초안 상태의 재원이동만 제출할 수 있습니다.';
  end if;
  if v_transfer.created_by <> v_actor_id and v_role <> 'admin' then
    raise exception using errcode = '42501', message = '본인이 작성한 재원이동 초안만 제출할 수 있습니다.';
  end if;
  if v_source_region_id <> v_destination_region_id
     or (v_role = 'local_user' and v_source_region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = '재원이동 권한 범위를 벗어났습니다.';
  end if;
  perform public.financial_require_available_amount(
    v_transfer.source_budget_year_id, v_transfer.amount, '예약액을 반영한 사용가능 재원이 부족합니다.'
  );
  update public.project_fund_transfers
  set status = 'PENDING_APPROVAL', submitted_at = clock_timestamp()
  where id = v_transfer.id
  returning * into v_transfer;
  perform public.financial_write_audit(
    v_source_project_id, v_source_region_id, 'TRANSFER_SUBMITTED', 'project_fund_transfers',
    v_transfer.id, v_actor_id, jsonb_build_object('amount', v_transfer.amount, 'status', v_transfer.status)
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

create or replace function public.approve_transfer(p_transfer_id uuid, p_resolution_note text default null)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_transfer public.project_fund_transfers%rowtype;
  v_source_project_id uuid;
  v_source_region_id uuid;
  v_available bigint;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '재원이동 승인 권한은 관리자에게만 있습니다.';
  end if;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id;
  if not found then
    raise exception using errcode = 'P0002', message = '승인할 재원이동 요청을 찾을 수 없습니다.';
  end if;
  perform 1 from public.project_budget_years
  where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
  order by id for update;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id for update;
  if v_transfer.status = 'CONFIRMED' then
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;
  if v_transfer.status <> 'PENDING_APPROVAL' then
    raise exception using errcode = '23514', message = '승인 대기 상태의 재원이동만 확정할 수 있습니다.';
  end if;
  select available_to_commit into v_available
  from public.financial_get_budget_year_balance(v_transfer.source_budget_year_id);
  if v_available is null or v_available < 0 then
    raise exception using errcode = '23514', message = '다른 확정 거래 이후 사용가능 재원이 부족하여 승인할 수 없습니다.';
  end if;
  update public.project_fund_transfers
  set status = 'CONFIRMED', confirmed_by = v_actor_id, confirmed_at = clock_timestamp(),
    resolution_note = nullif(btrim(p_resolution_note), '')
  where id = v_transfer.id
  returning * into v_transfer;
  select projects.id, projects.region_id into v_source_project_id, v_source_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_transfer.source_budget_year_id;
  perform public.financial_write_audit(
    v_source_project_id, v_source_region_id, 'TRANSFER_CONFIRMED', 'project_fund_transfers',
    v_transfer.id, v_actor_id, jsonb_build_object('amount', v_transfer.amount, 'status', v_transfer.status,
      'idempotency_key', v_transfer.idempotency_key)
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

create or replace function public.reject_transfer(p_transfer_id uuid, p_resolution_note text)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_transfer public.project_fund_transfers%rowtype;
  v_project_id uuid;
  v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '재원이동 반려 권한은 관리자에게만 있습니다.';
  end if;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id;
  if not found then
    raise exception using errcode = 'P0002', message = '반려할 재원이동 요청을 찾을 수 없습니다.';
  end if;
  perform 1 from public.project_budget_years
  where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
  order by id for update;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id for update;
  if v_transfer.status = 'REJECTED' then
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;
  if v_transfer.status <> 'PENDING_APPROVAL' then
    raise exception using errcode = '23514', message = '승인 대기 상태의 재원이동만 반려할 수 있습니다.';
  end if;
  if p_resolution_note is null or char_length(btrim(p_resolution_note)) = 0 then
    raise exception using errcode = '22023', message = '반려 사유를 입력하세요.';
  end if;
  update public.project_fund_transfers
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
    resolution_note = btrim(p_resolution_note)
  where id = v_transfer.id
  returning * into v_transfer;
  select projects.id, projects.region_id into v_project_id, v_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_transfer.source_budget_year_id;
  perform public.financial_write_audit(
    v_project_id, v_region_id, 'TRANSFER_REJECTED', 'project_fund_transfers',
    v_transfer.id, v_actor_id, jsonb_build_object('amount', v_transfer.amount, 'status', v_transfer.status,
      'resolution_note', v_transfer.resolution_note)
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

create or replace function public.withdraw_transfer(p_transfer_id uuid, p_resolution_note text default null)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_transfer public.project_fund_transfers%rowtype;
  v_project_id uuid;
  v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id;
  if not found then
    raise exception using errcode = 'P0002', message = '철회할 재원이동 요청을 찾을 수 없습니다.';
  end if;
  perform 1 from public.project_budget_years
  where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
  order by id for update;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id for update;
  if v_transfer.status = 'WITHDRAWN' then
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;
  if v_transfer.status not in ('DRAFT', 'PENDING_APPROVAL') then
    raise exception using errcode = '23514', message = '초안 또는 승인 대기 상태의 재원이동만 철회할 수 있습니다.';
  end if;
  if v_transfer.created_by <> v_actor_id and v_role <> 'admin' then
    raise exception using errcode = '42501', message = '본인이 작성한 재원이동만 철회할 수 있습니다.';
  end if;
  update public.project_fund_transfers
  set status = 'WITHDRAWN', withdrawn_by = v_actor_id, withdrawn_at = clock_timestamp(),
    resolution_note = nullif(btrim(p_resolution_note), '')
  where id = v_transfer.id
  returning * into v_transfer;
  select projects.id, projects.region_id into v_project_id, v_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_transfer.source_budget_year_id;
  perform public.financial_write_audit(
    v_project_id, v_region_id, 'TRANSFER_WITHDRAWN', 'project_fund_transfers',
    v_transfer.id, v_actor_id, jsonb_build_object('amount', v_transfer.amount, 'status', v_transfer.status)
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

create or replace function public.create_transfer_reversal(
  p_original_transfer_id uuid,
  p_amount bigint,
  p_memo text,
  p_effective_date date,
  p_idempotency_key uuid
)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_original public.project_fund_transfers%rowtype;
  v_reversal public.project_fund_transfers%rowtype;
  v_reversed_amount bigint;
  v_source_project_id uuid;
  v_source_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '확정 재원이동 reversal은 관리자만 생성할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null then
    raise exception using errcode = '22023', message = 'reversal 금액, 일자, 요청키는 필수입니다.';
  end if;
  select * into v_reversal from public.project_fund_transfers where idempotency_key = p_idempotency_key;
  if found then
    return query select v_reversal.id, v_reversal.status;
    return;
  end if;
  select * into v_original from public.project_fund_transfers where id = p_original_transfer_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then
    raise exception using errcode = '23514', message = '확정된 일반 재원이동만 reversal할 수 있습니다.';
  end if;
  perform 1 from public.project_budget_years
  where id = any(array[v_original.source_budget_year_id, v_original.destination_budget_year_id])
  order by id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount
  from public.project_fund_transfers
  where reversal_of = v_original.id and status = 'CONFIRMED' and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then
    raise exception using errcode = '23514', message = '원 재원이동의 미반전 금액을 초과할 수 없습니다.';
  end if;
  perform public.financial_require_available_amount(
    v_original.destination_budget_year_id, p_amount,
    '수신 사업의 동일 cohort 사용가능 재원이 부족하여 reversal할 수 없습니다.'
  );
  insert into public.project_fund_transfers (
    source_budget_year_id, destination_budget_year_id, amount, status, transaction_kind, reversal_of,
    reason_code, memo, effective_date, idempotency_key, created_by, submitted_at
  ) values (
    v_original.destination_budget_year_id, v_original.source_budget_year_id, p_amount,
    'PENDING_APPROVAL', 'REVERSAL', v_original.id, 'REVERSAL', nullif(btrim(p_memo), ''),
    p_effective_date, p_idempotency_key, v_actor_id, clock_timestamp()
  ) returning * into v_reversal;
  select projects.id, projects.region_id into v_source_project_id, v_source_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_reversal.source_budget_year_id;
  perform public.financial_write_audit(
    v_source_project_id, v_source_region_id, 'TRANSFER_REVERSAL_SUBMITTED', 'project_fund_transfers',
    v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount,
      'idempotency_key', p_idempotency_key)
  );
  return query select v_reversal.id, v_reversal.status;
end;
$$;

create or replace function public.confirm_execution(
  p_budget_year_id uuid,
  p_amount bigint,
  p_execution_date date,
  p_memo text,
  p_idempotency_key uuid
)
returns table (execution_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_wallet public.project_budget_years%rowtype;
  v_region_id uuid;
  v_execution public.project_execution_records%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_execution_date is null then
    raise exception using errcode = '22023', message = '집행 금액, 집행일, 요청키는 필수입니다.';
  end if;
  select * into v_execution from public.project_execution_records where idempotency_key = p_idempotency_key;
  if found then
    return query select v_execution.id, v_execution.status;
    return;
  end if;
  select * into v_wallet
  from public.project_budget_years
  where id = p_budget_year_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '집행할 재원 위치를 찾을 수 없습니다.';
  end if;
  select region_id into v_region_id
  from public.projects
  where id = v_wallet.project_id;
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '본인 지역 재원만 집행 처리할 수 있습니다.';
  end if;
  perform public.financial_require_available_amount(
    p_budget_year_id, p_amount, '예약액을 반영한 사용가능 재원이 부족합니다.'
  );
  insert into public.project_execution_records (
    budget_year_id, amount, execution_date, status, transaction_kind, memo, idempotency_key,
    created_by, confirmed_by, confirmed_at
  ) values (
    p_budget_year_id, p_amount, p_execution_date, 'CONFIRMED', 'NORMAL', nullif(btrim(p_memo), ''),
    p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_execution;
  perform public.financial_write_audit(
    v_wallet.project_id, v_region_id, 'EXECUTION_CONFIRMED', 'project_execution_records',
    v_execution.id, v_actor_id, jsonb_build_object('budget_year_id', p_budget_year_id,
      'amount', p_amount, 'execution_date', p_execution_date, 'idempotency_key', p_idempotency_key)
  );
  return query select v_execution.id, v_execution.status;
end;
$$;

create or replace function public.create_execution_reversal(
  p_original_execution_id uuid,
  p_amount bigint,
  p_memo text,
  p_idempotency_key uuid
)
returns table (execution_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_original public.project_execution_records%rowtype;
  v_reversal public.project_execution_records%rowtype;
  v_reversed_amount bigint;
  v_project_id uuid;
  v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '집행 reversal은 관리자만 생성할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = '집행 reversal 금액과 요청키는 필수입니다.';
  end if;
  select * into v_reversal from public.project_execution_records where idempotency_key = p_idempotency_key;
  if found then
    return query select v_reversal.id, v_reversal.status;
    return;
  end if;
  select * into v_original from public.project_execution_records where id = p_original_execution_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then
    raise exception using errcode = '23514', message = '확정된 일반 집행만 reversal할 수 있습니다.';
  end if;
  perform 1 from public.project_budget_years where id = v_original.budget_year_id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount
  from public.project_execution_records
  where reversal_of = v_original.id and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then
    raise exception using errcode = '23514', message = '원 집행의 미반전 금액을 초과할 수 없습니다.';
  end if;
  insert into public.project_execution_records (
    budget_year_id, amount, execution_date, status, transaction_kind, reversal_of, memo,
    idempotency_key, created_by, confirmed_by, confirmed_at
  ) values (
    v_original.budget_year_id, p_amount, current_date, 'CONFIRMED', 'REVERSAL', v_original.id,
    nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_reversal;
  select projects.id, projects.region_id into v_project_id, v_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_original.budget_year_id;
  perform public.financial_write_audit(
    v_project_id, v_region_id, 'EXECUTION_REVERSED', 'project_execution_records',
    v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount,
      'idempotency_key', p_idempotency_key)
  );
  return query select v_reversal.id, v_reversal.status;
end;
$$;

create or replace function public.create_carryover(
  p_source_budget_year_id uuid,
  p_destination_project_id uuid,
  p_amount bigint,
  p_memo text,
  p_idempotency_key uuid
)
returns table (carryover_id uuid, carryover_type text, carryover_sequence smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_source public.project_budget_years%rowtype;
  v_source_region_id uuid;
  v_destination_region_id uuid;
  v_destination_year integer;
  v_destination_budget_year_id uuid;
  v_origin_year integer;
  v_sequence smallint;
  v_type text;
  v_carryover public.project_carryovers%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '이월 처리는 관리자만 확정할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = '이월 금액과 요청키는 필수입니다.';
  end if;
  select * into v_carryover from public.project_carryovers where idempotency_key = p_idempotency_key;
  if found then
    return query select v_carryover.id, v_carryover.carryover_type, v_carryover.carryover_sequence;
    return;
  end if;
  select * into v_source
  from public.project_budget_years
  where id = p_source_budget_year_id;
  if not found then
    raise exception using errcode = 'P0002', message = '이월 원천 재원 위치를 찾을 수 없습니다.';
  end if;
  select region_id into v_source_region_id
  from public.projects
  where id = v_source.project_id;
  select region_id, year into v_destination_region_id, v_destination_year
  from public.projects where id = p_destination_project_id and project_code is not null;
  if v_destination_region_id is null then
    raise exception using errcode = 'P0002', message = '이월 수신 사업을 찾을 수 없습니다.';
  end if;
  if v_destination_region_id <> v_source_region_id
     or v_destination_year is distinct from v_source.fiscal_year + 1 then
    raise exception using errcode = '23514', message = '이월 수신 사업은 동일 지역의 다음 회계연도 사업이어야 합니다.';
  end if;
  select origin_fiscal_year into v_origin_year
  from public.project_budget_cohorts where id = v_source.budget_cohort_id;
  if v_origin_year is null then
    raise exception using errcode = '55000',
      message = '최초 배분연도 또는 과거 이월횟수가 확인되지 않은 Legacy Baseline 재원은 일반 이월로 처리할 수 없습니다. 관리자 검토 절차를 사용하세요.';
  end if;
  v_sequence := v_destination_year - v_origin_year;
  if v_sequence not in (1, 2) then
    raise exception using errcode = '23514', message = '최초 재원연도 기준으로 3회 이상 이월할 수 없습니다.';
  end if;
  v_type := case when v_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
  v_destination_budget_year_id := public.financial_get_or_create_budget_year(
    p_destination_project_id, v_source.budget_cohort_id, v_destination_year, v_actor_id
  );
  perform 1 from public.project_budget_years
  where id = any(array[p_source_budget_year_id, v_destination_budget_year_id])
  order by id for update;
  perform public.financial_require_available_amount(
    p_source_budget_year_id, p_amount, '예약액을 반영한 사용가능 재원이 부족하여 이월할 수 없습니다.'
  );
  insert into public.project_carryovers (
    source_budget_year_id, destination_budget_year_id, amount, carryover_sequence, carryover_type,
    status, transaction_kind, memo, idempotency_key, created_by, confirmed_by, confirmed_at
  ) values (
    p_source_budget_year_id, v_destination_budget_year_id, p_amount, v_sequence, v_type,
    'CONFIRMED', 'NORMAL', nullif(btrim(p_memo), ''), p_idempotency_key,
    v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_carryover;
  perform public.financial_write_audit(
    v_source.project_id, v_source_region_id, 'CARRYOVER_CONFIRMED', 'project_carryovers',
    v_carryover.id, v_actor_id, jsonb_build_object('amount', p_amount, 'carryover_type', v_type,
      'carryover_sequence', v_sequence, 'destination_budget_year_id', v_destination_budget_year_id,
      'idempotency_key', p_idempotency_key)
  );
  return query select v_carryover.id, v_carryover.carryover_type, v_carryover.carryover_sequence;
end;
$$;

create or replace function public.create_carryover_reversal(
  p_original_carryover_id uuid,
  p_amount bigint,
  p_memo text,
  p_idempotency_key uuid
)
returns table (carryover_id uuid, carryover_type text, carryover_sequence smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_original public.project_carryovers%rowtype;
  v_reversal public.project_carryovers%rowtype;
  v_reversed_amount bigint;
  v_project_id uuid;
  v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '이월 reversal은 관리자만 생성할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = '이월 reversal 금액과 요청키는 필수입니다.';
  end if;
  select * into v_reversal from public.project_carryovers where idempotency_key = p_idempotency_key;
  if found then
    return query select v_reversal.id, v_reversal.carryover_type, v_reversal.carryover_sequence;
    return;
  end if;
  select * into v_original from public.project_carryovers where id = p_original_carryover_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then
    raise exception using errcode = '23514', message = '확정된 일반 이월만 reversal할 수 있습니다.';
  end if;
  perform 1 from public.project_budget_years
  where id = any(array[v_original.source_budget_year_id, v_original.destination_budget_year_id])
  order by id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount
  from public.project_carryovers
  where reversal_of = v_original.id and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then
    raise exception using errcode = '23514', message = '원 이월의 미반전 금액을 초과할 수 없습니다.';
  end if;
  perform public.financial_require_available_amount(
    v_original.destination_budget_year_id, p_amount,
    '이월 수신 사업의 동일 cohort 사용가능 재원이 부족하여 reversal할 수 없습니다.'
  );
  insert into public.project_carryovers (
    source_budget_year_id, destination_budget_year_id, amount, carryover_sequence, carryover_type,
    status, transaction_kind, reversal_of, memo, idempotency_key, created_by, confirmed_by, confirmed_at
  ) values (
    v_original.destination_budget_year_id, v_original.source_budget_year_id, p_amount,
    v_original.carryover_sequence, v_original.carryover_type, 'CONFIRMED', 'REVERSAL', v_original.id,
    nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_reversal;
  select projects.id, projects.region_id into v_project_id, v_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_reversal.source_budget_year_id;
  perform public.financial_write_audit(
    v_project_id, v_region_id, 'CARRYOVER_REVERSED', 'project_carryovers',
    v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount,
      'idempotency_key', p_idempotency_key)
  );
  return query select v_reversal.id, v_reversal.carryover_type, v_reversal.carryover_sequence;
end;
$$;

create or replace function public.create_budget_adjustment(
  p_budget_year_id uuid,
  p_adjustment_type text,
  p_amount bigint,
  p_reason_code text,
  p_memo text,
  p_effective_date date,
  p_idempotency_key uuid
)
returns table (adjustment_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_wallet public.project_budget_years%rowtype;
  v_region_id uuid;
  v_adjustment public.project_budget_adjustments%rowtype;
  v_is_outflow boolean;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '반납 및 외부 조정은 관리자만 확정할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null
     or p_adjustment_type not in ('RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_INCREASE', 'CORRECTION_DECREASE') then
    raise exception using errcode = '22023', message = '조정 유형, 금액, 일자, 요청키가 올바르지 않습니다.';
  end if;
  select * into v_adjustment from public.project_budget_adjustments where idempotency_key = p_idempotency_key;
  if found then
    return query select v_adjustment.id, v_adjustment.status;
    return;
  end if;
  select * into v_wallet
  from public.project_budget_years
  where id = p_budget_year_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '조정할 재원 위치를 찾을 수 없습니다.';
  end if;
  select region_id into v_region_id
  from public.projects
  where id = v_wallet.project_id;
  v_is_outflow := p_adjustment_type in ('RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_DECREASE');
  if v_is_outflow then
    perform public.financial_require_available_amount(
      p_budget_year_id, p_amount, '예약액을 반영한 사용가능 재원이 부족합니다.'
    );
  end if;
  insert into public.project_budget_adjustments (
    budget_year_id, adjustment_type, amount, status, transaction_kind, reason_code, memo,
    effective_date, idempotency_key, created_by, confirmed_by, confirmed_at
  ) values (
    p_budget_year_id, p_adjustment_type, p_amount, 'CONFIRMED', 'NORMAL', nullif(btrim(p_reason_code), ''),
    nullif(btrim(p_memo), ''), p_effective_date, p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_adjustment;
  perform public.financial_write_audit(
    v_wallet.project_id, v_region_id, 'BUDGET_ADJUSTMENT_CONFIRMED', 'project_budget_adjustments',
    v_adjustment.id, v_actor_id, jsonb_build_object('adjustment_type', p_adjustment_type,
      'amount', p_amount, 'idempotency_key', p_idempotency_key)
  );
  return query select v_adjustment.id, v_adjustment.status;
end;
$$;

create or replace function public.create_budget_adjustment_reversal(
  p_original_adjustment_id uuid,
  p_amount bigint,
  p_memo text,
  p_idempotency_key uuid
)
returns table (adjustment_id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_original public.project_budget_adjustments%rowtype;
  v_reversal public.project_budget_adjustments%rowtype;
  v_reversed_amount bigint;
  v_project_id uuid;
  v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = '예산 조정 reversal은 관리자만 생성할 수 있습니다.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = '조정 reversal 금액과 요청키는 필수입니다.';
  end if;
  select * into v_reversal from public.project_budget_adjustments where idempotency_key = p_idempotency_key;
  if found then
    return query select v_reversal.id, v_reversal.status;
    return;
  end if;
  select * into v_original from public.project_budget_adjustments where id = p_original_adjustment_id;
  if not found or v_original.status <> 'CONFIRMED' or v_original.transaction_kind <> 'NORMAL' then
    raise exception using errcode = '23514', message = '확정된 일반 조정만 reversal할 수 있습니다.';
  end if;
  perform 1 from public.project_budget_years where id = v_original.budget_year_id for update;
  select coalesce(sum(amount), 0) into v_reversed_amount
  from public.project_budget_adjustments
  where reversal_of = v_original.id and transaction_kind = 'REVERSAL';
  if p_amount > v_original.amount - v_reversed_amount then
    raise exception using errcode = '23514', message = '원 조정의 미반전 금액을 초과할 수 없습니다.';
  end if;
  -- The balance function applies the reversal direction from transaction_kind.
  -- Keep the original adjustment type here; changing both would invert the
  -- amount twice and make a reversal increase the original effect.
  if v_original.adjustment_type = 'CORRECTION_INCREASE' then
    perform public.financial_require_available_amount(
      v_original.budget_year_id, p_amount, '사용가능 재원이 부족하여 조정 reversal을 확정할 수 없습니다.'
    );
  end if;
  insert into public.project_budget_adjustments (
    budget_year_id, adjustment_type, amount, status, transaction_kind, reversal_of, reason_code, memo,
    effective_date, idempotency_key, created_by, confirmed_by, confirmed_at
  ) values (
    v_original.budget_year_id, v_original.adjustment_type, p_amount, 'CONFIRMED', 'REVERSAL', v_original.id,
    'REVERSAL', nullif(btrim(p_memo), ''), current_date, p_idempotency_key,
    v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_reversal;
  select projects.id, projects.region_id into v_project_id, v_region_id
  from public.project_budget_years as wallet
  join public.projects as projects on projects.id = wallet.project_id
  where wallet.id = v_original.budget_year_id;
  perform public.financial_write_audit(
    v_project_id, v_region_id, 'BUDGET_ADJUSTMENT_REVERSED', 'project_budget_adjustments',
    v_reversal.id, v_actor_id, jsonb_build_object('reversal_of', v_original.id, 'amount', p_amount,
      'idempotency_key', p_idempotency_key)
  );
  return query select v_reversal.id, v_reversal.status;
end;
$$;

-- Read RPCs power the UI while keeping direct ledger DML unavailable.
create or replace function public.get_financial_budget_years()
returns table (
  budget_year_id uuid,
  project_id uuid,
  project_code text,
  project_name text,
  sido text,
  sigungu text,
  fiscal_year integer,
  budget_cohort_id uuid,
  origin_project_id uuid,
  origin_fiscal_year integer,
  initial_allocation text,
  allocation_type text,
  accounting_balance text,
  reserved_amount text,
  available_to_commit text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query
  select
    budget_years.id,
    projects.id,
    projects.project_code::text,
    coalesce(nullif(projects.detail_project_name, ''), nullif(projects.fund_project_name, ''), projects.project_name, '-')::text,
    projects.sido::text,
    projects.sigungu::text,
    budget_years.fiscal_year,
    cohorts.id,
    cohorts.origin_project_id,
    cohorts.origin_fiscal_year,
    cohorts.initial_allocation::text,
    cohorts.allocation_type,
    balance.accounting_balance::text,
    balance.reserved_amount::text,
    balance.available_to_commit::text
  from public.project_budget_years as budget_years
  join public.projects as projects on projects.id = budget_years.project_id
  join public.project_budget_cohorts as cohorts on cohorts.id = budget_years.budget_cohort_id
  cross join lateral public.financial_get_budget_year_balance(budget_years.id) as balance
  where v_role = 'admin' or projects.region_id = v_actor_region_id
  order by budget_years.fiscal_year desc, projects.project_code, cohorts.origin_fiscal_year;
end;
$$;

create or replace function public.get_transfer_destination_projects(p_source_budget_year_id uuid)
returns table (
  project_id uuid,
  project_code text,
  project_name text,
  sido text,
  sigungu text,
  fiscal_year integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_source_project_id uuid;
  v_source_region_id uuid;
  v_fiscal_year integer;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select budget_years.project_id, projects.region_id, budget_years.fiscal_year
  into v_source_project_id, v_source_region_id, v_fiscal_year
  from public.project_budget_years as budget_years
  join public.projects as projects on projects.id = budget_years.project_id
  where budget_years.id = p_source_budget_year_id;
  if v_source_project_id is null then
    raise exception using errcode = 'P0002', message = '원천 재원 위치를 찾을 수 없습니다.';
  end if;
  if v_role = 'local_user' and v_source_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = '본인 지역 재원만 조회할 수 있습니다.';
  end if;
  return query
  select projects.id, projects.project_code::text,
    coalesce(nullif(projects.detail_project_name, ''), nullif(projects.fund_project_name, ''), projects.project_name, '-')::text,
    projects.sido::text, projects.sigungu::text, projects.year
  from public.projects as projects
  where projects.project_code is not null
    and projects.id <> v_source_project_id
    and projects.region_id = v_source_region_id
    and projects.year = v_fiscal_year
  order by projects.sido, projects.sigungu, projects.project_code
  limit 200;
end;
$$;

alter table public.project_budget_cohorts enable row level security;
alter table public.project_budget_years enable row level security;
alter table public.project_fund_transfers enable row level security;
alter table public.project_execution_records enable row level security;
alter table public.project_carryovers enable row level security;
alter table public.project_budget_adjustments enable row level security;

create policy project_budget_cohorts_select_region_or_admin on public.project_budget_cohorts
  for select to authenticated using (
    exists (
      select 1 from public.projects as projects
      join public.profiles as profiles on profiles.id = auth.uid()
      where projects.id = project_budget_cohorts.origin_project_id
        and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
    )
  );
create policy project_budget_years_select_region_or_admin on public.project_budget_years
  for select to authenticated using (
    exists (
      select 1 from public.projects as projects
      join public.profiles as profiles on profiles.id = auth.uid()
      where projects.id = project_budget_years.project_id
        and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
    )
  );
create policy project_fund_transfers_select_region_or_admin on public.project_fund_transfers
  for select to authenticated using (
    exists (
      select 1
      from public.profiles as profiles
      join public.project_budget_years as source_wallet on source_wallet.id = project_fund_transfers.source_budget_year_id
      join public.projects as source_project on source_project.id = source_wallet.project_id
      join public.project_budget_years as destination_wallet on destination_wallet.id = project_fund_transfers.destination_budget_year_id
      join public.projects as destination_project on destination_project.id = destination_wallet.project_id
      where profiles.id = auth.uid()
        and (profiles.role = 'admin' or profiles.region_id = source_project.region_id or profiles.region_id = destination_project.region_id)
    )
  );
create policy project_execution_records_select_region_or_admin on public.project_execution_records
  for select to authenticated using (
    exists (
      select 1 from public.project_budget_years as wallet
      join public.projects as projects on projects.id = wallet.project_id
      join public.profiles as profiles on profiles.id = auth.uid()
      where wallet.id = project_execution_records.budget_year_id
        and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
    )
  );
create policy project_carryovers_select_region_or_admin on public.project_carryovers
  for select to authenticated using (
    exists (
      select 1
      from public.profiles as profiles
      join public.project_budget_years as source_wallet on source_wallet.id = project_carryovers.source_budget_year_id
      join public.projects as source_project on source_project.id = source_wallet.project_id
      join public.project_budget_years as destination_wallet on destination_wallet.id = project_carryovers.destination_budget_year_id
      join public.projects as destination_project on destination_project.id = destination_wallet.project_id
      where profiles.id = auth.uid()
        and (profiles.role = 'admin' or profiles.region_id = source_project.region_id or profiles.region_id = destination_project.region_id)
    )
  );
create policy project_budget_adjustments_select_region_or_admin on public.project_budget_adjustments
  for select to authenticated using (
    exists (
      select 1 from public.project_budget_years as wallet
      join public.projects as projects on projects.id = wallet.project_id
      join public.profiles as profiles on profiles.id = auth.uid()
      where wallet.id = project_budget_adjustments.budget_year_id
        and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
    )
  );

-- The client may read its permitted ledger rows but can never change them directly.
revoke all on table public.project_budget_cohorts from anon, authenticated;
revoke all on table public.project_budget_years from anon, authenticated;
revoke all on table public.project_fund_transfers from anon, authenticated;
revoke all on table public.project_execution_records from anon, authenticated;
revoke all on table public.project_carryovers from anon, authenticated;
revoke all on table public.project_budget_adjustments from anon, authenticated;
grant select on public.project_budget_cohorts, public.project_budget_years,
  public.project_fund_transfers, public.project_execution_records,
  public.project_carryovers, public.project_budget_adjustments to authenticated;

revoke all on function public.financial_validate_budget_year_location() from public, anon, authenticated;
revoke all on function public.financial_validate_wallet_relationship() from public, anon, authenticated;
revoke all on function public.financial_prevent_confirmed_mutation() from public, anon, authenticated;
revoke all on function public.financial_prevent_location_mutation() from public, anon, authenticated;
revoke all on function public.financial_prevent_legacy_budget_mutation() from public, anon, authenticated;
revoke all on function public.financial_require_actor() from public, anon, authenticated;
revoke all on function public.financial_get_or_create_budget_year(uuid, uuid, integer, uuid) from public, anon, authenticated;
revoke all on function public.financial_write_audit(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.financial_get_budget_year_balance(uuid) from public, anon, authenticated;
revoke all on function public.financial_require_available_amount(uuid, bigint, text) from public, anon, authenticated;

revoke all on function public.create_project_budget_cohort(uuid, integer, bigint, text, text, uuid) from public, anon;
revoke all on function public.create_or_submit_transfer(uuid, uuid, bigint, text, text, date, uuid, boolean) from public, anon;
revoke all on function public.submit_transfer(uuid) from public, anon;
revoke all on function public.approve_transfer(uuid, text) from public, anon;
revoke all on function public.reject_transfer(uuid, text) from public, anon;
revoke all on function public.withdraw_transfer(uuid, text) from public, anon;
revoke all on function public.create_transfer_reversal(uuid, bigint, text, date, uuid) from public, anon;
revoke all on function public.confirm_execution(uuid, bigint, date, text, uuid) from public, anon;
revoke all on function public.create_execution_reversal(uuid, bigint, text, uuid) from public, anon;
revoke all on function public.create_carryover(uuid, uuid, bigint, text, uuid) from public, anon;
revoke all on function public.create_carryover_reversal(uuid, bigint, text, uuid) from public, anon;
revoke all on function public.create_budget_adjustment(uuid, text, bigint, text, text, date, uuid) from public, anon;
revoke all on function public.create_budget_adjustment_reversal(uuid, bigint, text, uuid) from public, anon;
revoke all on function public.get_financial_budget_years() from public, anon;
revoke all on function public.get_transfer_destination_projects(uuid) from public, anon;

grant execute on function public.create_project_budget_cohort(uuid, integer, bigint, text, text, uuid) to authenticated;
grant execute on function public.create_or_submit_transfer(uuid, uuid, bigint, text, text, date, uuid, boolean) to authenticated;
grant execute on function public.submit_transfer(uuid) to authenticated;
grant execute on function public.approve_transfer(uuid, text) to authenticated;
grant execute on function public.reject_transfer(uuid, text) to authenticated;
grant execute on function public.withdraw_transfer(uuid, text) to authenticated;
grant execute on function public.create_transfer_reversal(uuid, bigint, text, date, uuid) to authenticated;
grant execute on function public.confirm_execution(uuid, bigint, date, text, uuid) to authenticated;
grant execute on function public.create_execution_reversal(uuid, bigint, text, uuid) to authenticated;
grant execute on function public.create_carryover(uuid, uuid, bigint, text, uuid) to authenticated;
grant execute on function public.create_carryover_reversal(uuid, bigint, text, uuid) to authenticated;
grant execute on function public.create_budget_adjustment(uuid, text, bigint, text, text, date, uuid) to authenticated;
grant execute on function public.create_budget_adjustment_reversal(uuid, bigint, text, uuid) to authenticated;
grant execute on function public.get_financial_budget_years() to authenticated;
grant execute on function public.get_transfer_destination_projects(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
