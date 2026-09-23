-- TEST-only funding reallocation delta.
--
-- Prerequisite: 20260821000100_ledger_policy_delta.sql is already applied.
-- This migration is deliberately schema/RPC-only: it does not UPDATE projects,
-- materialize the four existing decreases, create cohorts, or bind/change the
-- Ledger runtime.  Every monetary materialization still passes the existing
-- financial_require_ledger_write() guard, so RECONCILIATION accepts only
-- evidence-backed LEGACY_EXCEL events and SYSTEM_NATIVE remains TEST-mode/date
-- gated exactly as before.
--
-- Canonical accounting rules introduced here:
--   * direct project A -> existing project B remains project_fund_transfers;
--   * waiting funds are a confirmed lot plus append-only movements;
--   * a return from a waiting lot is the RETURN movement itself and MUST NOT be
--     paired with project_budget_adjustments (which remains canonical only for
--     returns made directly from a project wallet);
--   * remaining lot amount is always derived from movements, never updated;
--   * new-project funding comes from one locked lot in the same region/year and
--     is applied atomically with the project, wallet, and movement.

begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 0. Fail-fast compatibility gate (read-only; no empty-Ledger requirement)
-- ---------------------------------------------------------------------------

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'public.projects',
    'public.regions',
    'public.profiles',
    'public.project_budget_cohorts',
    'public.project_budget_years',
    'public.project_fund_transfers',
    'public.project_execution_records',
    'public.project_carryovers',
    'public.project_budget_adjustments',
    'public.project_related_projects',
    'public.audit_logs',
    'public.ledger_evidence',
    'public.financial_ledger_runtime'
  ] loop
    if to_regclass(v_name) is null then
      raise exception using errcode = '55000', message =
        format('Funding reallocation delta prerequisite is missing: %s', v_name);
    end if;
  end loop;

  if to_regprocedure('public.financial_require_actor()') is null
     or to_regprocedure('public.financial_require_admin()') is null
     or to_regprocedure('public.financial_require_ledger_write(text,date,uuid)') is null
     or to_regprocedure('public.financial_request_fingerprint(jsonb)') is null
     or to_regprocedure('public.financial_assert_same_fingerprint(text,text,text)') is null
     or to_regprocedure('public.financial_get_or_create_budget_year(uuid,uuid,integer,uuid)') is null
     or to_regprocedure('public.financial_get_budget_year_balance(uuid)') is null
     or to_regprocedure('public.financial_require_available_amount(uuid,bigint,text)') is null
     or to_regprocedure('public.financial_write_audit(uuid,uuid,text,text,uuid,uuid,jsonb)') is null
     or to_regprocedure('public.current_user_role()') is null
     or to_regprocedure('public.current_user_region_id()') is null
     or to_regprocedure('public.update_project_classification_with_custom_small_categories(uuid,uuid,uuid,uuid[],jsonb,varchar)') is null then
    raise exception using errcode = '55000', message =
      'Funding reallocation delta found an unexpected Ledger helper signature set.';
  end if;

  if to_regclass('public.financial_unallocated_fund_lots') is not null
     or to_regclass('public.financial_unallocated_fund_movements') is not null
     or to_regclass('public.financial_funding_reallocation_requests') is not null
     or to_regclass('public.financial_new_project_requests') is not null then
    raise exception using errcode = '55000', message =
      'Funding reallocation objects already exist. Stop and reconcile migration history.';
  end if;
end
$$;

create temporary table funding_reallocation_migration_snapshot on commit drop as
select
  (select count(*) from public.projects)::bigint as project_count,
  (select count(*) from public.projects where coalesce(decrease_amount, 0) > 0)::bigint
    as decreased_project_count,
  (select coalesce(sum(decrease_amount), 0) from public.projects)::numeric
    as project_decrease_total,
  (select jsonb_agg(to_jsonb(runtime) order by runtime.singleton)
    from public.financial_ledger_runtime as runtime) as runtime_rows;

-- ---------------------------------------------------------------------------
-- 1. Normalized decrease classification, waiting lots, and movements
-- ---------------------------------------------------------------------------

create table public.financial_unallocated_fund_lots (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  budget_cohort_id uuid not null references public.project_budget_cohorts(id) on delete restrict,
  source_project_id uuid not null references public.projects(id) on delete restrict,
  source_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  original_amount bigint not null check (original_amount > 0),
  status text not null default 'CONFIRMED' check (status = 'CONFIRMED'),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  effective_date date not null,
  record_origin text not null check (record_origin in ('SYSTEM_NATIVE', 'LEGACY_EXCEL')),
  evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default clock_timestamp(),
  constraint financial_unallocated_fund_lots_origin_check check (
    (record_origin = 'SYSTEM_NATIVE' and evidence_id is null and effective_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and evidence_id is not null
      and effective_date between date '2022-01-01' and date '2026-08-31')
  )
);

