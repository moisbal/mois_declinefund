-- Reviewed follow-up migration for a fresh TEST Ledger rollout.
--
-- Prerequisites: the reviewed 18/19 Ledger migrations must already have been
-- applied to the target database. This file deliberately does not backfill,
-- infer historical carryovers, or alter Legacy financial source values.
-- Production activation is intentionally not implemented here.

begin;

do $$
begin
  if to_regclass('public.project_budget_cohorts') is null
     or to_regclass('public.project_budget_years') is null
     or to_regclass('public.project_fund_transfers') is null
     or to_regclass('public.project_execution_records') is null
     or to_regclass('public.project_carryovers') is null
     or to_regclass('public.project_budget_adjustments') is null
     or to_regclass('public.financial_ledger_cutovers') is null
     or to_regclass('public.project_financial_baselines') is null then
    raise exception using errcode = '55000', message =
      'Ledger hardening requires reviewed migrations 18 and 19 to be applied first.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_carryovers'
      and column_name = 'effective_date'
  ) then
    raise exception using errcode = '55000', message =
      'Ledger hardening requires project_carryovers.effective_date from migration 19.';
  end if;

  -- This first-run gate prevents a hardening migration from silently changing
  -- semantics of an already-used Ledger. A completed hardening migration can
  -- be reapplied safely; its singleton table is the durable marker.
  if to_regclass('public.financial_ledger_runtime') is null and (
    exists (select 1 from public.project_budget_cohorts)
    or exists (select 1 from public.project_fund_transfers)
    or exists (select 1 from public.project_execution_records)
    or exists (select 1 from public.project_carryovers)
    or exists (select 1 from public.project_budget_adjustments)
    or exists (select 1 from public.financial_ledger_cutovers)
    or exists (select 1 from public.project_financial_baselines)
  ) then
    raise exception using errcode = '55000', message =
      'Existing Ledger rows were found. Do not infer, backfill, or harden in place; use a fresh TEST clone.';
  end if;
end
$$;

-- The runtime row defaults to disabled and unbound. Binding it to TEST is a
-- deliberate service-role operation after the external project-ref preflight.
create table if not exists public.financial_ledger_runtime (
  singleton boolean primary key default true check (singleton),
  environment_kind text not null default 'UNBOUND'
    check (environment_kind in ('UNBOUND', 'TEST', 'PRODUCTION')),
  mode text not null default 'DISABLED'
    check (mode in ('DISABLED', 'TEST')),
  native_start_date date not null default date '2026-09-01'
    check (native_start_date = date '2026-09-01'),
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  reason text,
  constraint financial_ledger_runtime_mode_environment_check
    check (mode = 'DISABLED' or environment_kind = 'TEST'),
  constraint financial_ledger_runtime_reason_length_check
    check (reason is null or char_length(reason) <= 1000)
);

create table if not exists public.financial_ledger_runtime_events (
  id uuid primary key default gen_random_uuid(),
  runtime_singleton boolean not null default true
    references public.financial_ledger_runtime(singleton) on delete restrict,
  event_type text not null check (event_type in ('BOUND_TO_TEST', 'MODE_CHANGED')),
  previous_environment_kind text,
  previous_mode text,
  next_environment_kind text not null,
  next_mode text not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);

insert into public.financial_ledger_runtime (singleton)
values (true)
on conflict (singleton) do nothing;

create or replace function public.financial_prevent_runtime_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message =
    'Ledger runtime event records are append-only.';
end;
$$;

drop trigger if exists financial_ledger_runtime_events_immutable on public.financial_ledger_runtime_events;
create trigger financial_ledger_runtime_events_immutable
  before update or delete on public.financial_ledger_runtime_events
  for each row execute function public.financial_prevent_runtime_event_mutation();

alter table public.financial_ledger_runtime enable row level security;
alter table public.financial_ledger_runtime_events enable row level security;
revoke all on table public.financial_ledger_runtime, public.financial_ledger_runtime_events
  from public, anon, authenticated;