create table public.financial_unallocated_fund_movements (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.financial_unallocated_fund_lots(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  budget_cohort_id uuid not null references public.project_budget_cohorts(id) on delete restrict,
  movement_type text not null check (movement_type in (
    'ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT', 'RETURN', 'RESTORE_SOURCE'
  )),
  transaction_kind text not null default 'NORMAL'
    check (transaction_kind in ('NORMAL', 'REVERSAL')),
  reversal_of uuid references public.financial_unallocated_fund_movements(id) on delete restrict,
  destination_project_id uuid references public.projects(id) on delete restrict,
  destination_budget_year_id uuid references public.project_budget_years(id) on delete restrict,
  new_project_request_id uuid,
  amount bigint not null check (amount > 0),
  effective_date date not null,
  record_origin text not null check (record_origin in ('SYSTEM_NATIVE', 'LEGACY_EXCEL')),
  evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  memo text check (memo is null or char_length(memo) <= 1000),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default clock_timestamp(),
  constraint financial_unallocated_fund_movements_shape check (
    (movement_type in ('ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT', 'RESTORE_SOURCE')
      and destination_project_id is not null and destination_budget_year_id is not null)
    or
    (movement_type = 'RETURN' and destination_project_id is null
      and destination_budget_year_id is null and new_project_request_id is null)
  ),
  constraint financial_unallocated_fund_movements_reversal_shape check (
    (transaction_kind = 'NORMAL' and reversal_of is null)
    or (transaction_kind = 'REVERSAL' and reversal_of is not null and reversal_of <> id)
  ),
  constraint financial_unallocated_fund_movements_new_project_shape check (
    (movement_type = 'ALLOCATE_NEW_PROJECT' and new_project_request_id is not null)
    or (movement_type <> 'ALLOCATE_NEW_PROJECT' and new_project_request_id is null)
  ),
  constraint financial_unallocated_fund_movements_origin_check check (
    (record_origin = 'SYSTEM_NATIVE' and evidence_id is null and effective_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and evidence_id is not null
      and effective_date between date '2022-01-01' and date '2026-08-31')
  )
);

-- This table classifies a projects.decrease_amount DELTA.  It is a trace link,
-- not a second monetary transaction. canonical_record_id identifies the one
-- and only accounting source (lot, project_fund_transfers, or adjustment).
create table public.financial_project_decrease_classifications (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  budget_cohort_id uuid not null references public.project_budget_cohorts(id) on delete restrict,
  source_project_id uuid not null references public.projects(id) on delete restrict,
  source_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  outcome_type text not null check (outcome_type in (
    'UNALLOCATED_LOT', 'EXISTING_PROJECT_TRANSFER', 'DIRECT_RETURN'
  )),
  amount bigint not null check (amount > 0),
  decrease_amount_before bigint not null check (decrease_amount_before >= 0),
  decrease_amount_after bigint not null check (decrease_amount_after >= 0),
  canonical_table text not null check (canonical_table in (
    'financial_unallocated_fund_lots', 'project_fund_transfers', 'project_budget_adjustments'
  )),
  canonical_record_id uuid not null,
  lot_id uuid references public.financial_unallocated_fund_lots(id) on delete restrict,
  transfer_id uuid references public.project_fund_transfers(id) on delete restrict,
  adjustment_id uuid references public.project_budget_adjustments(id) on delete restrict,
  record_origin text not null check (record_origin in ('SYSTEM_NATIVE', 'LEGACY_EXCEL')),
  evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint financial_project_decrease_delta_check check (
    decrease_amount_after - decrease_amount_before = amount
  ),
  constraint financial_project_decrease_canonical_shape check (
    (outcome_type = 'UNALLOCATED_LOT' and canonical_table = 'financial_unallocated_fund_lots'
      and lot_id = canonical_record_id and transfer_id is null and adjustment_id is null)
    or
    (outcome_type = 'EXISTING_PROJECT_TRANSFER' and canonical_table = 'project_fund_transfers'
      and transfer_id = canonical_record_id and lot_id is null and adjustment_id is null)
    or
    (outcome_type = 'DIRECT_RETURN'
      and canonical_table = 'project_budget_adjustments'
      and adjustment_id = canonical_record_id and lot_id is null and transfer_id is null)
  ),
  unique (canonical_table, canonical_record_id)
);

create table public.financial_project_decrease_classification_reversals (
  id uuid primary key default gen_random_uuid(),
  classification_id uuid not null
    references public.financial_project_decrease_classifications(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  budget_cohort_id uuid not null references public.project_budget_cohorts(id) on delete restrict,
  source_project_id uuid not null references public.projects(id) on delete restrict,
  source_budget_year_id uuid not null references public.project_budget_years(id) on delete restrict,
  amount bigint not null check (amount > 0),
  decrease_amount_before bigint not null check (decrease_amount_before >= 0),
  decrease_amount_after bigint not null check (decrease_amount_after >= 0),
  canonical_table text not null check (canonical_table in (
    'financial_unallocated_fund_movements', 'project_fund_transfers', 'project_budget_adjustments'
  )),
  canonical_record_id uuid not null,
  movement_id uuid references public.financial_unallocated_fund_movements(id) on delete restrict,
  transfer_id uuid references public.project_fund_transfers(id) on delete restrict,
  adjustment_id uuid references public.project_budget_adjustments(id) on delete restrict,
  record_origin text not null check (record_origin in ('SYSTEM_NATIVE', 'LEGACY_EXCEL')),
  evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint financial_project_decrease_reversal_delta_check check (
    decrease_amount_before - decrease_amount_after = amount
  ),
  constraint financial_project_decrease_reversal_canonical_shape check (
    (canonical_table = 'financial_unallocated_fund_movements'
      and movement_id = canonical_record_id and transfer_id is null and adjustment_id is null)
    or (canonical_table = 'project_fund_transfers'
      and transfer_id = canonical_record_id and movement_id is null and adjustment_id is null)
    or (canonical_table = 'project_budget_adjustments'
      and adjustment_id = canonical_record_id and movement_id is null and transfer_id is null)
  ),
  unique (canonical_table, canonical_record_id)
);

-- Immutable proof that a project's physical compatibility baseline matched the
-- Ledger immediately before (or, for Legacy reconstruction, immediately after)
-- its first guarded canonical allocation/execution event. Later Ledger-native
-- changes may legitimately diverge from the stale physical row.
create table public.financial_project_baseline_attestations (
  project_id uuid primary key references public.projects(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  physical_adjusted_allocation bigint not null check (physical_adjusted_allocation >= 0),
  ledger_adjusted_allocation bigint not null check (ledger_adjusted_allocation >= 0),
  physical_execution_amount bigint not null check (physical_execution_amount >= 0),
  ledger_execution_amount bigint not null check (ledger_execution_amount >= 0),
  attested_by uuid not null references public.profiles(id) on delete restrict,
  attested_at timestamptz not null default clock_timestamp(),
  check (physical_adjusted_allocation = ledger_adjusted_allocation),
  check (physical_execution_amount = ledger_execution_amount)
);

create index financial_unallocated_fund_lots_region_year_idx
  on public.financial_unallocated_fund_lots(region_id, fiscal_year, created_at desc);
create index financial_unallocated_fund_lots_source_wallet_idx
  on public.financial_unallocated_fund_lots(source_budget_year_id, budget_cohort_id);
create index financial_unallocated_fund_movements_lot_idx
  on public.financial_unallocated_fund_movements(lot_id, created_at);
create index financial_unallocated_fund_movements_destination_idx
  on public.financial_unallocated_fund_movements(destination_budget_year_id)
  where destination_budget_year_id is not null;
create index financial_project_decrease_classifications_source_idx
  on public.financial_project_decrease_classifications(source_project_id, fiscal_year);
create index financial_project_decrease_reversals_classification_idx
  on public.financial_project_decrease_classification_reversals(classification_id, created_at);

-- Forward reference is added after the new-project table is declared.

-- Direct DML, including service-role DML, must still honor the existing runtime
-- origin policy. RPC row locks provide the monetary concurrency guard.
create or replace function public.financial_validate_unallocated_origin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.financial_require_ledger_write(new.record_origin, new.effective_date, new.evidence_id);
  return new;
end;
$$;

create or replace function public.financial_validate_unallocated_lot_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_region_id uuid; v_project_id uuid; v_cohort_id uuid; v_year integer;
begin
  select projects.region_id, wallets.project_id, wallets.budget_cohort_id, wallets.fiscal_year
    into v_region_id, v_project_id, v_cohort_id, v_year
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = new.source_budget_year_id;
  if v_region_id is distinct from new.region_id
     or v_project_id is distinct from new.source_project_id
     or v_cohort_id is distinct from new.budget_cohort_id
     or v_year is distinct from new.fiscal_year then
    raise exception using errcode = '23514', message =
      'Waiting-fund lot region/year/cohort/source wallet references disagree.';
  end if;
  if new.record_origin = 'LEGACY_EXCEL' and not exists (
    select 1 from public.ledger_evidence
    where id = new.evidence_id and region_id = new.region_id
  ) then
    raise exception using errcode = '23514', message = 'Waiting-fund evidence must match lot region.';
  end if;
  return new;
end;
$$;

create or replace function public.financial_validate_unallocated_movement_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_destination_region uuid; v_destination_project uuid; v_destination_cohort uuid; v_destination_year integer;
  v_original public.financial_unallocated_fund_movements%rowtype;
begin
  select * into v_lot from public.financial_unallocated_fund_lots where id = new.lot_id;
  if not found or new.region_id <> v_lot.region_id or new.budget_cohort_id <> v_lot.budget_cohort_id
     or new.record_origin <> v_lot.record_origin then
    raise exception using errcode = '23514', message = 'Movement must preserve its lot region, cohort, and origin.';
  end if;
  if new.destination_budget_year_id is not null then
    select projects.region_id, wallets.project_id, wallets.budget_cohort_id, wallets.fiscal_year
      into v_destination_region, v_destination_project, v_destination_cohort, v_destination_year
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = new.destination_budget_year_id;
    if v_destination_region is distinct from v_lot.region_id
       or v_destination_project is distinct from new.destination_project_id
       or v_destination_cohort is distinct from v_lot.budget_cohort_id
       or v_destination_year is distinct from v_lot.fiscal_year then
      raise exception using errcode = '23514', message =
        'Movement destination must be a same-region/year wallet in the lot cohort.';
    end if;
  end if;
  if new.movement_type = 'RESTORE_SOURCE' and (
    new.destination_project_id <> v_lot.source_project_id
    or new.destination_budget_year_id <> v_lot.source_budget_year_id
  ) then
    raise exception using errcode = '23514', message =
      'RESTORE_SOURCE destination must be the lot source project wallet.';
  end if;
  if new.transaction_kind = 'REVERSAL' then
    select * into v_original from public.financial_unallocated_fund_movements
    where id = new.reversal_of and transaction_kind = 'NORMAL';
    if not found or v_original.lot_id <> new.lot_id
       or v_original.movement_type <> new.movement_type
       or v_original.destination_project_id is distinct from new.destination_project_id
       or v_original.destination_budget_year_id is distinct from new.destination_budget_year_id
       or v_original.new_project_request_id is distinct from new.new_project_request_id then
      raise exception using errcode = '23514', message = 'Movement reversal target facts must match the normal movement.';
    end if;
  end if;
  return new;
end;
$$;

create trigger financial_unallocated_fund_lots_link_guard
  before insert or update on public.financial_unallocated_fund_lots
  for each row execute function public.financial_validate_unallocated_lot_links();
create trigger financial_unallocated_fund_movements_link_guard
  before insert or update on public.financial_unallocated_fund_movements
  for each row execute function public.financial_validate_unallocated_movement_links();

create or replace function public.financial_validate_decrease_classification_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_region_id uuid; v_year integer; v_cohort_id uuid; v_project_id uuid;
  v_origin text; v_evidence_id uuid; v_amount bigint;
begin
  select position.region_id, position.fiscal_year, position.budget_cohort_id,
    position.source_project_id
    into v_region_id, v_year, v_cohort_id, v_project_id
  from public.financial_assert_decrease_delta_position(
    new.source_budget_year_id, new.decrease_amount_before,
    new.decrease_amount_after, new.amount, false
  ) as position;
  if new.region_id <> v_region_id or new.fiscal_year <> v_year
     or new.budget_cohort_id <> v_cohort_id or new.source_project_id <> v_project_id then
    raise exception using errcode = '23514', message = 'Decrease classification source references disagree.';
  end if;
  if new.outcome_type = 'UNALLOCATED_LOT' then
    select record_origin, evidence_id, original_amount into v_origin, v_evidence_id, v_amount
    from public.financial_unallocated_fund_lots where id = new.lot_id
      and source_budget_year_id = new.source_budget_year_id;
  elsif new.outcome_type = 'EXISTING_PROJECT_TRANSFER' then
    select record_origin, evidence_id, amount into v_origin, v_evidence_id, v_amount
    from public.project_fund_transfers where id = new.transfer_id
      and source_budget_year_id = new.source_budget_year_id
      and status = 'CONFIRMED' and transaction_kind = 'NORMAL';
  else
    select record_origin, evidence_id, amount into v_origin, v_evidence_id, v_amount
    from public.project_budget_adjustments where id = new.adjustment_id
      and budget_year_id = new.source_budget_year_id
      and status = 'CONFIRMED' and transaction_kind = 'NORMAL';
  end if;
  if v_origin is null or v_amount <> new.amount or v_origin <> new.record_origin
     or v_evidence_id is distinct from new.evidence_id then
    raise exception using errcode = '23514', message =
      'Decrease classification must exactly match its one canonical monetary record.';
  end if;
  return new;
end;
$$;

create trigger financial_project_decrease_classifications_link_guard
  before insert on public.financial_project_decrease_classifications
  for each row execute function public.financial_validate_decrease_classification_links();

create or replace function public.financial_validate_decrease_classification_reversal_links()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_classification public.financial_project_decrease_classifications%rowtype;
  v_reversed bigint;
  v_origin text; v_evidence_id uuid; v_amount bigint;
begin
  select * into v_classification
  from public.financial_project_decrease_classifications
  where id = new.classification_id;
  if not found
     or new.region_id <> v_classification.region_id
     or new.fiscal_year <> v_classification.fiscal_year
     or new.budget_cohort_id <> v_classification.budget_cohort_id
     or new.source_project_id <> v_classification.source_project_id
     or new.source_budget_year_id <> v_classification.source_budget_year_id then
    raise exception using errcode = '23514', message = 'Decrease reversal must preserve original classification source facts.';
  end if;
  perform public.financial_assert_decrease_delta_position(
    new.source_budget_year_id, new.decrease_amount_before,
    new.decrease_amount_after, new.amount, true
  );
  select coalesce(sum(amount), 0)::bigint into v_reversed
  from public.financial_project_decrease_classification_reversals
  where classification_id = new.classification_id;
  if new.amount > v_classification.amount - v_reversed then
    raise exception using errcode = '23514', message = 'Decrease reversal exceeds unreversed classification amount.';
  end if;

  if new.movement_id is not null then
    select record_origin, evidence_id, amount into v_origin, v_evidence_id, v_amount
    from public.financial_unallocated_fund_movements
    where id = new.movement_id and movement_type = 'RESTORE_SOURCE'
      and lot_id = v_classification.lot_id
      and destination_budget_year_id = v_classification.source_budget_year_id;
  elsif new.transfer_id is not null then
    select record_origin, evidence_id, amount into v_origin, v_evidence_id, v_amount
    from public.project_fund_transfers
    where id = new.transfer_id and transaction_kind = 'REVERSAL'
      and reversal_of = v_classification.transfer_id and status = 'CONFIRMED';
  else
    select record_origin, evidence_id, amount into v_origin, v_evidence_id, v_amount
    from public.project_budget_adjustments
    where id = new.adjustment_id and transaction_kind = 'REVERSAL'
      and reversal_of = v_classification.adjustment_id and status = 'CONFIRMED';
  end if;
  if v_origin is null or v_amount <> new.amount or v_origin <> new.record_origin
     or v_evidence_id is distinct from new.evidence_id then
    raise exception using errcode = '23514', message =
      'Decrease reversal must exactly match its linked canonical reversal record.';
  end if;
  return new;
end;
$$;

create trigger financial_project_decrease_classification_reversals_link_guard
  before insert on public.financial_project_decrease_classification_reversals
  for each row execute function public.financial_validate_decrease_classification_reversal_links();

create trigger financial_unallocated_fund_lots_origin_guard
  before insert or update on public.financial_unallocated_fund_lots
  for each row execute function public.financial_validate_unallocated_origin();
create trigger financial_unallocated_fund_movements_origin_guard
  before insert or update on public.financial_unallocated_fund_movements
  for each row execute function public.financial_validate_unallocated_origin();

create trigger financial_unallocated_fund_lots_immutable
  before update or delete on public.financial_unallocated_fund_lots
  for each row execute function public.financial_prevent_append_only_mutation();
create trigger financial_unallocated_fund_movements_immutable
  before update or delete on public.financial_unallocated_fund_movements
  for each row execute function public.financial_prevent_append_only_mutation();
create trigger financial_project_decrease_classifications_immutable
  before update or delete on public.financial_project_decrease_classifications
  for each row execute function public.financial_prevent_append_only_mutation();
create trigger financial_project_decrease_classification_reversals_immutable
  before update or delete on public.financial_project_decrease_classification_reversals
  for each row execute function public.financial_prevent_append_only_mutation();
create trigger financial_project_baseline_attestations_immutable
  before update or delete on public.financial_project_baseline_attestations
  for each row execute function public.financial_prevent_append_only_mutation();

-- A classified canonical decrease may only be reversed together with its
-- immutable linked reversal trace. Deferred checks let the linked APPLY insert
-- the canonical reversal first and the trace second in one transaction, while
-- generic reversal RPCs fail at commit instead of drifting wallet/classification
-- state. RESTORE_SOURCE is always part of that same linked workflow.
create or replace function public.financial_enforce_linked_decrease_reversal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'project_fund_transfers' then
    if new.transaction_kind = 'REVERSAL'
       and exists (
         select 1 from public.financial_project_decrease_classifications
         where transfer_id = new.reversal_of
       ) and not exists (
         select 1 from public.financial_project_decrease_classification_reversals
         where transfer_id = new.id
       ) then
      raise exception using errcode = '23514', message =
        'A classified transfer must be reversed through REVERSE_DECREASE_CLASSIFICATION.';
    end if;
  elsif tg_table_name = 'project_budget_adjustments' then
    if new.transaction_kind = 'REVERSAL'
       and exists (
         select 1 from public.financial_project_decrease_classifications
         where adjustment_id = new.reversal_of
       ) and not exists (
         select 1 from public.financial_project_decrease_classification_reversals
         where adjustment_id = new.id
       ) then
      raise exception using errcode = '23514', message =
        'A classified adjustment must be reversed through REVERSE_DECREASE_CLASSIFICATION.';
    end if;
  elsif tg_table_name = 'financial_unallocated_fund_movements' then
    if new.movement_type = 'RESTORE_SOURCE'
       and not exists (
         select 1 from public.financial_project_decrease_classification_reversals
         where movement_id = new.id
       ) then
      raise exception using errcode = '23514', message =
        'RESTORE_SOURCE requires its linked decrease classification reversal.';
    end if;
  end if;
  return new;
end;
$$;

create constraint trigger financial_transfer_linked_decrease_reversal_guard
  after insert on public.project_fund_transfers
  deferrable initially deferred
  for each row execute function public.financial_enforce_linked_decrease_reversal();
create constraint trigger financial_adjustment_linked_decrease_reversal_guard
  after insert on public.project_budget_adjustments
  deferrable initially deferred
  for each row execute function public.financial_enforce_linked_decrease_reversal();
create constraint trigger financial_restore_source_linked_decrease_reversal_guard
  after insert on public.financial_unallocated_fund_movements
  deferrable initially deferred
  for each row execute function public.financial_enforce_linked_decrease_reversal();

-- ---------------------------------------------------------------------------
-- 2. Maker-checker envelope for lot creation/allocation/return/reversal
-- ---------------------------------------------------------------------------

create table public.financial_funding_reallocation_requests (
  id uuid primary key default gen_random_uuid(),
  request_type text not null check (request_type in (
    'CREATE_UNALLOCATED_LOT', 'ALLOCATE_UNALLOCATED_EXISTING',
    'RETURN_UNALLOCATED', 'REVERSE_UNALLOCATED_MOVEMENT',
    'CREATE_DECREASE_TRANSFER', 'CREATE_DIRECT_ADJUSTMENT',
    'REVERSE_DECREASE_CLASSIFICATION',
    'CLASSIFY_EXISTING_TRANSFER', 'CLASSIFY_EXISTING_ADJUSTMENT'
  )),
  region_id uuid not null references public.regions(id) on delete restrict,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED')),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  submitted_by uuid references public.profiles(id) on delete restrict,
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  applied_by uuid references public.profiles(id) on delete restrict,
  applied_at timestamptz,
  materialized_table text,
  materialized_record_id uuid,
  constraint financial_funding_reallocation_requests_state_shape check (
    (status = 'DRAFT' and submitted_by is null and approved_by is null
      and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null
      and materialized_table is not null and materialized_record_id is not null)
  )
);

create index financial_funding_reallocation_requests_region_status_idx
  on public.financial_funding_reallocation_requests(region_id, status, request_type);

-- ---------------------------------------------------------------------------
-- 3. New-project request: no guessed code and no unfunded project
-- ---------------------------------------------------------------------------

create table public.financial_new_project_requests (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  project_name text not null check (char_length(btrim(project_name)) between 1 and 500),
  fund_project_name text check (fund_project_name is null or char_length(fund_project_name) <= 500),
  detail_project_name text check (detail_project_name is null or char_length(detail_project_name) <= 500),
  project_period text check (project_period is null or char_length(project_period) <= 200),
  project_start_year integer check (project_start_year is null or project_start_year between 2000 and 2200),
  project_end_year integer check (project_end_year is null or project_end_year between 2000 and 2200),
  project_status text check (project_status is null or char_length(project_status) <= 100),
  business_type text check (business_type is null or business_type in ('HW', 'SW', 'COMPOSITE')),
  large_category_id uuid references public.large_categories(id) on delete restrict,
  middle_category_id uuid,
  source_lot_id uuid not null references public.financial_unallocated_fund_lots(id) on delete restrict,
  requested_amount bigint not null check (requested_amount > 0),
  status text not null check (status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED')),
  official_project_code text,
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  submitted_by uuid references public.profiles(id) on delete restrict,
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  applied_by uuid references public.profiles(id) on delete restrict,
  applied_at timestamptz,
  materialized_project_id uuid references public.projects(id) on delete restrict,
  materialized_movement_id uuid references public.financial_unallocated_fund_movements(id) on delete restrict,
  constraint financial_new_project_requests_classification_pair check (
    (large_category_id is null and middle_category_id is null)
    or (large_category_id is not null and middle_category_id is not null)
  ),
  constraint financial_new_project_requests_period_order check (
    project_start_year is null or project_end_year is null or project_start_year <= project_end_year
  ),
  constraint financial_new_project_requests_state_shape check (
    (status = 'DRAFT' and official_project_code is null and submitted_by is null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and official_project_code is null
      and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and official_project_code is not null
      and approved_by is not null and approved_at is not null
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and official_project_code is null
      and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and official_project_code is not null
      and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null
      and materialized_project_id is not null and materialized_movement_id is not null)
  )
);

alter table public.financial_new_project_requests
  add constraint financial_new_project_requests_middle_large_fkey
  foreign key (middle_category_id, large_category_id)
  references public.middle_categories(id, large_category_id) on delete restrict;

alter table public.financial_unallocated_fund_movements
  add constraint financial_unallocated_fund_movements_new_project_request_fkey
  foreign key (new_project_request_id)
  references public.financial_new_project_requests(id) on delete restrict;

create index financial_new_project_requests_region_status_idx
  on public.financial_new_project_requests(region_id, status, requested_at desc);
create index financial_new_project_requests_source_lot_idx
  on public.financial_new_project_requests(source_lot_id, status);
create unique index financial_new_project_requests_official_code_reservation_uidx
  on public.financial_new_project_requests(official_project_code)
  where official_project_code is not null;

-- ---------------------------------------------------------------------------
-- 4. Derived balances and the deliberately non-materializing decrease view
-- ---------------------------------------------------------------------------

create view public.financial_unallocated_fund_lot_balances
with (security_invoker = true)
as
with movement_totals as (
  select movements.lot_id,
    coalesce(sum(case
      when movements.movement_type = 'ALLOCATE_EXISTING_PROJECT'
        then movements.amount * case when movements.transaction_kind = 'REVERSAL' then -1 else 1 end
      else 0 end), 0)::bigint as allocated_existing_amount,
    coalesce(sum(case
      when movements.movement_type = 'ALLOCATE_NEW_PROJECT'
        then movements.amount * case when movements.transaction_kind = 'REVERSAL' then -1 else 1 end
      else 0 end), 0)::bigint as allocated_new_amount,
    coalesce(sum(case
      when movements.movement_type = 'RETURN'
        then movements.amount * case when movements.transaction_kind = 'REVERSAL' then -1 else 1 end
      else 0 end), 0)::bigint as returned_amount,
    coalesce(sum(movements.amount
      * case when movements.transaction_kind = 'REVERSAL' then -1 else 1 end), 0)::bigint
      as disposed_amount
  from public.financial_unallocated_fund_movements as movements
  group by movements.lot_id
)
select lots.id as lot_id, lots.region_id, lots.fiscal_year, lots.budget_cohort_id,
  lots.source_project_id, lots.source_budget_year_id,
  projects.project_code as source_project_code,
  coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name) as source_project_name,
  lots.original_amount,
  coalesce(totals.allocated_existing_amount, 0)::bigint as allocated_existing_amount,
  coalesce(totals.allocated_new_amount, 0)::bigint as allocated_new_amount,
  coalesce(totals.returned_amount, 0)::bigint as returned_amount,
  (lots.original_amount - coalesce(totals.disposed_amount, 0))::bigint as remaining_amount,
  case when lots.original_amount - coalesce(totals.disposed_amount, 0) = 0
    then 'EXHAUSTED' else 'OPEN' end::text as balance_status,
  lots.reason, lots.record_origin, lots.evidence_id, lots.effective_date,
  lots.created_by, lots.created_at
from public.financial_unallocated_fund_lots as lots
join public.projects on projects.id = lots.source_project_id
left join movement_totals as totals on totals.lot_id = lots.id;

create view public.financial_project_decrease_classification_effects
with (security_invoker = true)
as
select classifications.*,
  greatest(classifications.amount - coalesce(reversals.reversed_amount, 0), 0)::bigint
    as classification_effect,
  coalesce(reversals.reversed_amount, 0)::bigint as reversed_amount,
  greatest(classifications.amount - coalesce(reversals.reversed_amount, 0), 0)::bigint
    as reversible_amount
from public.financial_project_decrease_classifications as classifications
left join lateral (
  select coalesce(sum(rows.amount), 0)::bigint as reversed_amount
  from public.financial_project_decrease_classification_reversals as rows
  where rows.classification_id = classifications.id
) as reversals on true;

create view public.financial_unclassified_project_decreases
with (security_invoker = true)
as
with classified as (
  select effects.source_project_id,
    count(*)::bigint as classification_count,
    coalesce(sum(effects.classification_effect), 0)::bigint as classified_amount
  from public.financial_project_decrease_classification_effects as effects
  group by effects.source_project_id
), project_wallet as (
  select wallets.project_id, count(*)::bigint as wallet_count,
    (array_agg(wallets.id order by wallets.fiscal_year desc, wallets.created_at desc))[1]
      as candidate_budget_year_id,
    (array_agg(wallets.budget_cohort_id order by wallets.fiscal_year desc, wallets.created_at desc))[1]
      as candidate_budget_cohort_id
  from public.project_budget_years as wallets
  group by wallets.project_id
)
select projects.id as project_id, projects.project_code,
  coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name) as project_name,
  projects.region_id, projects.year as fiscal_year,
  coalesce(projects.decrease_amount, 0)::bigint as decrease_amount,
  coalesce(classified.classified_amount, 0)::bigint as classified_amount,
  greatest(coalesce(projects.decrease_amount, 0) - coalesce(classified.classified_amount, 0), 0)::bigint
    as unclassified_amount,
  (coalesce(project_wallet.wallet_count, 0) > 0) as has_budget_year,
  case when project_wallet.wallet_count = 1 then project_wallet.candidate_budget_year_id end
    as budget_year_id,
  case when project_wallet.wallet_count = 1 then project_wallet.candidate_budget_cohort_id end
    as budget_cohort_id,
  coalesce(project_wallet.wallet_count, 0)::bigint as wallet_count,
  (coalesce(project_wallet.wallet_count, 0) > 1) as source_selection_required
from public.projects
left join classified on classified.source_project_id = projects.id
left join project_wallet on project_wallet.project_id = projects.id
-- projects.decrease_amount is a bootstrap source only until the first immutable
-- classification exists.  After that, the classification/reversal chain is the
-- canonical decrease total, so a stale physical compatibility value must never
-- reappear as a fake unclassified balance after a linked reversal.
where coalesce(classified.classification_count, 0) = 0
  and coalesce(projects.decrease_amount, 0) > 0;

-- Serializes all movement decisions on one lot. Remaining is recomputed while
-- the lot row lock is held, preventing two admins from allocating the same won.
create or replace function public.financial_lock_unallocated_lot_remaining(p_lot_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original bigint;
  v_disposed bigint;
begin
  select original_amount into v_original
  from public.financial_unallocated_fund_lots
  where id = p_lot_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Waiting-fund lot was not found.';
  end if;
  select coalesce(sum(amount * case when transaction_kind = 'REVERSAL' then -1 else 1 end), 0)
    into v_disposed
  from public.financial_unallocated_fund_movements
  where lot_id = p_lot_id;
  if v_disposed < 0 or v_disposed > v_original then
    raise exception using errcode = '23514', message = 'Waiting-fund lot accounting invariant is broken.';
  end if;
  return v_original - v_disposed;
end;
$$;

create or replace function public.financial_assert_funding_origin_evidence(
  p_region_id uuid,
  p_record_origin text,
  p_effective_date date,
  p_evidence_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.financial_require_ledger_write(p_record_origin, p_effective_date, p_evidence_id);
  if p_record_origin = 'LEGACY_EXCEL' and not exists (
    select 1 from public.ledger_evidence
    where id = p_evidence_id and region_id = p_region_id
      and evidence_scope = 'LEGACY_RECONSTRUCTION' and verification_status = 'VERIFIED'
  ) then
    raise exception using errcode = '23514', message =
      'LEGACY_EXCEL reallocation requires same-region VERIFIED reconstruction evidence.';
  end if;
end;
$$;

-- Before the first guarded canonical event, prove the complete physical baseline
-- rather than the presence of an ALLOCATION row alone. Signed pending effects
-- support both new events (pre-state matches raw) and Legacy reconstruction
-- (post-state matches raw). A prior immutable attestation is provenance for all
-- later Ledger-native divergence from the intentionally stale projects columns.
create or replace function public.financial_assert_project_baseline_ready(
  p_project_id uuid,
  p_pending_allocation_effect bigint default 0,
  p_pending_execution_effect bigint default 0,
  p_pending_classification_effect bigint default 0,
  p_record_origin text default 'SYSTEM_NATIVE',
  p_allow_pending_event_provenance boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_physical_allocation bigint;
  v_physical_execution bigint;
  v_ledger_allocation bigint;
  v_ledger_execution bigint;
  v_attested_ledger_allocation bigint;
  v_attested_ledger_execution bigint;
  v_net_classified_decrease bigint;
  v_has_baseline_provenance boolean;
  v_target_decrease numeric;
  v_current_allocation_target numeric;
  v_candidate_allocation_target numeric;
  v_candidate_allocation numeric;
  v_candidate_execution numeric;
  v_candidate_classification numeric;
begin
  if p_pending_allocation_effect is null or p_pending_execution_effect is null
     or p_pending_classification_effect is null
     or p_record_origin not in ('SYSTEM_NATIVE', 'LEGACY_EXCEL') then
    raise exception using errcode = '22023', message =
      'Project baseline pending effects/origin are invalid.';
  end if;
  -- Already-attested projects and APPLIED new projects need no baseline lock.
  if exists (
    select 1 from public.financial_project_baseline_attestations
    where project_id = p_project_id
  ) or exists (
    select 1 from public.financial_new_project_requests as requests
    where requests.materialized_project_id = p_project_id
      and requests.status = 'APPLIED'
  ) then
    return;
  end if;

  -- A project can legitimately have multiple cohorts and wallets, so wallet
  -- locks alone cannot serialize first-baseline decisions. A blocking project
  -- row lock would invert existing wallet -> project lock order on some RPCs.
  -- Use one non-blocking transaction advisory lock per project instead: the
  -- loser gets a serialization failure and must retry after the winner commits.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'financial_project_baseline:' || p_project_id::text, 20260824000100
  )) then
    raise exception using errcode = '40001', message =
      'Concurrent project baseline event detected; retry the transaction.';
  end if;

  -- The winner may have committed after the first check but before this lock
  -- was acquired. Recheck committed provenance before calculating totals.
  if exists (
    select 1 from public.financial_project_baseline_attestations
    where project_id = p_project_id
  ) or exists (
    select 1 from public.financial_new_project_requests as requests
    where requests.materialized_project_id = p_project_id
      and requests.status = 'APPLIED'
  ) then
    return;
  end if;

  select * into v_project from public.projects where id = p_project_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Baseline project was not found.';
  end if;

  select exists (
    select 1 from public.project_budget_cohorts as cohorts
    where cohorts.origin_project_id = p_project_id
      and (cohorts.record_origin = 'SYSTEM_NATIVE'
        or (cohorts.record_origin = 'LEGACY_EXCEL'
          and cohorts.reconciliation_status = 'RECONCILED'))
  ) or exists (
    select 1 from public.project_carryovers as carryovers
    join public.project_budget_years as destination_wallet
      on destination_wallet.id = carryovers.destination_budget_year_id
    where destination_wallet.project_id = p_project_id
      and carryovers.status = 'CONFIRMED'
      and carryovers.transaction_kind = 'NORMAL'
  ) or p_allow_pending_event_provenance into v_has_baseline_provenance;
  if not v_has_baseline_provenance then
    raise exception using errcode = '23514', message =
      'Project requires a reconciled own baseline, verified carryover provenance, or APPLIED new-project provenance.';
  end if;

  v_physical_allocation := greatest(coalesce(v_project.alloc,
    v_project.original_alloc + coalesce(v_project.increase_amount, 0)
      - coalesce(v_project.decrease_amount, 0), 0), 0)::bigint;
  v_physical_execution := greatest(coalesce(v_project.exec, 0), 0)::bigint;
  select coalesce(sum(balance.accounting_balance + execution.confirmed_execution), 0)::bigint,
    coalesce(sum(execution.confirmed_execution), 0)::bigint
    into v_ledger_allocation, v_ledger_execution
  from public.project_budget_years as wallets
  cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
  left join lateral (
    select coalesce(sum(records.amount
      * case when records.transaction_kind = 'REVERSAL' then -1 else 1 end), 0)::bigint
      as confirmed_execution
    from public.project_execution_records as records
    where records.budget_year_id = wallets.id and records.status = 'CONFIRMED'
  ) as execution on true
  where wallets.project_id = p_project_id;
  select coalesce(sum(classification_effect), 0)::bigint
    into v_net_classified_decrease
  from public.financial_project_decrease_classification_effects
  where source_project_id = p_project_id;
  v_target_decrease := coalesce(v_project.decrease_amount, 0)::numeric;
  if v_target_decrease < 0 then
    raise exception using errcode = '23514', message =
      'Project physical decrease baseline cannot be negative.';
  end if;
  v_candidate_allocation := v_ledger_allocation::numeric
    + p_pending_allocation_effect::numeric;
  v_candidate_execution := v_ledger_execution::numeric
    + p_pending_execution_effect::numeric;
  v_candidate_classification := v_net_classified_decrease::numeric
    + p_pending_classification_effect::numeric;
  -- An imported adjusted allocation already includes raw decrease_amount, but
  -- the Ledger must first reconstruct the pre-decrease allocation and only
  -- reduce it as classifications are materialized. Keep separate current and
  -- candidate targets so ALLOCATION -> EXECUTION -> DECREASE and
  -- ALLOCATION -> DECREASE -> EXECUTION are both valid staged histories.
  v_current_allocation_target := v_physical_allocation::numeric
    + greatest(v_target_decrease - v_net_classified_decrease::numeric, 0);
  v_candidate_allocation_target := v_physical_allocation::numeric
    + greatest(v_target_decrease - v_candidate_classification, 0);

  if v_ledger_allocation::numeric = v_current_allocation_target
     and v_ledger_execution = v_physical_execution
     and v_net_classified_decrease::numeric = v_target_decrease then
    -- Complete pre-event baseline: the pending effect is a new UAT event even
    -- when TEST runtime policy requires LEGACY_EXCEL origin.
    v_attested_ledger_allocation := v_ledger_allocation;
    v_attested_ledger_execution := v_ledger_execution;
  elsif p_record_origin = 'LEGACY_EXCEL'
        and v_candidate_allocation = v_candidate_allocation_target
        and v_candidate_execution = v_physical_execution::numeric
        and v_candidate_classification = v_target_decrease then
    -- Historical raw event being reconstructed atomically by this pending row.
    v_attested_ledger_allocation := v_candidate_allocation::bigint;
    v_attested_ledger_execution := v_candidate_execution::bigint;
  elsif p_record_origin = 'LEGACY_EXCEL'
        and v_candidate_allocation >= 0
        and v_candidate_execution >= 0
        and v_candidate_classification >= 0
        and (v_candidate_allocation - v_candidate_allocation_target)
          * (v_ledger_allocation::numeric - v_current_allocation_target) >= 0
        and (v_candidate_execution - v_physical_execution::numeric)
          * (v_ledger_execution::numeric - v_physical_execution::numeric) >= 0
        and (v_candidate_classification - v_target_decrease)
          * (v_net_classified_decrease::numeric - v_target_decrease) >= 0
        and abs(v_candidate_allocation - v_candidate_allocation_target)
          <= abs(v_ledger_allocation::numeric - v_current_allocation_target)
        and abs(v_candidate_execution - v_physical_execution::numeric)
          <= abs(v_ledger_execution::numeric - v_physical_execution::numeric)
        and abs(v_candidate_classification - v_target_decrease)
          <= abs(v_net_classified_decrease::numeric - v_target_decrease)
        and (
          abs(v_candidate_allocation - v_candidate_allocation_target)
            < abs(v_ledger_allocation::numeric - v_current_allocation_target)
          or abs(v_candidate_execution - v_physical_execution::numeric)
            < abs(v_ledger_execution::numeric - v_physical_execution::numeric)
          or abs(v_candidate_classification - v_target_decrease)
            < abs(v_net_classified_decrease::numeric - v_target_decrease)
        ) then
    -- Legacy reconstruction may be staged in any axis order, but every row
    -- must monotonically reduce at least one raw-vs-Ledger gap without
    -- worsening, overshooting, or crossing any other target. Do not attest
    -- until a later boundary proves exact coverage across all three axes.
    return;
  else
    raise exception using errcode = '23514', message =
      'Project baseline is neither exact nor a monotonic Legacy reconstruction step.';
  end if;
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authenticated actor is required for baseline attestation.';
  end if;
  insert into public.financial_project_baseline_attestations (
    project_id, region_id, physical_adjusted_allocation,
    ledger_adjusted_allocation, physical_execution_amount,
    ledger_execution_amount, attested_by
  ) values (
    v_project.id, v_project.region_id, v_physical_allocation,
    v_attested_ledger_allocation, v_physical_execution,
    v_attested_ledger_execution, auth.uid()
  ) on conflict (project_id) do nothing;
end;
$$;

create or replace function public.financial_validate_transfer_project_baselines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_source_project_id uuid; v_destination_project_id uuid;
begin
  if new.status <> 'CONFIRMED' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'CONFIRMED' then
    return new;
  end if;
  select source_wallet.project_id, destination_wallet.project_id
    into v_source_project_id, v_destination_project_id
  from public.project_budget_years as source_wallet
  join public.project_budget_years as destination_wallet
    on destination_wallet.id = new.destination_budget_year_id
  where source_wallet.id = new.source_budget_year_id;
  if v_source_project_id is null or v_destination_project_id is null then
    raise exception using errcode = 'P0002', message = 'Transfer project wallets were not found.';
  end if;
  if v_source_project_id = v_destination_project_id then
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, 0, 0, 0, new.record_origin, false
    );
  elsif v_source_project_id < v_destination_project_id then
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, -new.amount, 0, 0, new.record_origin, false
    );
    perform public.financial_assert_project_baseline_ready(
      v_destination_project_id, new.amount, 0, 0, new.record_origin, false
    );
  else
    perform public.financial_assert_project_baseline_ready(
      v_destination_project_id, new.amount, 0, 0, new.record_origin, false
    );
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, -new.amount, 0, 0, new.record_origin, false
    );
  end if;
  return new;