create or replace function public.financial_bind_test_ledger_environment(p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_environment_kind text;
  v_mode text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message =
      'Only the service role may bind a Ledger database to TEST.';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      'A TEST environment binding reason is required.';
  end if;

  select environment_kind, mode into v_environment_kind, v_mode
  from public.financial_ledger_runtime where singleton = true for update;

  if v_environment_kind = 'TEST' then
    return;
  end if;
  if v_environment_kind <> 'UNBOUND' or v_mode <> 'DISABLED' then
    raise exception using errcode = '55000', message =
      'A Ledger runtime may only be bound from the disabled UNBOUND state.';
  end if;

  update public.financial_ledger_runtime
  set environment_kind = 'TEST', changed_by = null, changed_at = clock_timestamp(),
      reason = btrim(p_reason)
  where singleton = true;

  insert into public.financial_ledger_runtime_events (
    event_type, previous_environment_kind, previous_mode,
    next_environment_kind, next_mode, reason, changed_by
  ) values (
    'BOUND_TO_TEST', v_environment_kind, v_mode,
    'TEST', 'DISABLED', btrim(p_reason), null
  );
end;
$$;

create or replace function public.financial_set_ledger_mode(p_mode text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_environment_kind text;
  v_previous_mode text;
begin
  v_actor_id := public.financial_require_admin();
  if p_mode not in ('DISABLED', 'TEST')
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      'Ledger mode (DISABLED or TEST) and a reason are required.';
  end if;

  select environment_kind, mode into v_environment_kind, v_previous_mode
  from public.financial_ledger_runtime where singleton = true for update;
  if v_environment_kind <> 'TEST' then
    raise exception using errcode = '55000', message =
      'The Ledger runtime is not bound to TEST. Production activation is unavailable in this phase.';
  end if;

  update public.financial_ledger_runtime
  set mode = p_mode, changed_by = v_actor_id, changed_at = clock_timestamp(),
      reason = btrim(p_reason)
  where singleton = true;

  insert into public.financial_ledger_runtime_events (
    event_type, previous_environment_kind, previous_mode,
    next_environment_kind, next_mode, reason, changed_by
  ) values (
    'MODE_CHANGED', v_environment_kind, v_previous_mode,
    v_environment_kind, p_mode, btrim(p_reason), v_actor_id
  );
end;
$$;

create or replace function public.financial_require_test_ledger_write(p_effective_date date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_environment_kind text;
  v_mode text;
  v_native_start_date date;
begin
  if p_effective_date is null then
    raise exception using errcode = '22023', message = 'A System Native effective date is required.';
  end if;

  select environment_kind, mode, native_start_date
    into v_environment_kind, v_mode, v_native_start_date
  from public.financial_ledger_runtime
  where singleton = true;

  if v_environment_kind <> 'TEST' or v_mode <> 'TEST' then
    raise exception using errcode = '55000', message =
      'Ledger writes are disabled unless the database is explicitly bound to TEST mode.';
  end if;
  if p_effective_date < v_native_start_date then
    raise exception using errcode = '23514', message =
      'System Native Ledger transactions cannot pre-date 2026-09-01.';
  end if;
end;
$$;

create or replace function public.financial_enforce_system_native_ledger_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_date date;
begin
  if tg_table_name = 'project_execution_records' then
    v_effective_date := new.execution_date;
  else
    v_effective_date := new.effective_date;
  end if;
  perform public.financial_require_test_ledger_write(v_effective_date);
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_fund_transfers_native_start_check'
                 and conrelid = 'public.project_fund_transfers'::regclass) then
    alter table public.project_fund_transfers add constraint project_fund_transfers_native_start_check
      check (effective_date >= date '2026-09-01');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_execution_records_native_start_check'
                 and conrelid = 'public.project_execution_records'::regclass) then
    alter table public.project_execution_records add constraint project_execution_records_native_start_check
      check (execution_date >= date '2026-09-01');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_carryovers_native_start_check'
                 and conrelid = 'public.project_carryovers'::regclass) then
    alter table public.project_carryovers add constraint project_carryovers_native_start_check
      check (effective_date >= date '2026-09-01');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'project_budget_adjustments_native_start_check'
                 and conrelid = 'public.project_budget_adjustments'::regclass) then
    alter table public.project_budget_adjustments add constraint project_budget_adjustments_native_start_check
      check (effective_date >= date '2026-09-01');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'financial_ledger_cutovers_fixed_start_check'
                 and conrelid = 'public.financial_ledger_cutovers'::regclass) then
    alter table public.financial_ledger_cutovers add constraint financial_ledger_cutovers_fixed_start_check
      check (operating_start_date = date '2026-09-01');
  end if;