end;
$$;

create trigger financial_transfer_project_baselines_guard
  before insert or update of status on public.project_fund_transfers
  for each row execute function public.financial_validate_transfer_project_baselines();

create or replace function public.financial_validate_execution_project_baseline()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_project_id uuid; v_execution_effect bigint;
begin
  if new.status <> 'CONFIRMED' then return new; end if;
  select project_id into v_project_id from public.project_budget_years
  where id = new.budget_year_id;
  v_execution_effect := new.amount
    * case when new.transaction_kind = 'REVERSAL' then -1 else 1 end;
  perform public.financial_assert_project_baseline_ready(
    v_project_id, 0, v_execution_effect, 0, new.record_origin, false
  );
  return new;
end;
$$;
create trigger financial_execution_project_baseline_guard
  before insert on public.project_execution_records
  for each row execute function public.financial_validate_execution_project_baseline();

create or replace function public.financial_validate_adjustment_project_baseline()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_project_id uuid; v_allocation_effect bigint;
begin
  if new.status <> 'CONFIRMED' then return new; end if;
  select project_id into v_project_id from public.project_budget_years
  where id = new.budget_year_id;
  v_allocation_effect := new.amount
    * case when new.adjustment_type = 'CORRECTION_INCREASE' then 1 else -1 end
    * case when new.transaction_kind = 'REVERSAL' then -1 else 1 end;
  perform public.financial_assert_project_baseline_ready(
    v_project_id, v_allocation_effect, 0, 0, new.record_origin, false
  );
  return new;
end;
$$;
create trigger financial_adjustment_project_baseline_guard
  before insert on public.project_budget_adjustments
  for each row execute function public.financial_validate_adjustment_project_baseline();

create or replace function public.financial_validate_carryover_project_baselines()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_source_project_id uuid; v_destination_project_id uuid;
begin
  if new.status <> 'CONFIRMED' then return new; end if;
  select source_wallet.project_id, destination_wallet.project_id
    into v_source_project_id, v_destination_project_id
  from public.project_budget_years as source_wallet
  join public.project_budget_years as destination_wallet
    on destination_wallet.id = new.destination_budget_year_id
  where source_wallet.id = new.source_budget_year_id;
  if v_source_project_id < v_destination_project_id then
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, -new.amount, 0, 0, new.record_origin, false
    );
    perform public.financial_assert_project_baseline_ready(
      v_destination_project_id, new.amount, 0, 0, new.record_origin, true
    );
  else
    perform public.financial_assert_project_baseline_ready(
      v_destination_project_id, new.amount, 0, 0, new.record_origin, true
    );
    perform public.financial_assert_project_baseline_ready(
      v_source_project_id, -new.amount, 0, 0, new.record_origin, false
    );
  end if;
  return new;
end;
$$;
create trigger financial_carryover_project_baselines_guard
  before insert on public.project_carryovers
  for each row execute function public.financial_validate_carryover_project_baselines();

create or replace function public.financial_validate_cohort_project_baseline()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.financial_assert_project_baseline_ready(
    new.origin_project_id, new.initial_allocation, 0, 0,
    new.record_origin, true
  );
  return new;
end;
$$;
create trigger financial_cohort_project_baseline_guard
  before insert on public.project_budget_cohorts
  for each row execute function public.financial_validate_cohort_project_baseline();

-- Locks the compatibility project row and proves that the requested event is a
-- new monotonic delta, not a repeated processing of decrease_amount total.
create or replace function public.financial_assert_decrease_delta_position(
  p_source_budget_year_id uuid,
  p_decrease_amount_before bigint,
  p_decrease_amount_after bigint,
  p_amount bigint,
  p_is_correction boolean default false
)
returns table (
  region_id uuid,
  fiscal_year integer,
  budget_cohort_id uuid,
  source_project_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_decrease bigint;
  v_classified bigint;
  v_classification_count bigint;
begin
  if p_amount is null or p_amount <= 0
     or p_decrease_amount_before is null or p_decrease_amount_before < 0
     or p_decrease_amount_after is null or p_decrease_amount_after < 0 then
    raise exception using errcode = '22023', message = 'Decrease delta values must be nonnegative and amount must be positive.';
  end if;
  if (not p_is_correction and p_decrease_amount_after - p_decrease_amount_before <> p_amount)
     or (p_is_correction and p_decrease_amount_before - p_decrease_amount_after <> p_amount) then
    raise exception using errcode = '23514', message =
      'Decrease handling must use the exact positive delta; reductions require a linked correction reversal.';
  end if;

  select projects.region_id, wallets.fiscal_year, wallets.budget_cohort_id,
    projects.id, coalesce(projects.decrease_amount, 0)::bigint
    into region_id, fiscal_year, budget_cohort_id, source_project_id, v_project_decrease
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = p_source_budget_year_id
  for update of projects;
  if not found then
    raise exception using errcode = 'P0002', message = 'Decrease source wallet was not found.';
  end if;
  select count(*)::bigint, coalesce(sum(classification_effect), 0)::bigint
    into v_classification_count, v_classified
  from public.financial_project_decrease_classification_effects
  where financial_project_decrease_classification_effects.source_project_id =
    financial_assert_decrease_delta_position.source_project_id;

  if v_classification_count = 0 then
    -- Legacy/bootstrap rows may already carry the imported physical total. A
    -- post-Ledger native 0 -> positive delta is also reachable without touching
    -- the protected compatibility column.
    if p_decrease_amount_before <> 0
       or (v_project_decrease > 0 and v_project_decrease <> p_decrease_amount_after) then
      raise exception using errcode = '23514', message =
        'Unclassified bootstrap must start at zero and exactly match the imported physical decrease.';
    end if;
  elsif v_classified <> p_decrease_amount_before then
    raise exception using errcode = '23514', message =
      'Canonical classification/reversal total does not match decrease_amount_before.';
  end if;
  return next;
end;
$$;

create or replace function public.financial_validate_funding_reallocation_payload(
  p_request_type text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_region_id uuid;
  v_id uuid;
  v_amount bigint;
begin
  if p_request_type not in (
    'CREATE_UNALLOCATED_LOT', 'ALLOCATE_UNALLOCATED_EXISTING',
    'RETURN_UNALLOCATED', 'REVERSE_UNALLOCATED_MOVEMENT',
    'CREATE_DECREASE_TRANSFER', 'CREATE_DIRECT_ADJUSTMENT',
    'REVERSE_DECREASE_CLASSIFICATION',
    'CLASSIFY_EXISTING_TRANSFER', 'CLASSIFY_EXISTING_ADJUSTMENT'
  ) or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Invalid funding reallocation request type or payload.';
  end if;

  if p_request_type = 'CREATE_UNALLOCATED_LOT' then
    v_id := (p_payload ->> 'source_budget_year_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_id;
    if (p_payload ->> 'decrease_amount_before')::bigint < 0
       or (p_payload ->> 'decrease_amount_after')::bigint
          - (p_payload ->> 'decrease_amount_before')::bigint <> v_amount
       or char_length(btrim(coalesce(p_payload ->> 'reason', ''))) not between 1 and 1000 then
      raise exception using errcode = '22023', message = 'CREATE_UNALLOCATED_LOT requires an exact positive decrease delta and reason.';
    end if;
  elsif p_request_type in ('ALLOCATE_UNALLOCATED_EXISTING', 'RETURN_UNALLOCATED') then
    v_id := (p_payload ->> 'lot_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select region_id into v_region_id from public.financial_unallocated_fund_lots where id = v_id;
    if p_request_type = 'ALLOCATE_UNALLOCATED_EXISTING'
       and nullif(p_payload ->> 'destination_project_id', '') is null then
      raise exception using errcode = '22023', message = 'Existing-project allocation requires destination_project_id.';
    end if;
  elsif p_request_type = 'REVERSE_UNALLOCATED_MOVEMENT' then
    v_id := (p_payload ->> 'original_movement_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select lots.region_id into v_region_id
    from public.financial_unallocated_fund_movements as movements
    join public.financial_unallocated_fund_lots as lots on lots.id = movements.lot_id
    where movements.id = v_id and movements.transaction_kind = 'NORMAL'
      and movements.movement_type <> 'RESTORE_SOURCE';
  elsif p_request_type in ('CREATE_DECREASE_TRANSFER', 'CREATE_DIRECT_ADJUSTMENT') then
    v_id := (p_payload ->> 'source_budget_year_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_id;
    if p_request_type = 'CREATE_DECREASE_TRANSFER'
       and nullif(p_payload ->> 'destination_project_id', '') is null then
      raise exception using errcode = '22023', message = 'Decrease transfer requires destination_project_id.';
    end if;
    if p_request_type = 'CREATE_DIRECT_ADJUSTMENT'
       and (p_payload ->> 'adjustment_type') not in (
         'RETURN', 'EXTERNAL_DECREASE'
       ) then
      raise exception using errcode = '22023', message = 'Direct adjustment type is invalid.';
    end if;
  elsif p_request_type = 'REVERSE_DECREASE_CLASSIFICATION' then
    v_id := (p_payload ->> 'classification_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select region_id into v_region_id
    from public.financial_project_decrease_classifications where id = v_id;
    if (p_payload ->> 'decrease_amount_before')::bigint
         - (p_payload ->> 'decrease_amount_after')::bigint <> v_amount then
      raise exception using errcode = '22023', message =
        'REVERSE_DECREASE_CLASSIFICATION requires an exact positive decrease reduction.';
    end if;
  elsif p_request_type = 'CLASSIFY_EXISTING_TRANSFER' then
    v_id := (p_payload ->> 'materialized_record_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select projects.region_id into v_region_id
    from public.project_fund_transfers as transfers
    join public.project_budget_years as wallets on wallets.id = transfers.source_budget_year_id
    join public.projects on projects.id = wallets.project_id
    where transfers.id = v_id and transfers.status = 'CONFIRMED'
      and transfers.transaction_kind = 'NORMAL';
  else
    v_id := (p_payload ->> 'materialized_record_id')::uuid;
    v_amount := (p_payload ->> 'amount')::bigint;
    select projects.region_id into v_region_id
    from public.project_budget_adjustments as adjustments
    join public.project_budget_years as wallets on wallets.id = adjustments.budget_year_id
    join public.projects on projects.id = wallets.project_id
    where adjustments.id = v_id and adjustments.status = 'CONFIRMED'
      and adjustments.transaction_kind = 'NORMAL';
  end if;

  if v_region_id is null then
    raise exception using errcode = 'P0002', message = 'Funding reallocation source was not found.';
  end if;
  if v_amount is null or v_amount <= 0 then
    raise exception using errcode = '22023', message = 'Funding reallocation amount must be positive.';
  end if;
  if p_request_type <> 'CREATE_UNALLOCATED_LOT'
     and p_request_type not in ('ALLOCATE_UNALLOCATED_EXISTING', 'RETURN_UNALLOCATED', 'REVERSE_UNALLOCATED_MOVEMENT') then
    if (p_payload ->> 'decrease_amount_before')::bigint < 0
       or (p_payload ->> 'decrease_amount_after')::bigint < 0 then
      raise exception using errcode = '22023', message = 'Decrease classification snapshots are required.';
    end if;
  end if;
  return v_region_id;
exception
  when invalid_text_representation or invalid_datetime_format
    or datetime_field_overflow or numeric_value_out_of_range or null_value_not_allowed then
    raise exception using errcode = '22023', message =
      'Funding reallocation payload contains a malformed or missing UUID, date, or bigint.';
end;
$$;

create or replace function public.financial_create_funding_reallocation_request(
  p_request_type text,
  p_payload jsonb,
  p_idempotency_key uuid,
  p_submit boolean default false
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_region_id uuid;
  v_fingerprint text;
  v_request public.financial_funding_reallocation_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'Idempotency key is required.';
  end if;
  v_region_id := public.financial_validate_funding_reallocation_payload(p_request_type, p_payload);
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Local users may request reallocation only in their own region.';
  end if;
  v_fingerprint := public.financial_request_fingerprint(jsonb_build_object(
    'request_type', p_request_type, 'payload', p_payload
  ));
  select * into v_request from public.financial_funding_reallocation_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message =
        'Idempotency key belongs to another funding-request actor.';
    end if;
    perform public.financial_assert_same_fingerprint(v_request.request_fingerprint, v_fingerprint,
      'financial_funding_reallocation_requests');
    return query select v_request.id, v_request.status;
    return;
  end if;
  insert into public.financial_funding_reallocation_requests (
    request_type, region_id, payload, status, idempotency_key, request_fingerprint,
    requested_by, submitted_by, submitted_at
  ) values (
    p_request_type, v_region_id, p_payload, case when p_submit then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when p_submit then v_actor_id else null end,
    case when p_submit then clock_timestamp() else null end
  ) returning * into v_request;
  perform public.financial_write_audit(null, v_region_id,
    case when p_submit then 'FUNDING_REALLOCATION_SUBMITTED' else 'FUNDING_REALLOCATION_DRAFTED' end,
    'financial_funding_reallocation_requests', v_request.id, v_actor_id,
    jsonb_build_object('request_type', p_request_type));
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_submit_funding_reallocation_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_request public.financial_funding_reallocation_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_funding_reallocation_requests
  where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Funding request was not found.'; end if;
  if v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = 'Only the regional request owner may submit a DRAFT.';
  end if;
  perform public.financial_validate_funding_reallocation_payload(v_request.request_type, v_request.payload);
  update public.financial_funding_reallocation_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_funding_reallocation_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_funding_reallocation_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_funding_reallocation_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' then
    raise exception using errcode = '23514', message = 'Only a SUBMITTED funding request can be approved.';
  end if;
  if v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Requester cannot approve their own funding request.';
  end if;
  perform public.financial_validate_funding_reallocation_payload(v_request.request_type, v_request.payload);
  update public.financial_funding_reallocation_requests
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_reject_funding_reallocation_request(
  p_request_id uuid, p_reason text
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_funding_reallocation_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Rejection reason is required.';
  end if;
  select * into v_request from public.financial_funding_reallocation_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'A different admin may reject only a SUBMITTED request.';
  end if;
  update public.financial_funding_reallocation_requests
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

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

create or replace function public.financial_create_new_project_request(
  p_region_id uuid,
  p_fiscal_year integer,
  p_project_name text,
  p_fund_project_name text,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_project_end_year integer,
  p_status text,
  p_business_type text,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_source_lot_id uuid,
  p_requested_amount bigint,
  p_idempotency_key uuid,
  p_submit boolean default false
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_payload jsonb; v_fingerprint text;
  v_request public.financial_new_project_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_lot from public.financial_unallocated_fund_lots where id = p_source_lot_id;
  if not found or v_lot.region_id <> p_region_id or v_lot.fiscal_year <> p_fiscal_year then
    raise exception using errcode = '23514', message = 'New-project source lot must match request region and fiscal year.';
  end if;
  if v_role = 'local_user' and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Local users may create projects only in their own region.';
  end if;
  if p_idempotency_key is null or p_requested_amount is null or p_requested_amount <= 0
     or p_fiscal_year not between 2000 and 2200
     or char_length(btrim(coalesce(p_project_name, ''))) not between 1 and 500
     or (p_business_type is not null and p_business_type not in ('HW', 'SW', 'COMPOSITE'))
     or ((p_large_category_id is null) <> (p_middle_category_id is null))
     or (p_project_start_year is not null and p_project_end_year is not null
       and p_project_start_year > p_project_end_year) then
    raise exception using errcode = '22023', message = 'Invalid new-project request facts.';
  end if;
  v_payload := jsonb_build_object(
    'region_id', p_region_id, 'fiscal_year', p_fiscal_year,
    'project_name', btrim(p_project_name),
    'fund_project_name', nullif(btrim(p_fund_project_name), ''),
    'detail_project_name', nullif(btrim(p_detail_project_name), ''),
    'project_period', nullif(btrim(p_project_period), ''),
    'project_start_year', p_project_start_year, 'project_end_year', p_project_end_year,
    'project_status', nullif(btrim(p_status), ''), 'business_type', p_business_type,
    'large_category_id', p_large_category_id, 'middle_category_id', p_middle_category_id,
    'source_lot_id', p_source_lot_id, 'requested_amount', p_requested_amount
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_request from public.financial_new_project_requests
  where idempotency_key = p_idempotency_key;
  if found then
    if v_request.requested_by <> v_actor_id then
      raise exception using errcode = '42501', message =
        'Idempotency key belongs to another new-project-request actor.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_request.request_fingerprint, v_fingerprint, 'financial_new_project_requests'
    );
    return query select v_request.id, v_request.status;
    return;
  end if;
  insert into public.financial_new_project_requests (
    region_id, fiscal_year, project_name, fund_project_name, detail_project_name,
    project_period, project_start_year, project_end_year, project_status, business_type,
    large_category_id, middle_category_id, source_lot_id, requested_amount,
    status, idempotency_key, request_fingerprint, requested_by, submitted_by, submitted_at
  ) values (
    p_region_id, p_fiscal_year, btrim(p_project_name), nullif(btrim(p_fund_project_name), ''),
    nullif(btrim(p_detail_project_name), ''), nullif(btrim(p_project_period), ''),
    p_project_start_year, p_project_end_year, nullif(btrim(p_status), ''), p_business_type,
    p_large_category_id, p_middle_category_id, p_source_lot_id, p_requested_amount,
    case when p_submit then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when p_submit then v_actor_id else null end,
    case when p_submit then clock_timestamp() else null end
  ) returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_update_new_project_request_draft(
  p_request_id uuid,
  p_project_name text,
  p_fund_project_name text,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_project_end_year integer,
  p_status text,
  p_business_type text,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_source_lot_id uuid,
  p_requested_amount bigint
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_request public.financial_new_project_requests%rowtype;
  v_lot public.financial_unallocated_fund_lots%rowtype;
  v_payload jsonb;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_new_project_requests
  where id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = 'Only the owner may edit a DRAFT new-project request.';
  end if;
  select * into v_lot from public.financial_unallocated_fund_lots where id = p_source_lot_id;
  if not found or v_lot.region_id <> v_request.region_id
     or v_lot.fiscal_year <> v_request.fiscal_year then
    raise exception using errcode = '23514', message = 'Replacement source lot must match request region/year.';
  end if;
  if p_requested_amount is null or p_requested_amount <= 0
     or char_length(btrim(coalesce(p_project_name, ''))) not between 1 and 500
     or ((p_large_category_id is null) <> (p_middle_category_id is null))
     or (p_business_type is not null and p_business_type not in ('HW', 'SW', 'COMPOSITE'))
     or (p_project_start_year is not null and p_project_end_year is not null
       and p_project_start_year > p_project_end_year) then
    raise exception using errcode = '22023', message = 'Invalid new-project DRAFT facts.';
  end if;
  v_payload := jsonb_build_object(
    'region_id', v_request.region_id, 'fiscal_year', v_request.fiscal_year,
    'project_name', btrim(p_project_name),
    'fund_project_name', nullif(btrim(p_fund_project_name), ''),
    'detail_project_name', nullif(btrim(p_detail_project_name), ''),
    'project_period', nullif(btrim(p_project_period), ''),
    'project_start_year', p_project_start_year, 'project_end_year', p_project_end_year,
    'project_status', nullif(btrim(p_status), ''), 'business_type', p_business_type,
    'large_category_id', p_large_category_id, 'middle_category_id', p_middle_category_id,
    'source_lot_id', p_source_lot_id, 'requested_amount', p_requested_amount
  );
  update public.financial_new_project_requests set
    project_name = btrim(p_project_name),
    fund_project_name = nullif(btrim(p_fund_project_name), ''),
    detail_project_name = nullif(btrim(p_detail_project_name), ''),
    project_period = nullif(btrim(p_project_period), ''),
    project_start_year = p_project_start_year, project_end_year = p_project_end_year,
    project_status = nullif(btrim(p_status), ''), business_type = p_business_type,
    large_category_id = p_large_category_id, middle_category_id = p_middle_category_id,
    source_lot_id = p_source_lot_id, requested_amount = p_requested_amount,
    request_fingerprint = public.financial_request_fingerprint(v_payload)
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_submit_new_project_request(p_request_id uuid)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_request public.financial_new_project_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_new_project_requests where id = p_request_id for update;
  if not found or v_request.status <> 'DRAFT' or v_request.requested_by <> v_actor_id
     or (v_role = 'local_user' and v_request.region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = 'Only the owner may submit a DRAFT new-project request.';
  end if;
  update public.financial_new_project_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_approve_new_project_request(
  p_request_id uuid, p_official_project_code text
)
returns table (request_id uuid, status text, official_project_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_new_project_requests%rowtype;
  v_code text;
begin
  v_actor_id := public.financial_require_admin();
  v_code := btrim(coalesce(p_official_project_code, ''));
  if char_length(v_code) not between 3 and 100
     or v_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$' then
    raise exception using errcode = '22023', message = 'Admin-supplied project_code has an invalid basic format.';
  end if;
  if exists (select 1 from public.projects where project_code = v_code or project_id = v_code) then
    raise exception using errcode = '23505', message = 'Official project_code/project_id already exists.';
  end if;
  select * into v_request from public.financial_new_project_requests where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'A different admin may approve only a SUBMITTED request.';
  end if;
  update public.financial_new_project_requests
  set status = 'APPROVED', official_project_code = v_code,
      approved_by = v_actor_id, approved_at = clock_timestamp()
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status, v_request.official_project_code;
end;
$$;

create or replace function public.financial_reject_new_project_request(
  p_request_id uuid, p_reason text
)
returns table (request_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_request public.financial_new_project_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Rejection reason is required.';
  end if;
  select * into v_request from public.financial_new_project_requests where id = p_request_id for update;
  if not found or v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'A different admin may reject only a SUBMITTED request.';
  end if;
  update public.financial_new_project_requests
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_request.id returning * into v_request;
  return query select v_request.id, v_request.status;
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

-- Ledger-managed projects need a save path that cannot accidentally rewrite
-- protected compatibility finance columns (including legacy NULL values).
create or replace function public.update_my_project_nonfinancial_with_audit(
  p_project_id uuid,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_status varchar,
  p_related_projects jsonb,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_standard_small_category_ids uuid[],
  p_custom_small_categories jsonb,
  p_business_type varchar,
  p_save_mode varchar default 'SAVE'
)
returns table (
  id uuid,
  project_code text,
  alloc bigint,
  exec bigint,
  rate numeric,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_role text;
  v_user_region_id uuid;
  v_project public.projects%rowtype;
  v_related_item jsonb;
  v_related_name text;
  v_related_total_budget bigint;
  v_related_regional_fund_alloc bigint;
  v_related_local_fund_alloc bigint;
  v_related_count integer := 0;
  v_related_names text[] := array[]::text[];
  v_related_input jsonb := coalesce(p_related_projects, '[]'::jsonb);
  v_new_related_projects jsonb := '[]'::jsonb;
  v_old_related_projects jsonb;
  v_old_value jsonb;
  v_new_value jsonb;
  v_updated_at timestamptz := clock_timestamp();
  v_save_mode varchar := upper(btrim(coalesce(p_save_mode, 'SAVE')));
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 사업을 저장할 수 있습니다.';
  end if;
  v_user_role := public.current_user_role()::text;
  v_user_region_id := public.current_user_region_id();
  if v_user_role is null or v_user_role not in ('admin', 'local_user') then
    raise exception using errcode = '42501', message = '사업 수정 권한이 없습니다.';
  end if;
  if v_user_role = 'local_user' and v_user_region_id is null then
    raise exception using errcode = '42501', message = '지역 정보가 없는 사용자는 사업을 수정할 수 없습니다.';
  end if;
  if v_save_mode not in ('DRAFT', 'SAVE') then
    raise exception using errcode = '22023', message = '저장 방식이 올바르지 않습니다.';
  end if;

  select projects.* into v_project
  from public.projects as projects
  where projects.id = p_project_id and projects.project_code is not null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '수정할 사업을 찾을 수 없습니다.';
  end if;
  if not exists (
    select 1 from public.project_budget_years where project_id = v_project.id
  ) then
    raise exception using errcode = '23514', message =
      '비재무 전용 저장은 Ledger 지갑이 있는 사업에만 사용할 수 있습니다.';
  end if;
  if v_user_role = 'local_user' and v_project.region_id is distinct from v_user_region_id then
    raise exception using errcode = '42501', message = '본인 지역의 사업만 수정할 수 있습니다.';
  end if;
  if p_detail_project_name is null
     or char_length(btrim(p_detail_project_name)) not between 2 and 250 then
    raise exception using errcode = '22023', message = '사업명은 2~250자로 입력하세요.';
  end if;
  if p_project_period is null
     or char_length(btrim(p_project_period)) not between 2 and 120 then
    raise exception using errcode = '22023', message = '사업기간은 2~120자로 입력하세요.';
  end if;
  if p_status not in ('정상추진', '지연', '완료', '추진곤란') then
    raise exception using errcode = '22023', message =
      '집행상태는 정상추진, 지연, 완료, 추진곤란 중 하나여야 합니다.';
  end if;
  if p_project_start_year is null or p_project_start_year < 1900
     or (v_project.year is not null and p_project_start_year > v_project.year) then
    raise exception using errcode = '22023', message =
      '시작연도는 사업연도 이하의 유효한 연도여야 합니다.';
  end if;
  if jsonb_typeof(v_related_input) <> 'array' then
    raise exception using errcode = '22023', message = '타 사업 연계 목록 형식이 올바르지 않습니다.';
  end if;

  for v_related_item in select value from jsonb_array_elements(v_related_input)
  loop
    v_related_count := v_related_count + 1;
    if v_related_count > 50 then
      raise exception using errcode = '22023', message = '타 사업 연계는 최대 50건까지 입력할 수 있습니다.';
    end if;
    v_related_name := btrim(v_related_item ->> 'project_name');
    if v_related_name is null or char_length(v_related_name) not between 2 and 200
       or lower(v_related_name) = any(v_related_names) then
      raise exception using errcode = '22023', message =
        '타 사업명은 2~200자로 중복 없이 입력하세요.';
    end if;
    v_related_names := array_append(v_related_names, lower(v_related_name));
    if coalesce(v_related_item ->> 'total_budget', '') !~ '^[0-9]+$'
       or coalesce(v_related_item ->> 'regional_fund_alloc', '') !~ '^[0-9]+$'
       or coalesce(v_related_item ->> 'local_fund_alloc', '') !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message =
        '타 사업 연계 금액은 0 이상의 정수로 입력하세요.';
    end if;
    v_related_total_budget := (v_related_item ->> 'total_budget')::bigint;
    v_related_regional_fund_alloc := (v_related_item ->> 'regional_fund_alloc')::bigint;
    v_related_local_fund_alloc := (v_related_item ->> 'local_fund_alloc')::bigint;
    v_new_related_projects := v_new_related_projects || jsonb_build_array(jsonb_build_object(
      'project_name', v_related_name,
      'total_budget', v_related_total_budget,
      'regional_fund_alloc', v_related_regional_fund_alloc,
      'local_fund_alloc', v_related_local_fund_alloc
    ));
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'project_name', related.project_name,
    'total_budget', related.total_budget,
    'regional_fund_alloc', related.regional_fund_alloc,
    'local_fund_alloc', related.local_fund_alloc
  ) order by related.id), '[]'::jsonb)
    into v_old_related_projects
  from public.project_related_projects as related
  where related.project_id = v_project.id;

  v_old_value := jsonb_build_object(
    'detail_project_name', v_project.detail_project_name,
    'project_period', v_project.project_period,
    'project_start_year', v_project.project_start_year,
    'status', v_project.status,
    'related_projects', v_old_related_projects
  );

  -- Deliberately omit original_alloc, increase_amount, decrease_amount, alloc,
  -- exec, and rate. Their byte-for-byte physical values remain untouched.
  update public.projects as projects
  set detail_project_name = btrim(p_detail_project_name),
      project_period = btrim(p_project_period),
      project_start_year = p_project_start_year,
      status = p_status,
      updated_at = v_updated_at
  where projects.id = v_project.id
  returning projects.* into v_project;

  delete from public.project_related_projects where project_id = v_project.id;
  insert into public.project_related_projects (
    project_id, project_name, total_budget, regional_fund_alloc,
    local_fund_alloc, created_at, updated_at
  )
  select v_project.id, related.project_name, related.total_budget,
    related.regional_fund_alloc, related.local_fund_alloc,
    v_updated_at, v_updated_at
  from jsonb_to_recordset(v_new_related_projects) as related(
    project_name text,
    total_budget bigint,
    regional_fund_alloc bigint,
    local_fund_alloc bigint
  );

  v_new_value := jsonb_build_object(
    'detail_project_name', v_project.detail_project_name,
    'project_period', v_project.project_period,
    'project_start_year', v_project.project_start_year,
    'status', v_project.status,
    'related_projects', v_new_related_projects
  );
  insert into public.audit_logs (
    project_id, region_id, changed_by, action, field_name,
    old_value, new_value, changed_at, created_at, updated_at
  ) values (
    v_project.id, v_project.region_id, v_user_id,
    case when v_save_mode = 'DRAFT' then 'SAVE_MY_PROJECT_DRAFT' else 'SAVE_MY_PROJECT' end,
    'my_project_nonfinancial_details', v_old_value::text, v_new_value::text,
    v_updated_at, v_updated_at, v_updated_at
  );

  perform 1
  from public.update_project_classification_with_custom_small_categories(
    p_project_id, p_large_category_id, p_middle_category_id,
    p_standard_small_category_ids, p_custom_small_categories, p_business_type
  );
  select projects.* into v_project from public.projects as projects
  where projects.id = p_project_id;
  return query select v_project.id, v_project.project_code::text, v_project.alloc,
    v_project.exec, v_project.rate, v_project.updated_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Accounting integration: wallet + pool = cohort funds, never twice
-- ---------------------------------------------------------------------------

create or replace function public.financial_get_budget_year_balance(p_budget_year_id uuid)
returns table (
  accounting_balance bigint,
  reserved_amount bigint,
  available_to_commit bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with wallet as (
    select id, project_id, budget_cohort_id, fiscal_year, legacy_baseline_id
    from public.project_budget_years
    where id = p_budget_year_id
  ), components as (
    select
      coalesce((select sum(cohorts.initial_allocation)::numeric
        from public.project_budget_cohorts as cohorts
        join wallet on wallet.budget_cohort_id = cohorts.id
        where cohorts.source_type in ('STANDARD', 'LEGACY_RECONSTRUCTION')
          and cohorts.origin_project_id = wallet.project_id
          and cohorts.origin_fiscal_year = wallet.fiscal_year), 0::numeric) as initial_amount,
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where destination_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as transfer_in,
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where source_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as transfer_out,
      coalesce((select sum(amount)::numeric from public.project_carryovers
        where destination_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as carryover_in,
      coalesce((select sum(amount)::numeric from public.project_carryovers
        where source_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as carryover_out,
      coalesce((select sum(case when transaction_kind = 'REVERSAL'
        then amount::numeric else -amount::numeric end)
        from public.project_execution_records
        where budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as execution_effect,
      coalesce((select sum((case adjustment_type
          when 'CORRECTION_INCREASE' then amount::numeric else -amount::numeric end)
        * case when transaction_kind = 'REVERSAL' then -1 else 1 end)
        from public.project_budget_adjustments
        where budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as adjustment_effect,
      -- A confirmed lot moves money from a project wallet into pool stock.
      coalesce((select sum(original_amount)::numeric
        from public.financial_unallocated_fund_lots
        where source_budget_year_id = p_budget_year_id and status = 'CONFIRMED'), 0::numeric) as pool_out,
      -- Allocation and linked RESTORE_SOURCE movements move pool stock into a
      -- destination wallet. Reversal subtracts it again. RETURN never enters a
      -- project wallet.
      coalesce((select sum(amount::numeric
          * case when transaction_kind = 'REVERSAL' then -1 else 1 end)
        from public.financial_unallocated_fund_movements
        where destination_budget_year_id = p_budget_year_id
          and movement_type in (
            'ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT', 'RESTORE_SOURCE'
          )), 0::numeric) as pool_in,
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where source_budget_year_id = p_budget_year_id and status = 'PENDING_APPROVAL'), 0::numeric) as pending_reservation
  ), totals as (
    select initial_amount + transfer_in - transfer_out + carryover_in - carryover_out
      + execution_effect + adjustment_effect - pool_out + pool_in as accounting_amount,
      pending_reservation
    from components
  )
  select accounting_amount::bigint, pending_reservation::bigint,
    (accounting_amount - pending_reservation)::bigint
  from totals;
$$;

-- Preserve the original columns/order and append pool/wallet facts. Internal
-- transfer/carryover/pool allocation is excluded from cohort flow totals.
create or replace view public.financial_funding_cohort_execution
with (security_invoker = true)
as
with execution_totals as (
  select budget_years.budget_cohort_id,
    coalesce(sum(case when executions.transaction_kind = 'REVERSAL'
      then -executions.amount else executions.amount end), 0)::bigint as cumulative_execution
  from public.project_budget_years as budget_years
  join public.project_execution_records as executions
    on executions.budget_year_id = budget_years.id and executions.status = 'CONFIRMED'
  group by budget_years.budget_cohort_id
), adjustment_totals as (
  select budget_years.budget_cohort_id,
    coalesce(sum((case adjustments.adjustment_type
      when 'CORRECTION_INCREASE' then adjustments.amount else -adjustments.amount end)
      * case when adjustments.transaction_kind = 'REVERSAL' then -1 else 1 end), 0)::bigint
      as adjustment_effect,
    coalesce(sum(case when adjustments.adjustment_type in (
        'RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_DECREASE'
      )
      then adjustments.amount * case when adjustments.transaction_kind = 'REVERSAL' then -1 else 1 end
      else 0 end), 0)::bigint as project_return_amount
  from public.project_budget_years as budget_years
  join public.project_budget_adjustments as adjustments
    on adjustments.budget_year_id = budget_years.id and adjustments.status = 'CONFIRMED'
  group by budget_years.budget_cohort_id
), pool_totals as (
  select lots.budget_cohort_id,
    coalesce(sum(balances.remaining_amount), 0)::bigint as waiting_balance,
    coalesce(sum(balances.returned_amount), 0)::bigint as pool_return_amount
  from public.financial_unallocated_fund_lots as lots
  join public.financial_unallocated_fund_lot_balances as balances on balances.lot_id = lots.id
  group by lots.budget_cohort_id
), wallet_totals as (
  select wallets.budget_cohort_id,
    coalesce(sum(balance.accounting_balance), 0)::bigint as current_wallet_balance
  from public.project_budget_years as wallets
  cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
  group by wallets.budget_cohort_id
)
select cohorts.id as cohort_id, cohorts.id as funding_reference_id,
  projects.region_id, cohorts.origin_project_id as project_id, cohorts.origin_fiscal_year,
  cohorts.initial_allocation,
  coalesce(execution_totals.cumulative_execution, 0)::bigint as verified_cumulative_execution,
  (cohorts.initial_allocation - coalesce(execution_totals.cumulative_execution, 0)
    + coalesce(adjustment_totals.adjustment_effect, 0)
    - coalesce(pool_totals.pool_return_amount, 0))::bigint as remaining_balance,
  case when cohorts.initial_allocation > 0 then
    round(coalesce(execution_totals.cumulative_execution, 0)::numeric
      * 100 / cohorts.initial_allocation::numeric, 2) else null end as execution_rate,
  cohorts.record_origin, cohorts.evidence_id, cohorts.reconciliation_status,
  'CONFIRMED_LEDGER'::text as ledger_state,
  coalesce(wallet_totals.current_wallet_balance, 0)::bigint as current_wallet_balance,
  coalesce(pool_totals.waiting_balance, 0)::bigint as waiting_balance,
  (coalesce(adjustment_totals.project_return_amount, 0)
    + coalesce(pool_totals.pool_return_amount, 0))::bigint as external_return_amount
from public.project_budget_cohorts as cohorts
join public.projects on projects.id = cohorts.origin_project_id
left join execution_totals on execution_totals.budget_cohort_id = cohorts.id
left join adjustment_totals on adjustment_totals.budget_cohort_id = cohorts.id
left join pool_totals on pool_totals.budget_cohort_id = cohorts.id
left join wallet_totals on wallet_totals.budget_cohort_id = cohorts.id
where cohorts.record_origin = 'SYSTEM_NATIVE'
   or (cohorts.record_origin = 'LEGACY_EXCEL' and cohorts.reconciliation_status = 'RECONCILED')
union all
select null::uuid, entries.id, entries.region_id, entries.project_id,
  entries.origin_fiscal_year, entries.amount, null::bigint, null::bigint,
  null::numeric, 'LEGACY_EXCEL'::text, entries.evidence_id,
  'UNRECONCILED'::text, ('RECONSTRUCTION_' || entries.status)::text,
  null::bigint, null::bigint, null::bigint
from public.legacy_ledger_reconstruction_entries as entries
where entries.event_type = 'ALLOCATION'
  and entries.status in ('DRAFT', 'SUBMITTED', 'VERIFIED');

-- Ledger-derived compatibility projection. The application may display these
-- values instead of mutating projects.alloc/exec/rate. projection_ready=false
-- preserves the visible warning for pre-existing unclassified decreases.
create view public.financial_project_funding_positions
with (security_invoker = true)
as
with wallet_totals as (
  select wallets.project_id,
    coalesce(sum(balance.accounting_balance), 0)::bigint as current_wallet_balance,
    coalesce(sum(executions.confirmed_execution), 0)::bigint as confirmed_execution
  from public.project_budget_years as wallets
  cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
  left join lateral (
    select coalesce(sum(records.amount
      * case when records.transaction_kind = 'REVERSAL' then -1 else 1 end), 0)::bigint
      as confirmed_execution
    from public.project_execution_records as records
    where records.budget_year_id = wallets.id and records.status = 'CONFIRMED'
  ) as executions on true
  group by wallets.project_id
), origin_totals as (
  select cohorts.origin_project_id as project_id,
    coalesce(sum(cohorts.initial_allocation), 0)::bigint as original_allocation
  from public.project_budget_cohorts as cohorts
  where cohorts.record_origin = 'SYSTEM_NATIVE'
     or (cohorts.record_origin = 'LEGACY_EXCEL' and cohorts.reconciliation_status = 'RECONCILED')
  group by cohorts.origin_project_id
), unclassified as (
  select rows.project_id, sum(rows.unclassified_amount)::bigint as unclassified_amount
  from public.financial_unclassified_project_decreases as rows
  group by rows.project_id
)
select projects.id as project_id, projects.region_id, projects.year as fiscal_year,
  coalesce(origins.original_allocation, 0)::bigint as ledger_original_allocation,
  (coalesce(wallets.current_wallet_balance, 0)
    + coalesce(wallets.confirmed_execution, 0))::bigint as ledger_adjusted_allocation,
  greatest((coalesce(wallets.current_wallet_balance, 0)
    + coalesce(wallets.confirmed_execution, 0)) - coalesce(origins.original_allocation, 0), 0)::bigint
    as ledger_increase_amount,
  greatest(coalesce(origins.original_allocation, 0)
    - (coalesce(wallets.current_wallet_balance, 0)
      + coalesce(wallets.confirmed_execution, 0)), 0)::bigint as ledger_decrease_amount,
  coalesce(wallets.confirmed_execution, 0)::bigint as ledger_execution_amount,
  case when coalesce(wallets.current_wallet_balance, 0)
      + coalesce(wallets.confirmed_execution, 0) > 0 then
    round(coalesce(wallets.confirmed_execution, 0)::numeric * 100
      / (coalesce(wallets.current_wallet_balance, 0)
        + coalesce(wallets.confirmed_execution, 0))::numeric, 2)
    else 0::numeric end as ledger_execution_rate,
  coalesce(wallets.current_wallet_balance, 0)::bigint as current_wallet_balance,
  coalesce(unclassified.unclassified_amount, 0)::bigint as unclassified_decrease_amount,
  -- Fail closed until exact raw adjusted allocation + execution coverage is
  -- proven. An immutable pre-inbound attestation keeps later native Ledger
  -- changes visible without comparing them to stale physical compatibility
  -- columns. Carryover-only destinations become ready after their confirmed
  -- lineage inflow and execution reconstruction exactly cover the raw row.
  (coalesce(unclassified.unclassified_amount, 0) = 0
    and (exists (
      select 1 from public.financial_project_baseline_attestations as attestations
      where attestations.project_id = projects.id
    ) or exists (
      select 1 from public.financial_new_project_requests as requests
      where requests.materialized_project_id = projects.id
        and requests.status = 'APPLIED'
    ) or (
      (origins.project_id is not null or exists (
        select 1 from public.project_carryovers as carryovers
        join public.project_budget_years as destination_wallet
          on destination_wallet.id = carryovers.destination_budget_year_id
        where destination_wallet.project_id = projects.id
          and carryovers.status = 'CONFIRMED'
          and carryovers.transaction_kind = 'NORMAL'
      ))
      and (coalesce(wallets.current_wallet_balance, 0)
        + coalesce(wallets.confirmed_execution, 0))
        = greatest(coalesce(projects.alloc,
          projects.original_alloc + coalesce(projects.increase_amount, 0)
            - coalesce(projects.decrease_amount, 0), 0), 0)
      and coalesce(wallets.confirmed_execution, 0) = coalesce(projects.exec, 0)
    )))
    as projection_ready
from public.projects
join wallet_totals as wallets on wallets.project_id = projects.id
left join origin_totals as origins on origins.project_id = projects.id
left join unclassified on unclassified.project_id = projects.id;

-- ---------------------------------------------------------------------------
-- 6. Region-filtered read RPCs and unified project history
-- ---------------------------------------------------------------------------

create or replace function public.get_financial_unclassified_decreases()
returns table (
  project_id uuid, project_code text, project_name text, region_id uuid,
  fiscal_year integer, decrease_amount bigint, classified_amount bigint,
  unclassified_amount bigint, has_budget_year boolean,
  budget_year_id uuid, budget_cohort_id uuid,
  wallet_count bigint, source_selection_required boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query
  select rows.project_id, rows.project_code::text, rows.project_name::text,
    rows.region_id, rows.fiscal_year, rows.decrease_amount, rows.classified_amount,
    rows.unclassified_amount, rows.has_budget_year, rows.budget_year_id, rows.budget_cohort_id,
    rows.wallet_count, rows.source_selection_required
  from public.financial_unclassified_project_decreases as rows
  where v_role = 'admin' or rows.region_id = v_actor_region_id
  order by rows.fiscal_year desc, rows.project_code;
end;
$$;

create or replace function public.get_financial_decrease_classifications(
  p_project_id uuid
)
returns table (
  classification_id uuid,
  outcome_type text,
  original_amount bigint,
  reversed_amount bigint,
  reversible_amount bigint,
  current_decrease_amount bigint,
  canonical_table text,
  canonical_record_id uuid,
  source_budget_year_id uuid,
  region_id uuid,
  fiscal_year integer,
  budget_cohort_id uuid,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  if p_project_id is null then
    raise exception using errcode = '22023', message = 'Project id is required.';
  end if;
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query
  select effects.id, effects.outcome_type::text, effects.amount,
    effects.reversed_amount, effects.reversible_amount,
    sum(effects.classification_effect) over (
      partition by effects.source_project_id
    )::bigint as current_decrease_amount,
    effects.canonical_table::text, effects.canonical_record_id,
    effects.source_budget_year_id, effects.region_id, effects.fiscal_year,
    effects.budget_cohort_id, effects.created_at
  from public.financial_project_decrease_classification_effects as effects
  where effects.source_project_id = p_project_id
    and (v_role = 'admin' or effects.region_id = v_actor_region_id)
  order by effects.created_at desc, effects.id;
end;
$$;

create or replace function public.get_financial_project_funding_positions(
  p_project_id uuid default null
)
returns table (
  project_id uuid, region_id uuid, fiscal_year integer,
  ledger_original_allocation bigint, ledger_adjusted_allocation bigint,
  ledger_increase_amount bigint, ledger_decrease_amount bigint,
  ledger_execution_amount bigint, ledger_execution_rate numeric,
  current_wallet_balance bigint, unclassified_decrease_amount bigint,
  projection_ready boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query select positions.project_id, positions.region_id, positions.fiscal_year,
    positions.ledger_original_allocation, positions.ledger_adjusted_allocation,
    positions.ledger_increase_amount, positions.ledger_decrease_amount,
    positions.ledger_execution_amount, positions.ledger_execution_rate,
    positions.current_wallet_balance, positions.unclassified_decrease_amount,
    positions.projection_ready
  from public.financial_project_funding_positions as positions
  where (v_role = 'admin' or positions.region_id = v_actor_region_id)
    and (p_project_id is null or positions.project_id = p_project_id)
  order by positions.fiscal_year desc, positions.project_id;
end;
$$;

create or replace function public.get_financial_unallocated_fund_lots(
  p_fiscal_year integer default null
)
returns table (
  lot_id uuid, region_id uuid, fiscal_year integer, budget_cohort_id uuid,
  source_project_id uuid, source_budget_year_id uuid,
  source_project_code text, source_project_name text,
  original_amount bigint, allocated_existing_amount bigint,
  allocated_new_amount bigint, returned_amount bigint, remaining_amount bigint,
  balance_status text, reason text, record_origin text, evidence_id uuid,
  effective_date date, created_by uuid, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query
  select rows.lot_id, rows.region_id, rows.fiscal_year, rows.budget_cohort_id,
    rows.source_project_id, rows.source_budget_year_id,
    rows.source_project_code::text, rows.source_project_name::text,
    rows.original_amount, rows.allocated_existing_amount, rows.allocated_new_amount,
    rows.returned_amount, rows.remaining_amount, rows.balance_status, rows.reason,
    rows.record_origin, rows.evidence_id, rows.effective_date, rows.created_by, rows.created_at
  from public.financial_unallocated_fund_lot_balances as rows
  where (v_role = 'admin' or rows.region_id = v_actor_region_id)
    and (p_fiscal_year is null or rows.fiscal_year = p_fiscal_year)
  order by rows.fiscal_year desc, rows.created_at desc;
end;
$$;

create or replace function public.get_financial_funding_reallocation_requests(
  p_status text default null
)
returns setof public.financial_funding_reallocation_requests
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query select requests.*
  from public.financial_funding_reallocation_requests as requests
  where (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_status is null or requests.status = p_status)
  order by requests.requested_at desc;
end;
$$;

create or replace function public.get_financial_new_project_requests(p_status text default null)
returns setof public.financial_new_project_requests
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query select requests.* from public.financial_new_project_requests as requests
  where (v_role = 'admin' or requests.region_id = v_actor_region_id)
    and (p_status is null or requests.status = p_status)
  order by requests.requested_at desc;
end;
$$;

create view public.financial_project_funding_history
with (security_invoker = true)
as
select cohorts.id as event_id, cohorts.origin_project_id as project_id,
  projects.region_id, cohorts.id as budget_cohort_id,
  'INITIAL_ALLOCATION'::text as event_type, cohorts.effective_date as event_date,
  cohorts.initial_allocation as amount, 'IN'::text as direction,
  null::uuid as related_project_id, cohorts.record_origin, cohorts.evidence_id,
  cohorts.memo, cohorts.created_at
from public.project_budget_cohorts as cohorts
join public.projects on projects.id = cohorts.origin_project_id
union all
select executions.id, wallets.project_id, projects.region_id, wallets.budget_cohort_id,
  case when executions.transaction_kind = 'REVERSAL' then 'EXECUTION_REVERSAL' else 'EXECUTION' end,
  executions.execution_date, executions.amount,
  case when executions.transaction_kind = 'REVERSAL' then 'IN' else 'OUT' end,
  null::uuid, executions.record_origin, executions.evidence_id,
  executions.memo, executions.created_at
from public.project_execution_records as executions
join public.project_budget_years as wallets on wallets.id = executions.budget_year_id
join public.projects on projects.id = wallets.project_id
where executions.status = 'CONFIRMED'
union all
select transfers.id, source_wallet.project_id, source_projects.region_id,
  source_wallet.budget_cohort_id,
  case when transfers.transaction_kind = 'REVERSAL' then 'TRANSFER_REVERSAL_OUT' else 'TRANSFER_OUT' end,
  transfers.effective_date, transfers.amount,
  'OUT'::text,
  destination_wallet.project_id, transfers.record_origin, transfers.evidence_id,
  transfers.memo, transfers.created_at
from public.project_fund_transfers as transfers
join public.project_budget_years as source_wallet on source_wallet.id = transfers.source_budget_year_id
join public.project_budget_years as destination_wallet on destination_wallet.id = transfers.destination_budget_year_id
join public.projects as source_projects on source_projects.id = source_wallet.project_id
where transfers.status = 'CONFIRMED'
union all
select transfers.id, destination_wallet.project_id, destination_projects.region_id,
  destination_wallet.budget_cohort_id,
  case when transfers.transaction_kind = 'REVERSAL' then 'TRANSFER_REVERSAL_IN' else 'TRANSFER_IN' end,
  transfers.effective_date, transfers.amount,
  'IN'::text,
  source_wallet.project_id, transfers.record_origin, transfers.evidence_id,
  transfers.memo, transfers.created_at
from public.project_fund_transfers as transfers
join public.project_budget_years as source_wallet on source_wallet.id = transfers.source_budget_year_id
join public.project_budget_years as destination_wallet on destination_wallet.id = transfers.destination_budget_year_id
join public.projects as destination_projects on destination_projects.id = destination_wallet.project_id
where transfers.status = 'CONFIRMED'
union all
select lots.id, lots.source_project_id, lots.region_id, lots.budget_cohort_id,
  'UNALLOCATED_CREATED', lots.effective_date, lots.original_amount, 'OUT',
  null::uuid, lots.record_origin, lots.evidence_id, lots.reason, lots.created_at
from public.financial_unallocated_fund_lots as lots
union all
select movements.id, movements.destination_project_id, movements.region_id,
  movements.budget_cohort_id,
  case
    when movements.transaction_kind = 'REVERSAL' then 'UNALLOCATED_ALLOCATION_REVERSAL'
    when movements.movement_type = 'RESTORE_SOURCE' then 'UNALLOCATED_RESTORED_TO_SOURCE'
    when movements.movement_type = 'ALLOCATE_NEW_PROJECT' then 'UNALLOCATED_TO_NEW_PROJECT'
    else 'UNALLOCATED_TO_EXISTING_PROJECT' end,
  movements.effective_date, movements.amount,
  case when movements.transaction_kind = 'REVERSAL' then 'OUT' else 'IN' end,
  lots.source_project_id, movements.record_origin, movements.evidence_id,
  movements.memo, movements.created_at
from public.financial_unallocated_fund_movements as movements
join public.financial_unallocated_fund_lots as lots on lots.id = movements.lot_id
where movements.destination_project_id is not null
union all
select movements.id, lots.source_project_id, movements.region_id,
  movements.budget_cohort_id,
  case when movements.transaction_kind = 'REVERSAL' then 'UNALLOCATED_RETURN_REVERSAL' else 'RETURN' end,
  movements.effective_date, movements.amount,
  case when movements.transaction_kind = 'REVERSAL' then 'IN' else 'OUT' end,
  null::uuid, movements.record_origin, movements.evidence_id,
  movements.memo, movements.created_at
from public.financial_unallocated_fund_movements as movements
join public.financial_unallocated_fund_lots as lots on lots.id = movements.lot_id
where movements.movement_type = 'RETURN'
union all
select carryovers.id, source_wallet.project_id, source_projects.region_id,
  source_wallet.budget_cohort_id,
  (case when carryovers.carryover_type = 'MYEONGSI' then 'MYEONGSI_CARRYOVER' else 'SAGO_CARRYOVER' end
    || case when carryovers.transaction_kind = 'REVERSAL' then '_REVERSAL' else '' end),
  carryovers.effective_date, carryovers.amount, 'OUT', destination_wallet.project_id,
  carryovers.record_origin, carryovers.evidence_id, carryovers.memo, carryovers.created_at
from public.project_carryovers as carryovers
join public.project_budget_years as source_wallet on source_wallet.id = carryovers.source_budget_year_id
join public.project_budget_years as destination_wallet on destination_wallet.id = carryovers.destination_budget_year_id
join public.projects as source_projects on source_projects.id = source_wallet.project_id
where carryovers.status = 'CONFIRMED'
union all
select carryovers.id, destination_wallet.project_id, destination_projects.region_id,
  destination_wallet.budget_cohort_id,
  (case when carryovers.carryover_type = 'MYEONGSI' then 'MYEONGSI_CARRYOVER' else 'SAGO_CARRYOVER' end
    || case when carryovers.transaction_kind = 'REVERSAL' then '_REVERSAL' else '' end),
  carryovers.effective_date, carryovers.amount, 'IN', source_wallet.project_id,
  carryovers.record_origin, carryovers.evidence_id, carryovers.memo, carryovers.created_at
from public.project_carryovers as carryovers
join public.project_budget_years as source_wallet on source_wallet.id = carryovers.source_budget_year_id
join public.project_budget_years as destination_wallet on destination_wallet.id = carryovers.destination_budget_year_id
join public.projects as destination_projects on destination_projects.id = destination_wallet.project_id
where carryovers.status = 'CONFIRMED'
union all
select adjustments.id, wallets.project_id, projects.region_id, wallets.budget_cohort_id,
  (adjustments.adjustment_type || case when adjustments.transaction_kind = 'REVERSAL'
    then '_REVERSAL' else '' end), adjustments.effective_date, adjustments.amount,
  case
    when (adjustments.adjustment_type = 'CORRECTION_INCREASE')
      <> (adjustments.transaction_kind = 'REVERSAL') then 'IN' else 'OUT' end,
  null::uuid, adjustments.record_origin, adjustments.evidence_id,
  adjustments.memo, adjustments.created_at
from public.project_budget_adjustments as adjustments
join public.project_budget_years as wallets on wallets.id = adjustments.budget_year_id
join public.projects on projects.id = wallets.project_id
where adjustments.status = 'CONFIRMED';

create or replace function public.get_financial_project_funding_history(p_project_id uuid)
returns table (
  event_id uuid, project_id uuid, region_id uuid, budget_cohort_id uuid,
  event_type text, event_date date, amount bigint, direction text,
  related_project_id uuid, record_origin text, evidence_id uuid,
  memo text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid; v_project_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select projects.region_id into v_project_region_id from public.projects where id = p_project_id;
  if v_project_region_id is null then raise exception using errcode = 'P0002', message = 'Project was not found.'; end if;
  if v_role = 'local_user' and v_project_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Local users cannot read another region funding history.';
  end if;
  return query select rows.event_id, rows.project_id, rows.region_id, rows.budget_cohort_id,
    rows.event_type, rows.event_date, rows.amount, rows.direction,
    rows.related_project_id, rows.record_origin, rows.evidence_id, rows.memo, rows.created_at
  from public.financial_project_funding_history as rows
  where rows.project_id = p_project_id
  order by rows.event_date nulls last, rows.created_at, rows.event_id;
end;
$$;

-- One row per (region, origin fiscal year, cohort). A NULL cohort row contains
-- only current unclassified project decreases, so region totals are never
-- repeated once per cohort.
create or replace function public.get_financial_funding_analytics(
  p_fiscal_year integer default null,
  p_sido text default null,
  p_sigungu text default null
)
returns table (
  scope_key text,
  label text,
  region_id uuid,
  sido text,
  sigungu text,
  fiscal_year integer,
  budget_cohort_id uuid,
  initial_allocation_amount bigint,
  confirmed_execution_amount bigint,
  current_wallet_balance bigint,
  unclassified_decrease_amount bigint,
  unclassified_decrease_count bigint,
  decrease_flow_amount bigint,
  reallocated_amount bigint,
  returned_amount bigint,
  waiting_stock_amount bigint,
  waiting_stock_count bigint,
  myeongsi_flow_amount bigint,
  myeongsi_flow_count bigint,
  sago_flow_amount bigint,
  sago_flow_count bigint,
  current_carryover_stock bigint,
  second_sequence_amount bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query
  with classification_totals as (
    select effects.budget_cohort_id,
      coalesce(sum(effects.classification_effect), 0)::bigint as decrease_flow_amount,
      coalesce(sum(case when effects.outcome_type = 'EXISTING_PROJECT_TRANSFER'
        then effects.classification_effect else 0 end), 0)::bigint as direct_reallocated_amount,
      coalesce(sum(case when effects.outcome_type = 'DIRECT_RETURN'
        then effects.classification_effect else 0 end), 0)::bigint as direct_returned_amount
    from public.financial_project_decrease_classification_effects as effects
    group by effects.budget_cohort_id
  ), pool_totals as (
    select lots.budget_cohort_id,
      coalesce(sum(balances.allocated_existing_amount + balances.allocated_new_amount), 0)::bigint
        as pool_reallocated_amount,
      coalesce(sum(balances.returned_amount), 0)::bigint as pool_returned_amount,
      coalesce(sum(balances.remaining_amount), 0)::bigint as waiting_stock_amount,
      count(*) filter (where balances.remaining_amount > 0)::bigint as waiting_stock_count
    from public.financial_unallocated_fund_lots as lots
    join public.financial_unallocated_fund_lot_balances as balances on balances.lot_id = lots.id
    group by lots.budget_cohort_id
  ), carryover_net as (
    select normal.id, normal.source_budget_year_id, normal.destination_budget_year_id,
      normal.carryover_type, normal.carryover_sequence,
      greatest(normal.amount - coalesce(sum(reversals.amount), 0), 0)::bigint as net_amount
    from public.project_carryovers as normal
    left join public.project_carryovers as reversals
      on reversals.reversal_of = normal.id and reversals.transaction_kind = 'REVERSAL'
      and reversals.status = 'CONFIRMED'
    where normal.status = 'CONFIRMED' and normal.transaction_kind = 'NORMAL'
    group by normal.id, normal.source_budget_year_id, normal.destination_budget_year_id,
      normal.carryover_type, normal.carryover_sequence, normal.amount
  ), carryover_totals as (
    select wallets.budget_cohort_id,
      coalesce(sum(case when carryovers.carryover_type = 'MYEONGSI'
        then carryovers.net_amount
        else 0 end), 0)::bigint as myeongsi_flow_amount,
      count(*) filter (where carryovers.carryover_type = 'MYEONGSI'
        and carryovers.net_amount > 0)::bigint as myeongsi_flow_count,
      coalesce(sum(case when carryovers.carryover_type = 'SAGO'
        then carryovers.net_amount
        else 0 end), 0)::bigint as sago_flow_amount,
      count(*) filter (where carryovers.carryover_type = 'SAGO'
        and carryovers.net_amount > 0)::bigint as sago_flow_count,
      coalesce(sum(case when carryovers.carryover_sequence = 2
        then carryovers.net_amount
        else 0 end), 0)::bigint as second_sequence_amount
    from carryover_net as carryovers
    join public.project_budget_years as wallets on wallets.id = carryovers.source_budget_year_id
    group by wallets.budget_cohort_id
  ), carryover_destination_wallets as (
    select distinct destination_wallet.id, destination_wallet.budget_cohort_id
    from carryover_net as inbound
    join public.project_budget_years as destination_wallet
      on destination_wallet.id = inbound.destination_budget_year_id
    where inbound.net_amount > 0
  ), carryover_stock as (
    -- Include every distinct wallet that has an active inbound carryover. Its
    -- accounting balance already nets any partial/full outbound carryover, so
    -- excluding non-terminal wallets would drop a partial-chain remainder.
    select carryover_wallets.budget_cohort_id,
      coalesce(sum(balance.accounting_balance), 0)::bigint as current_carryover_stock
    from carryover_destination_wallets as carryover_wallets
    cross join lateral public.financial_get_budget_year_balance(carryover_wallets.id) as balance
    group by carryover_wallets.budget_cohort_id
  ), cohort_rows as (
    select summaries.region_id, summaries.origin_fiscal_year as fiscal_year,
      summaries.cohort_id as budget_cohort_id, summaries.initial_allocation,
      coalesce(summaries.verified_cumulative_execution, 0)::bigint as confirmed_execution,
      coalesce(summaries.current_wallet_balance, 0)::bigint as wallet_balance,
      coalesce(classifications.decrease_flow_amount, 0)::bigint as decrease_flow,
      (coalesce(classifications.direct_reallocated_amount, 0)
        + coalesce(pool.pool_reallocated_amount, 0))::bigint as reallocated,
      (coalesce(classifications.direct_returned_amount, 0)
        + coalesce(pool.pool_returned_amount, 0))::bigint as returned,
      coalesce(pool.waiting_stock_amount, 0)::bigint as waiting_stock,
      coalesce(pool.waiting_stock_count, 0)::bigint as waiting_count,
      coalesce(carryovers.myeongsi_flow_amount, 0)::bigint as myeongsi_amount,
      coalesce(carryovers.myeongsi_flow_count, 0)::bigint as myeongsi_count,
      coalesce(carryovers.sago_flow_amount, 0)::bigint as sago_amount,
      coalesce(carryovers.sago_flow_count, 0)::bigint as sago_count,
      coalesce(terminal.current_carryover_stock, 0)::bigint as carryover_stock,
      coalesce(carryovers.second_sequence_amount, 0)::bigint as second_sequence
    from public.financial_funding_cohort_execution as summaries
    left join classification_totals as classifications
      on classifications.budget_cohort_id = summaries.cohort_id
    left join pool_totals as pool on pool.budget_cohort_id = summaries.cohort_id
    left join carryover_totals as carryovers on carryovers.budget_cohort_id = summaries.cohort_id
    left join carryover_stock as terminal on terminal.budget_cohort_id = summaries.cohort_id
    where summaries.cohort_id is not null
  ), unclassified_rows as (
    select rows.region_id, rows.fiscal_year,
      sum(rows.unclassified_amount)::bigint as unclassified_amount,
      count(*)::bigint as unclassified_count
    from public.financial_unclassified_project_decreases as rows
    group by rows.region_id, rows.fiscal_year
  ), combined as (
    select cohorts.region_id, cohorts.fiscal_year, cohorts.budget_cohort_id,
      cohorts.initial_allocation as initial_allocation_amount,
      cohorts.confirmed_execution as confirmed_execution_amount,
      cohorts.wallet_balance as current_wallet_balance,
      0::bigint as unclassified_decrease_amount,
      0::bigint as unclassified_decrease_count,
      cohorts.decrease_flow as decrease_flow_amount,
      cohorts.reallocated as reallocated_amount, cohorts.returned as returned_amount,
      cohorts.waiting_stock as waiting_stock_amount, cohorts.waiting_count as waiting_stock_count,
      cohorts.myeongsi_amount as myeongsi_flow_amount, cohorts.myeongsi_count as myeongsi_flow_count,
      cohorts.sago_amount as sago_flow_amount, cohorts.sago_count as sago_flow_count,
      cohorts.carryover_stock as current_carryover_stock,
      cohorts.second_sequence as second_sequence_amount
    from cohort_rows as cohorts
    union all
    select unclassified.region_id, unclassified.fiscal_year, null::uuid,
      0::bigint, 0::bigint, 0::bigint,
      unclassified.unclassified_amount, unclassified.unclassified_count,
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
      0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint
    from unclassified_rows as unclassified
  )
  select (combined.region_id::text || ':' || combined.fiscal_year::text || ':'
      || coalesce(combined.budget_cohort_id::text, 'UNCLASSIFIED'))::text as scope_key,
    (coalesce(nullif(btrim(regions.display_name), ''),
      nullif(btrim(concat_ws(' ', regions.sido, regions.sigungu)), ''), '지역 미상')
      || ' ' || combined.fiscal_year::text)::text as label,
    combined.region_id, regions.sido::text, regions.sigungu::text,
    combined.fiscal_year, combined.budget_cohort_id,
    combined.initial_allocation_amount, combined.confirmed_execution_amount,
    combined.current_wallet_balance, combined.unclassified_decrease_amount,
    combined.unclassified_decrease_count, combined.decrease_flow_amount,
    combined.reallocated_amount, combined.returned_amount,
    combined.waiting_stock_amount, combined.waiting_stock_count,
    combined.myeongsi_flow_amount, combined.myeongsi_flow_count,
    combined.sago_flow_amount, combined.sago_flow_count,
    combined.current_carryover_stock, combined.second_sequence_amount
  from combined
  join public.regions on regions.id = combined.region_id
  where (v_role = 'admin' or combined.region_id = v_actor_region_id)
    and (p_fiscal_year is null or combined.fiscal_year = p_fiscal_year)
    and (p_sido is null or regions.sido = p_sido)
    and (p_sigungu is null or regions.sigungu = p_sigungu)
  order by combined.fiscal_year, combined.region_id, combined.budget_cohort_id nulls last;
end;
$$;

-- Auditable invariants. A non-zero gap is a hard UAT failure.
create view public.financial_funding_invariant_check
with (security_invoker = true)
as
with analytics as (
  select cohorts.cohort_id, cohorts.region_id, cohorts.origin_fiscal_year,
    cohorts.initial_allocation, cohorts.verified_cumulative_execution,
    cohorts.current_wallet_balance, cohorts.waiting_balance,
    cohorts.external_return_amount
  from public.financial_funding_cohort_execution as cohorts
  where cohorts.cohort_id is not null
), correction_in as (
  select wallets.budget_cohort_id,
    coalesce(sum(adjustments.amount * case when adjustments.transaction_kind = 'REVERSAL' then -1 else 1 end)
      filter (where adjustments.adjustment_type = 'CORRECTION_INCREASE'), 0)::bigint as amount
  from public.project_budget_adjustments as adjustments
  join public.project_budget_years as wallets on wallets.id = adjustments.budget_year_id
  where adjustments.status = 'CONFIRMED'
  group by wallets.budget_cohort_id
), decrease_invariants as (
  select cohorts.id as budget_cohort_id,
    (coalesce(classified.decrease_flow, 0)
      - coalesce(classified.direct_resolved, 0)
      - coalesce(pool.pool_reallocated, 0)
      - coalesce(pool.pool_returned, 0)
      - coalesce(pool.waiting_stock, 0))::bigint as decrease_resolution_gap
  from public.project_budget_cohorts as cohorts
  left join lateral (
    select
      coalesce(sum(effects.classification_effect), 0)::bigint as decrease_flow,
      coalesce(sum(case when effects.outcome_type in (
          'EXISTING_PROJECT_TRANSFER', 'DIRECT_RETURN'
        ) then effects.classification_effect else 0 end), 0)::bigint as direct_resolved
    from public.financial_project_decrease_classification_effects as effects
    where effects.budget_cohort_id = cohorts.id
  ) as classified on true
  left join lateral (
    select coalesce(sum(balances.allocated_existing_amount
        + balances.allocated_new_amount), 0)::bigint as pool_reallocated,
      coalesce(sum(balances.returned_amount), 0)::bigint as pool_returned,
      coalesce(sum(balances.remaining_amount), 0)::bigint as waiting_stock
    from public.financial_unallocated_fund_lot_balances as balances
    where balances.budget_cohort_id = cohorts.id
  ) as pool on true
)
select analytics.cohort_id, analytics.region_id, analytics.origin_fiscal_year,
  (analytics.initial_allocation + coalesce(correction_in.amount, 0)
    - coalesce(analytics.verified_cumulative_execution, 0)
    - coalesce(analytics.current_wallet_balance, 0)
    - coalesce(analytics.waiting_balance, 0)
    - coalesce(analytics.external_return_amount, 0))::bigint as cohort_conservation_gap,
  coalesce(decrease_invariants.decrease_resolution_gap, 0)::bigint as decrease_resolution_gap
from analytics
left join correction_in on correction_in.budget_cohort_id = analytics.cohort_id
left join decrease_invariants on decrease_invariants.budget_cohort_id = analytics.cohort_id;

-- The invariant view stays off the direct PostgREST surface. This RPC exposes
-- only the actor's authorized region (or every region for an admin), with an
-- optional cohort filter for focused UAT checks.
create or replace function public.get_financial_funding_invariant_check(
  p_budget_cohort_id uuid default null
)
returns table (
  cohort_id uuid,
  region_id uuid,
  origin_fiscal_year integer,
  cohort_conservation_gap bigint,
  decrease_resolution_gap bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();

  return query
  select invariants.cohort_id, invariants.region_id,
    invariants.origin_fiscal_year, invariants.cohort_conservation_gap,
    invariants.decrease_resolution_gap
  from public.financial_funding_invariant_check as invariants
  where (v_role = 'admin' or invariants.region_id = v_actor_region_id)
    and (p_budget_cohort_id is null
      or invariants.cohort_id = p_budget_cohort_id)
  order by invariants.origin_fiscal_year, invariants.region_id,
    invariants.cohort_id;
end;
$$;

create or replace function public.get_financial_carryover_destinations(
  p_source_budget_year_id uuid
)
returns table (
  destination_project_id uuid,
  project_code text,
  project_name text,
  source_fiscal_year integer,
  destination_fiscal_year integer,
  funding_entry_id uuid,
  origin_fiscal_year integer,
  legacy_prior_carryover_count smallint,
  lineage_id uuid,
  expected_sequence smallint,
  expected_type text,
  available boolean,
  blocked_reason text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid; v_role text; v_actor_region_id uuid;
  v_source_project_id uuid; v_source_region_id uuid;
  v_source_fiscal_year integer; v_cohort_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select wallets.project_id, projects.region_id, wallets.fiscal_year, wallets.budget_cohort_id
    into v_source_project_id, v_source_region_id, v_source_fiscal_year, v_cohort_id
  from public.project_budget_years as wallets
  join public.projects on projects.id = wallets.project_id
  where wallets.id = p_source_budget_year_id;
  if v_source_project_id is null then
    raise exception using errcode = 'P0002', message = 'Carryover source wallet was not found.';
  end if;
  if v_role = 'local_user' and v_source_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Local users cannot read another region carryover candidates.';
  end if;

  return query
  with source_lineages as (
    select members.lineage_id
    from public.financial_project_lineage_members as members
    join public.financial_project_lineages as lineages
      on lineages.id = members.lineage_id and lineages.status = 'VERIFIED'
    where members.project_id = v_source_project_id
      and members.fiscal_year = v_source_fiscal_year
      and members.region_id = v_source_region_id
  ), funding as (
    select entries.id, entries.project_id, entries.origin_fiscal_year,
      entries.legacy_prior_carryover_count
    from public.legacy_ledger_reconstruction_entries as entries
    where entries.event_type = 'ALLOCATION' and entries.status = 'APPLIED'
      and entries.applied_cohort_id = v_cohort_id and entries.region_id = v_source_region_id
    order by entries.applied_at desc
    limit 1
  ), candidates as (
    select projects.id as destination_project_id, projects.project_code::text,
      coalesce(nullif(projects.detail_project_name, ''),
        nullif(projects.fund_project_name, ''), projects.project_name, '-')::text as project_name,
      destination_members.lineage_id,
      funding.id as funding_entry_id, funding.origin_fiscal_year,
      funding.legacy_prior_carryover_count,
      (projects.year - funding.origin_fiscal_year)::smallint as sequence,
      projects.year as destination_year,
      funding.project_id as funding_project_id
    from source_lineages
    join public.financial_project_lineage_members as destination_members
      on destination_members.lineage_id = source_lineages.lineage_id
      and destination_members.fiscal_year = v_source_fiscal_year + 1
      and destination_members.region_id = v_source_region_id
    join public.projects on projects.id = destination_members.project_id
      and projects.year = v_source_fiscal_year + 1
      and projects.region_id = v_source_region_id
      and projects.project_code is not null
    left join funding on true
  )
  select candidates.destination_project_id, candidates.project_code, candidates.project_name,
    v_source_fiscal_year, candidates.destination_year,
    candidates.funding_entry_id, candidates.origin_fiscal_year,
    candidates.legacy_prior_carryover_count, candidates.lineage_id,
    candidates.sequence,
    case candidates.sequence when 1 then 'MYEONGSI' when 2 then 'SAGO' else null end,
    (candidates.funding_entry_id is not null
      and candidates.sequence in (1, 2)
      and (candidates.sequence <> 1 or (
        v_source_project_id = candidates.funding_project_id
        and v_source_fiscal_year = candidates.origin_fiscal_year
      ))
      and (candidates.sequence <> 2 or exists (
        select 1 from public.legacy_ledger_reconstruction_entries as previous
        where previous.funding_entry_id = candidates.funding_entry_id
          and previous.event_type = 'CARRYOVER' and previous.status = 'APPLIED'
          and previous.carryover_sequence = 1
          and previous.destination_project_id = v_source_project_id
          and previous.destination_fiscal_year = v_source_fiscal_year
      ))) as available,
    case
      when candidates.funding_entry_id is null then 'APPLIED Legacy ALLOCATION is required.'
      when candidates.sequence not in (1, 2) then 'Carryover is limited to two occurrences.'
      when candidates.sequence = 1 and (
        v_source_project_id <> candidates.funding_project_id
        or v_source_fiscal_year <> candidates.origin_fiscal_year
      ) then 'First carryover must start from the original allocation project/year.'
      when candidates.sequence = 2 and not exists (
        select 1 from public.legacy_ledger_reconstruction_entries as previous
        where previous.funding_entry_id = candidates.funding_entry_id
          and previous.event_type = 'CARRYOVER' and previous.status = 'APPLIED'
          and previous.carryover_sequence = 1
          and previous.destination_project_id = v_source_project_id
          and previous.destination_fiscal_year = v_source_fiscal_year
      ) then 'Sequence-1 carryover must be APPLIED first.'
      else null end::text as blocked_reason
  from candidates
  order by candidates.project_code;
end;
$$;

create or replace function public.get_financial_verified_legacy_evidence(
  p_region_id uuid default null
)
returns table (
  evidence_id uuid, region_id uuid, source_file_name text,
  source_sheet_name text, source_row_reference text, source_as_of_date date,
  evidence_note text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_actor_id uuid; v_role text; v_actor_region_id uuid; v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  v_region_id := coalesce(p_region_id, v_actor_region_id);
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Local users cannot read another region evidence.';
  end if;
  return query select evidence.id, evidence.region_id, evidence.source_file_name,
    evidence.source_sheet_name, evidence.source_row_reference,
    evidence.source_as_of_date, evidence.evidence_note
  from public.ledger_evidence as evidence
  where evidence.evidence_scope = 'LEGACY_RECONSTRUCTION'
    and evidence.verification_status = 'VERIFIED'
    and (v_region_id is null or evidence.region_id = v_region_id)
  order by evidence.source_as_of_date desc, evidence.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS, RPC-only writes, and no-anon API surface
-- ---------------------------------------------------------------------------

alter table public.financial_unallocated_fund_lots enable row level security;
alter table public.financial_unallocated_fund_movements enable row level security;
alter table public.financial_project_decrease_classifications enable row level security;
alter table public.financial_project_decrease_classification_reversals enable row level security;
alter table public.financial_project_baseline_attestations enable row level security;
alter table public.financial_funding_reallocation_requests enable row level security;
alter table public.financial_new_project_requests enable row level security;
alter table public.financial_unallocated_fund_lots force row level security;
alter table public.financial_unallocated_fund_movements force row level security;
alter table public.financial_project_decrease_classifications force row level security;
alter table public.financial_project_decrease_classification_reversals force row level security;
alter table public.financial_project_baseline_attestations force row level security;
alter table public.financial_funding_reallocation_requests force row level security;
alter table public.financial_new_project_requests force row level security;

create policy financial_unallocated_fund_lots_select_region_or_admin
  on public.financial_unallocated_fund_lots for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_unallocated_fund_lots.region_id))
  );
create policy financial_unallocated_fund_movements_select_region_or_admin
  on public.financial_unallocated_fund_movements for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_unallocated_fund_movements.region_id))
  );
create policy financial_project_decrease_classifications_select_region_or_admin
  on public.financial_project_decrease_classifications for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_project_decrease_classifications.region_id))
  );
create policy financial_project_decrease_classification_reversals_select_region_or_admin
  on public.financial_project_decrease_classification_reversals for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_project_decrease_classification_reversals.region_id))
  );
create policy financial_project_baseline_attestations_select_region_or_admin
  on public.financial_project_baseline_attestations for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_project_baseline_attestations.region_id))
  );
create policy financial_funding_reallocation_requests_select_region_or_admin
  on public.financial_funding_reallocation_requests for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_funding_reallocation_requests.region_id))
  );
create policy financial_new_project_requests_select_region_or_admin
  on public.financial_new_project_requests for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin'
        or region_id = financial_new_project_requests.region_id))
  );

revoke all on table
  public.financial_unallocated_fund_lots,
  public.financial_unallocated_fund_movements,
  public.financial_project_decrease_classifications,
  public.financial_project_decrease_classification_reversals,
  public.financial_project_baseline_attestations,
  public.financial_funding_reallocation_requests,
  public.financial_new_project_requests
from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate, references, trigger on table
  public.financial_unallocated_fund_lots,
  public.financial_unallocated_fund_movements,
  public.financial_project_decrease_classifications,
  public.financial_project_decrease_classification_reversals,
  public.financial_project_baseline_attestations,
  public.financial_funding_reallocation_requests,
  public.financial_new_project_requests
from anon, authenticated, service_role;
grant select on table
  public.financial_unallocated_fund_lots,
  public.financial_unallocated_fund_movements,
  public.financial_project_decrease_classifications,
  public.financial_project_decrease_classification_reversals,
  public.financial_project_baseline_attestations,
  public.financial_funding_reallocation_requests,
  public.financial_new_project_requests
to authenticated, service_role;

revoke all on table
  public.financial_unallocated_fund_lot_balances,
  public.financial_project_decrease_classification_effects,
  public.financial_unclassified_project_decreases,
  public.financial_funding_cohort_execution,
  public.financial_project_funding_positions,
  public.financial_project_funding_history,
  public.financial_funding_invariant_check
from public, anon, authenticated;

-- Server analytics uses supabaseAdmin against the security-invoker projection.
-- Keep user access RPC-only while granting the service role the explicit
-- read chain it needs; all direct DML remains revoked above.
grant select on table
  public.financial_unallocated_fund_lot_balances,
  public.financial_project_decrease_classification_effects,
  public.financial_unclassified_project_decreases,
  public.financial_funding_cohort_execution,
  public.financial_project_funding_positions,
  public.financial_project_funding_history,
  public.financial_funding_invariant_check
to service_role;

revoke all on function public.financial_lock_unallocated_lot_remaining(uuid) from public, anon, authenticated;
revoke all on function public.financial_validate_unallocated_origin() from public, anon, authenticated;
revoke all on function public.financial_validate_unallocated_lot_links() from public, anon, authenticated;
revoke all on function public.financial_validate_unallocated_movement_links() from public, anon, authenticated;
revoke all on function public.financial_validate_decrease_classification_links() from public, anon, authenticated;
revoke all on function public.financial_validate_decrease_classification_reversal_links() from public, anon, authenticated;
revoke all on function public.financial_assert_funding_origin_evidence(uuid,text,date,uuid) from public, anon, authenticated;
revoke all on function public.financial_assert_project_baseline_ready(uuid,bigint,bigint,bigint,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.financial_validate_transfer_project_baselines() from public, anon, authenticated, service_role;
revoke all on function public.financial_validate_execution_project_baseline() from public, anon, authenticated, service_role;
revoke all on function public.financial_validate_adjustment_project_baseline() from public, anon, authenticated, service_role;
revoke all on function public.financial_validate_carryover_project_baselines() from public, anon, authenticated, service_role;
revoke all on function public.financial_validate_cohort_project_baseline() from public, anon, authenticated, service_role;
revoke all on function public.financial_enforce_linked_decrease_reversal() from public, anon, authenticated, service_role;
revoke all on function public.financial_assert_decrease_delta_position(uuid,bigint,bigint,bigint,boolean) from public, anon, authenticated;
revoke all on function public.financial_validate_funding_reallocation_payload(text,jsonb) from public, anon, authenticated;

revoke all on function public.financial_create_funding_reallocation_request(text,jsonb,uuid,boolean) from public, anon;
grant execute on function public.financial_create_funding_reallocation_request(text,jsonb,uuid,boolean) to authenticated;
revoke all on function public.financial_submit_funding_reallocation_request(uuid) from public, anon;
grant execute on function public.financial_submit_funding_reallocation_request(uuid) to authenticated;
revoke all on function public.financial_approve_funding_reallocation_request(uuid) from public, anon;
grant execute on function public.financial_approve_funding_reallocation_request(uuid) to authenticated;
revoke all on function public.financial_reject_funding_reallocation_request(uuid,text) from public, anon;
grant execute on function public.financial_reject_funding_reallocation_request(uuid,text) to authenticated;
revoke all on function public.financial_apply_funding_reallocation_request(uuid) from public, anon;
grant execute on function public.financial_apply_funding_reallocation_request(uuid) to authenticated;
revoke all on function public.get_financial_funding_reallocation_requests(text) from public, anon;
grant execute on function public.get_financial_funding_reallocation_requests(text) to authenticated;

revoke all on function public.financial_create_new_project_request(uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,boolean) from public, anon;
grant execute on function public.financial_create_new_project_request(uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,boolean) to authenticated;
revoke all on function public.financial_update_new_project_request_draft(uuid,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint) from public, anon;
grant execute on function public.financial_update_new_project_request_draft(uuid,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint) to authenticated;
revoke all on function public.financial_submit_new_project_request(uuid) from public, anon;
grant execute on function public.financial_submit_new_project_request(uuid) to authenticated;
revoke all on function public.financial_approve_new_project_request(uuid,text) from public, anon;
grant execute on function public.financial_approve_new_project_request(uuid,text) to authenticated;
revoke all on function public.financial_reject_new_project_request(uuid,text) from public, anon;
grant execute on function public.financial_reject_new_project_request(uuid,text) to authenticated;
revoke all on function public.financial_apply_new_project_request(uuid) from public, anon;
grant execute on function public.financial_apply_new_project_request(uuid) to authenticated;
revoke all on function public.get_financial_new_project_requests(text) from public, anon;
grant execute on function public.get_financial_new_project_requests(text) to authenticated;

revoke all on function public.get_financial_unclassified_decreases() from public, anon;
grant execute on function public.get_financial_unclassified_decreases() to authenticated;
revoke all on function public.get_financial_decrease_classifications(uuid) from public, anon;
grant execute on function public.get_financial_decrease_classifications(uuid) to authenticated;
revoke all on function public.get_financial_project_funding_positions(uuid) from public, anon;
grant execute on function public.get_financial_project_funding_positions(uuid) to authenticated;
revoke all on function public.get_financial_unallocated_fund_lots(integer) from public, anon;
grant execute on function public.get_financial_unallocated_fund_lots(integer) to authenticated;
revoke all on function public.get_financial_project_funding_history(uuid) from public, anon;
grant execute on function public.get_financial_project_funding_history(uuid) to authenticated;
revoke all on function public.get_financial_funding_analytics(integer,text,text) from public, anon;
grant execute on function public.get_financial_funding_analytics(integer,text,text) to authenticated;
revoke all on function public.get_financial_funding_invariant_check(uuid) from public, anon;
grant execute on function public.get_financial_funding_invariant_check(uuid) to authenticated;
revoke all on function public.get_financial_carryover_destinations(uuid) from public, anon;
grant execute on function public.get_financial_carryover_destinations(uuid) to authenticated;
revoke all on function public.get_financial_verified_legacy_evidence(uuid) from public, anon;
grant execute on function public.get_financial_verified_legacy_evidence(uuid) to authenticated;
revoke all on function public.update_my_project_nonfinancial_with_audit(
  uuid,text,text,integer,varchar,jsonb,uuid,uuid,uuid[],jsonb,varchar,varchar
) from public, anon, service_role;
grant execute on function public.update_my_project_nonfinancial_with_audit(
  uuid,text,text,integer,varchar,jsonb,uuid,uuid,uuid[],jsonb,varchar,varchar
) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. End-state proof: the migration itself changed no existing money/project
-- ---------------------------------------------------------------------------

do $$
declare v_snapshot funding_reallocation_migration_snapshot%rowtype;
begin
  select * into v_snapshot from funding_reallocation_migration_snapshot;
  if (select count(*) from public.projects) <> v_snapshot.project_count
     or (select count(*) from public.projects where coalesce(decrease_amount, 0) > 0)
        <> v_snapshot.decreased_project_count
     or (select coalesce(sum(decrease_amount), 0) from public.projects)
        <> v_snapshot.project_decrease_total then
    raise exception using errcode = '55000', message =
      'Funding reallocation migration must not mutate or materialize existing projects/decreases.';
  end if;
  if (select jsonb_agg(to_jsonb(runtime) order by runtime.singleton)
      from public.financial_ledger_runtime as runtime) is distinct from v_snapshot.runtime_rows then
    raise exception using errcode = '55000', message =
      'Funding reallocation migration must not bind or change Ledger runtime.';
  end if;
  if exists (select 1 from public.financial_unallocated_fund_lots)
     or exists (select 1 from public.financial_unallocated_fund_movements)
     or exists (select 1 from public.financial_project_decrease_classifications)
     or exists (select 1 from public.financial_project_decrease_classification_reversals)
     or exists (select 1 from public.financial_project_baseline_attestations)
     or exists (select 1 from public.financial_funding_reallocation_requests)
     or exists (select 1 from public.financial_new_project_requests) then
    raise exception using errcode = '55000', message =
      'Funding reallocation migration must create no UAT transaction or request rows.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