end;
$$;

drop trigger if exists project_fund_transfers_system_native_guard on public.project_fund_transfers;
create trigger project_fund_transfers_system_native_guard
  before insert or update on public.project_fund_transfers
  for each row execute function public.financial_enforce_system_native_ledger_write();
drop trigger if exists project_execution_records_system_native_guard on public.project_execution_records;
create trigger project_execution_records_system_native_guard
  before insert or update on public.project_execution_records
  for each row execute function public.financial_enforce_system_native_ledger_write();
drop trigger if exists project_carryovers_system_native_guard on public.project_carryovers;
create trigger project_carryovers_system_native_guard
  before insert or update on public.project_carryovers
  for each row execute function public.financial_enforce_system_native_ledger_write();
drop trigger if exists project_budget_adjustments_system_native_guard on public.project_budget_adjustments;
create trigger project_budget_adjustments_system_native_guard
  before insert or update on public.project_budget_adjustments
  for each row execute function public.financial_enforce_system_native_ledger_write();

alter table public.project_budget_cohorts
  add column if not exists system_effective_date date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_budget_cohorts_system_native_date_check'
                 and conrelid = 'public.project_budget_cohorts'::regclass) then
    alter table public.project_budget_cohorts
      add constraint project_budget_cohorts_system_native_date_check check (
        (source_type = 'STANDARD' and system_effective_date >= date '2026-09-01')
        or (source_type = 'LEGACY_BASELINE' and system_effective_date is null)
      );
  end if;
end;
$$;

create or replace function public.financial_enforce_standard_cohort_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source_type = 'STANDARD' then
    perform public.financial_require_test_ledger_write(new.system_effective_date);
  elsif new.source_type <> 'LEGACY_BASELINE' or new.system_effective_date is not null then
    raise exception using errcode = '23514', message =
      'Only dated STANDARD cohorts or undated LEGACY_BASELINE cohorts are valid.';
  end if;
  return new;
end;
$$;

drop trigger if exists project_budget_cohorts_system_native_guard on public.project_budget_cohorts;
create trigger project_budget_cohorts_system_native_guard
  before insert or update on public.project_budget_cohorts
  for each row execute function public.financial_enforce_standard_cohort_write();

-- Legacy review is available while the runtime remains disabled, but the one
-- approved operating start date is fixed for this release.
create or replace function public.financial_create_ledger_cutover(
  p_operating_start_date date,
  p_memo text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_cutover_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if p_operating_start_date <> date '2026-09-01' then
    raise exception using errcode = '23514', message =
      'The approved Ledger operating start date is 2026-09-01.';
  end if;
  if exists (select 1 from public.financial_ledger_cutovers
             where status in ('PREPARING', 'REVIEWING', 'CONFIRMED')) then
    raise exception using errcode = '23505', message =
      'An active or confirmed Ledger Cutover already exists.';
  end if;
  insert into public.financial_ledger_cutovers (
    operating_start_date, baseline_as_of, status, created_by, memo
  ) values (
    p_operating_start_date, date '2026-08-31', 'PREPARING', v_actor_id,
    nullif(btrim(p_memo), '')
  ) returning id into v_cutover_id;
  return v_cutover_id;
end;
$$;

-- Standard cohort creation gains an explicit System Native effective date.
drop function if exists public.create_project_budget_cohort(uuid, integer, bigint, text, text, uuid);
create function public.create_project_budget_cohort(
  p_project_id uuid,
  p_origin_fiscal_year integer,
  p_initial_allocation bigint,
  p_allocation_type text,
  p_memo text,
  p_effective_date date,
  p_idempotency_key uuid
)
returns table (cohort_id uuid, budget_year_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
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
  perform public.financial_require_test_ledger_write(p_effective_date);
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = 'Only an admin may create a first funding cohort.';
  end if;
  if p_idempotency_key is null or p_initial_allocation is null or p_initial_allocation <= 0
     or p_origin_fiscal_year is null or p_origin_fiscal_year not between 2000 and 2200
     or p_allocation_type not in ('INITIAL', 'EXTERNAL_INCREASE') then
    raise exception using errcode = '22023', message = 'Invalid first funding cohort input.';
  end if;
  if p_memo is not null and char_length(btrim(p_memo)) > 1000 then
    raise exception using errcode = '22023', message = 'A cohort memo may contain at most 1,000 characters.';
  end if;

  select region_id, year into v_project_region_id, v_project_year
  from public.projects where id = p_project_id and project_code is not null;
  if v_project_region_id is null then
    raise exception using errcode = 'P0002', message = 'The official project for this cohort was not found.';
  end if;
  if v_project_year is not null and v_project_year <> p_origin_fiscal_year then
    raise exception using errcode = '23514', message = 'The origin fiscal year must match the project year.';
  end if;

  select * into v_cohort from public.project_budget_cohorts where idempotency_key = p_idempotency_key;
  if found then
    v_budget_year_id := public.financial_get_or_create_budget_year(
      v_cohort.origin_project_id, v_cohort.id, v_cohort.origin_fiscal_year, v_actor_id
    );
    return query select v_cohort.id, v_budget_year_id;
    return;
  end if;

  insert into public.project_budget_cohorts (
    origin_project_id, origin_fiscal_year, initial_allocation, allocation_type,
    source_type, system_effective_date, memo, idempotency_key, created_by
  ) values (
    p_project_id, p_origin_fiscal_year, p_initial_allocation, p_allocation_type,
    'STANDARD', p_effective_date, nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id
  ) returning * into v_cohort;

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
      'effective_date', p_effective_date,
      'source_type', 'STANDARD',
      'idempotency_key', v_cohort.idempotency_key
    )
  );
  return query select v_cohort.id, v_budget_year_id;
end;
$$;

-- Evidence-backed logical business lineage. No existing project is assigned
-- automatically; unknown mappings fail closed for carryover.
create table if not exists public.financial_project_lineages (
  id uuid primary key default gen_random_uuid(),
  logical_business_key text not null unique check (char_length(btrim(logical_business_key)) between 1 and 200),
  anchor_project_id uuid not null unique references public.projects(id) on delete restrict,
  evidence_note text not null check (char_length(btrim(evidence_note)) between 1 and 1000),
  idempotency_key uuid not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.financial_project_lineage_members (
  project_id uuid primary key references public.projects(id) on delete restrict,
  lineage_id uuid not null references public.financial_project_lineages(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  evidence_note text not null check (char_length(btrim(evidence_note)) between 1 and 1000),
  idempotency_key uuid not null unique,
  assigned_by uuid not null references public.profiles(id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  unique (lineage_id, fiscal_year)
);

alter table public.financial_project_lineages enable row level security;
alter table public.financial_project_lineage_members enable row level security;
revoke all on table public.financial_project_lineages, public.financial_project_lineage_members
  from public, anon, authenticated;

create or replace function public.financial_validate_project_lineage_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_year integer;
  v_project_region_id uuid;
  v_project_code text;
  v_anchor_region_id uuid;
begin
  select year, region_id, project_code
    into v_project_year, v_project_region_id, v_project_code
  from public.projects where id = new.project_id;
  select projects.region_id into v_anchor_region_id
  from public.financial_project_lineages as lineages
  join public.projects on projects.id = lineages.anchor_project_id
  where lineages.id = new.lineage_id;

  if v_project_year is null or v_project_region_id is null or v_project_code is null then
    raise exception using errcode = '23514', message =
      'Only an official project with a year and region may join a Ledger lineage.';
  end if;
  if new.fiscal_year <> v_project_year then
    raise exception using errcode = '23514', message =
      'A lineage membership fiscal year must equal the project year.';
  end if;
  if v_anchor_region_id is null or v_anchor_region_id <> v_project_region_id then
    raise exception using errcode = '23514', message =
      'All projects in a Ledger lineage must belong to the anchor project region.';
  end if;
  return new;
end;
$$;

create or replace function public.financial_prevent_lineage_member_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message =
    'Ledger lineage memberships are immutable; record a new reviewed lineage instead.';
end;
$$;

create or replace function public.financial_prevent_lineage_project_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.financial_project_lineage_members where project_id = old.id)
     and (new.region_id is distinct from old.region_id
       or new.year is distinct from old.year
       or new.project_code is distinct from old.project_code) then
    raise exception using errcode = '55000', message =
      'A project assigned to a Ledger lineage cannot change region, year, or official project code.';
  end if;
  return new;
end;
$$;

drop trigger if exists financial_project_lineage_members_validate on public.financial_project_lineage_members;
create trigger financial_project_lineage_members_validate
  before insert on public.financial_project_lineage_members
  for each row execute function public.financial_validate_project_lineage_member();
drop trigger if exists financial_project_lineage_members_immutable on public.financial_project_lineage_members;
create trigger financial_project_lineage_members_immutable
  before update or delete on public.financial_project_lineage_members
  for each row execute function public.financial_prevent_lineage_member_mutation();
drop trigger if exists projects_prevent_lineage_identity_mutation on public.projects;
create trigger projects_prevent_lineage_identity_mutation
  before update of region_id, year, project_code on public.projects
  for each row execute function public.financial_prevent_lineage_project_mutation();

create or replace function public.financial_create_logical_project_lineage(
  p_anchor_project_id uuid,
  p_logical_business_key text,
  p_evidence_note text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_lineage_id uuid;
  v_project_code text;
begin
  v_actor_id := public.financial_require_admin();
  if p_idempotency_key is null
     or char_length(btrim(coalesce(p_logical_business_key, ''))) not between 1 and 200
     or char_length(btrim(coalesce(p_evidence_note, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      'A lineage key, evidence note, and idempotency key are required.';
  end if;
  select project_code into v_project_code from public.projects where id = p_anchor_project_id;
  if v_project_code is null then
    raise exception using errcode = '23514', message = 'The lineage anchor must be an official project.';
  end if;
  select id into v_lineage_id from public.financial_project_lineages where idempotency_key = p_idempotency_key;
  if v_lineage_id is not null then return v_lineage_id; end if;

  insert into public.financial_project_lineages (
    logical_business_key, anchor_project_id, evidence_note, idempotency_key, created_by
  ) values (
    btrim(p_logical_business_key), p_anchor_project_id, btrim(p_evidence_note), p_idempotency_key, v_actor_id
  ) returning id into v_lineage_id;
  return v_lineage_id;
end;
$$;

create or replace function public.financial_assign_project_to_lineage(
  p_project_id uuid,
  p_lineage_id uuid,
  p_evidence_note text,
  p_idempotency_key uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_project_year integer;
  v_existing_lineage_id uuid;
  v_region_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if p_idempotency_key is null or char_length(btrim(coalesce(p_evidence_note, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'An evidence note and idempotency key are required.';
  end if;
  select year, region_id into v_project_year, v_region_id from public.projects where id = p_project_id for update;
  if v_project_year is null then
    raise exception using errcode = 'P0002', message = 'The project for lineage assignment was not found.';
  end if;
  select lineage_id into v_existing_lineage_id
  from public.financial_project_lineage_members where project_id = p_project_id;
  if v_existing_lineage_id is not null then
    if v_existing_lineage_id = p_lineage_id then return; end if;
    raise exception using errcode = '55000', message = 'A project already has an immutable Ledger lineage membership.';
  end if;
  if not exists (select 1 from public.financial_project_lineages where id = p_lineage_id) then
    raise exception using errcode = 'P0002', message = 'The requested Ledger lineage was not found.';
  end if;

  insert into public.financial_project_lineage_members (
    project_id, lineage_id, fiscal_year, evidence_note, idempotency_key, assigned_by
  ) values (
    p_project_id, p_lineage_id, v_project_year, btrim(p_evidence_note), p_idempotency_key, v_actor_id
  );
  perform public.financial_write_audit(
    p_project_id, v_region_id, 'ASSIGN_LEDGER_LINEAGE', 'financial_project_lineage_members',
    p_project_id, v_actor_id, jsonb_build_object('lineage_id', p_lineage_id, 'fiscal_year', v_project_year)
  );
end;
$$;

create or replace function public.financial_assert_carryover_same_lineage(
  p_source_project_id uuid,
  p_destination_project_id uuid,
  p_source_fiscal_year integer,
  p_destination_fiscal_year integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_lineage_id uuid;
  v_destination_lineage_id uuid;
  v_source_member_year integer;
  v_destination_member_year integer;
  v_source_region_id uuid;
  v_destination_region_id uuid;
begin
  select members.lineage_id, members.fiscal_year, projects.region_id
    into v_source_lineage_id, v_source_member_year, v_source_region_id
  from public.financial_project_lineage_members as members
  join public.projects on projects.id = members.project_id
  where members.project_id = p_source_project_id;
  select members.lineage_id, members.fiscal_year, projects.region_id
    into v_destination_lineage_id, v_destination_member_year, v_destination_region_id
  from public.financial_project_lineage_members as members
  join public.projects on projects.id = members.project_id
  where members.project_id = p_destination_project_id;

  if v_source_lineage_id is null or v_destination_lineage_id is null then
    raise exception using errcode = '55000', message =
      'Carryover is blocked until both projects have evidence-backed Ledger lineage memberships.';
  end if;
  if v_source_lineage_id <> v_destination_lineage_id
     or v_source_member_year <> p_source_fiscal_year
     or v_destination_member_year <> p_destination_fiscal_year
     or v_source_region_id <> v_destination_region_id
     or p_destination_fiscal_year <> p_source_fiscal_year + 1 then
    raise exception using errcode = '23514', message =
      'Carryover requires the same logical project, region, and immediately following fiscal year.';
  end if;
end;
$$;

create or replace function public.financial_validate_carryover_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_project_id uuid;
  v_destination_project_id uuid;
  v_source_fiscal_year integer;
  v_destination_fiscal_year integer;
begin
  select project_id, fiscal_year into v_source_project_id, v_source_fiscal_year
  from public.project_budget_years where id = new.source_budget_year_id;
  select project_id, fiscal_year into v_destination_project_id, v_destination_fiscal_year
  from public.project_budget_years where id = new.destination_budget_year_id;
  -- A reversal uses the original carryover's opposite direction. The existing
  -- wallet-relationship trigger validates that shape; every NORMAL carryover
  -- is lineage-checked below before a reversal can reference it.
  if new.transaction_kind = 'NORMAL' then
    perform public.financial_assert_carryover_same_lineage(
      v_source_project_id, v_destination_project_id, v_source_fiscal_year, v_destination_fiscal_year
    );
  end if;
  return new;
end;
$$;

drop trigger if exists project_carryovers_validate_lineage on public.project_carryovers;
create trigger project_carryovers_validate_lineage
  before insert or update of source_budget_year_id, destination_budget_year_id on public.project_carryovers
  for each row execute function public.financial_validate_carryover_lineage();

-- Replaced before its destination wallet is created so an incompatible request
-- fails before it can attempt any transient write in the caller transaction.
create or replace function public.create_carryover(
  p_source_budget_year_id uuid,
  p_destination_project_id uuid,
  p_amount bigint,
  p_memo text,
  p_effective_date date,
  p_idempotency_key uuid
)
returns table (carryover_id uuid, carryover_type text, carryover_sequence smallint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_source public.project_budget_years%rowtype;
  v_source_region_id uuid;
  v_destination_region_id uuid;
  v_destination_year integer;
  v_destination_budget_year_id uuid;
  v_origin_year integer;
  v_legacy_status text;
  v_legacy_prior_count smallint;
  v_legacy_baseline_fiscal_year integer;
  v_sequence smallint;
  v_type text;
  v_carryover public.project_carryovers%rowtype;
begin
  perform public.financial_require_test_ledger_write(p_effective_date);
  select actor_id, actor_role into v_actor_id, v_role from public.financial_require_actor();
  if v_role <> 'admin' then
    raise exception using errcode = '42501', message = 'Only an admin may submit a carryover.';
  end if;
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 or p_effective_date is null then
    raise exception using errcode = '22023', message = 'Carryover amount, effective date, and idempotency key are required.';
  end if;
  select * into v_carryover from public.project_carryovers where idempotency_key = p_idempotency_key;
  if found then
    return query select v_carryover.id, v_carryover.carryover_type, v_carryover.carryover_sequence;
    return;
  end if;
  select * into v_source from public.project_budget_years where id = p_source_budget_year_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'The carryover source wallet was not found.';
  end if;
  select region_id into v_source_region_id from public.projects where id = v_source.project_id;
  select region_id, year into v_destination_region_id, v_destination_year
  from public.projects where id = p_destination_project_id and project_code is not null;
  if v_destination_region_id is null then
    raise exception using errcode = 'P0002', message = 'The carryover destination project was not found.';
  end if;
  perform public.financial_assert_carryover_same_lineage(
    v_source.project_id, p_destination_project_id, v_source.fiscal_year, v_destination_year
  );
  if v_destination_region_id <> v_source_region_id
     or v_destination_year is distinct from v_source.fiscal_year + 1 then
    raise exception using errcode = '23514', message =
      'Carryover requires the same region and immediately following fiscal year.';
  end if;

  select origin_fiscal_year, legacy_carryover_status, legacy_prior_carryover_count
    into v_origin_year, v_legacy_status, v_legacy_prior_count
  from public.project_budget_cohorts where id = v_source.budget_cohort_id;
  if v_origin_year is not null then
    v_sequence := v_destination_year - v_origin_year;
  else
    if v_legacy_status is distinct from 'VERIFIED' or v_legacy_prior_count is null then
      raise exception using errcode = '55000', message =
        'An UNKNOWN Legacy Baseline cohort cannot carry over before evidence-backed review.';
    end if;
    select fiscal_year into v_legacy_baseline_fiscal_year from public.project_budget_years
    where budget_cohort_id = v_source.budget_cohort_id and legacy_baseline_id is not null;
    if v_legacy_baseline_fiscal_year is null then
      raise exception using errcode = '23503', message = 'The Legacy Baseline wallet was not found.';
    end if;
    v_sequence := v_legacy_prior_count + (v_source.fiscal_year - v_legacy_baseline_fiscal_year) + 1;
  end if;
  if v_sequence not in (1, 2) then
    raise exception using errcode = '23514', message = 'Carryover is limited to two occurrences.';
  end if;
  v_type := case when v_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
  v_destination_budget_year_id := public.financial_get_or_create_budget_year(
    p_destination_project_id, v_source.budget_cohort_id, v_destination_year, v_actor_id
  );
  perform 1 from public.project_budget_years
  where id = any(array[p_source_budget_year_id, v_destination_budget_year_id]) order by id for update;
  perform public.financial_require_available_amount(
    p_source_budget_year_id, p_amount, 'Insufficient available funds for carryover.'
  );
  insert into public.project_carryovers (
    source_budget_year_id, destination_budget_year_id, amount, carryover_sequence, carryover_type,
    status, transaction_kind, memo, effective_date, idempotency_key, created_by, confirmed_by, confirmed_at
  ) values (
    p_source_budget_year_id, v_destination_budget_year_id, p_amount, v_sequence, v_type,
    'CONFIRMED', 'NORMAL', nullif(btrim(p_memo), ''), p_effective_date,
    p_idempotency_key, v_actor_id, v_actor_id, clock_timestamp()
  ) returning * into v_carryover;
  perform public.financial_write_audit(
    v_source.project_id, v_source_region_id, 'CARRYOVER_CONFIRMED', 'project_carryovers',
    v_carryover.id, v_actor_id, jsonb_build_object(
      'amount', p_amount, 'effective_date', p_effective_date,
      'carryover_type', v_type, 'carryover_sequence', v_sequence,
      'destination_budget_year_id', v_destination_budget_year_id, 'idempotency_key', p_idempotency_key
    )
  );
  return query select v_carryover.id, v_carryover.carryover_type, v_carryover.carryover_sequence;
end;
$$;

-- Explicit grants: internal helpers remain unreachable from API roles, while
-- every exposed RPC performs its own admin/actor validation.
revoke all on function public.financial_prevent_runtime_event_mutation() from public, anon, authenticated;
revoke all on function public.financial_require_test_ledger_write(date) from public, anon, authenticated;
revoke all on function public.financial_enforce_system_native_ledger_write() from public, anon, authenticated;
revoke all on function public.financial_enforce_standard_cohort_write() from public, anon, authenticated;
revoke all on function public.financial_validate_project_lineage_member() from public, anon, authenticated;
revoke all on function public.financial_prevent_lineage_member_mutation() from public, anon, authenticated;
revoke all on function public.financial_prevent_lineage_project_mutation() from public, anon, authenticated;
revoke all on function public.financial_assert_carryover_same_lineage(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.financial_validate_carryover_lineage() from public, anon, authenticated;

revoke all on function public.financial_bind_test_ledger_environment(text) from public, anon, authenticated;
grant execute on function public.financial_bind_test_ledger_environment(text) to service_role;
revoke all on function public.financial_set_ledger_mode(text, text) from public, anon;
grant execute on function public.financial_set_ledger_mode(text, text) to authenticated;
revoke all on function public.financial_create_logical_project_lineage(uuid, text, text, uuid) from public, anon;
grant execute on function public.financial_create_logical_project_lineage(uuid, text, text, uuid) to authenticated;
revoke all on function public.financial_assign_project_to_lineage(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.financial_assign_project_to_lineage(uuid, uuid, text, uuid) to authenticated;
revoke all on function public.create_project_budget_cohort(uuid, integer, bigint, text, text, date, uuid) from public, anon;
grant execute on function public.create_project_budget_cohort(uuid, integer, bigint, text, text, date, uuid) to authenticated;
revoke all on function public.create_carryover(uuid, uuid, bigint, text, date, uuid) from public, anon;
grant execute on function public.create_carryover(uuid, uuid, bigint, text, date, uuid) to authenticated;

revoke insert, update, delete on table public.project_budget_cohorts, public.project_budget_years,
  public.project_fund_transfers, public.project_execution_records, public.project_carryovers,
  public.project_budget_adjustments from anon, authenticated;

notify pgrst, 'reload schema';

commit;
