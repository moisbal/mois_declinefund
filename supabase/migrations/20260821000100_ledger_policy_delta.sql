-- Ledger policy delta for static review only.
--
-- Prerequisites:
--   * 20260819_18_add_financial_ledger.sql and
--     20260819_19_add_legacy_baseline_cutover.sql are already applied.
--   * 20260820000100_ledger_runtime_lineage_hardening.sql is intentionally NOT
--     a prerequisite and must not be run as part of this delta.
--
-- Safety properties:
--   * one transaction and fail-fast preflight;
--   * no projects/regions/profiles data writes and no historical auto-import;
--   * runtime remains UNBOUND / DISABLED after this migration;
--   * all API writes go through reviewed SECURITY DEFINER RPCs.

begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 0. Fail-fast compatibility and empty-ledger gate
-- ---------------------------------------------------------------------------

do $$
declare
  v_table regclass;
  v_table_name text;
  v_row_count bigint;
begin
  foreach v_table_name in array array[
    'public.project_budget_cohorts',
    'public.project_budget_years',
    'public.project_fund_transfers',
    'public.project_execution_records',
    'public.project_carryovers',
    'public.project_budget_adjustments',
    'public.financial_ledger_cutovers',
    'public.project_financial_baselines',
    'public.project_baseline_corrections',
    'public.project_metadata_history'
  ]
  loop
    v_table := to_regclass(v_table_name);
    if v_table is null then
      raise exception using errcode = '55000', message =
        format('Ledger policy delta prerequisite table is missing: %s', v_table_name);
    end if;
    execute format('select count(*) from %s', v_table) into v_row_count;
    if v_row_count <> 0 then
      raise exception using errcode = '55000', message =
        format('Ledger policy delta requires zero rows in %s; found %s.', v_table_name, v_row_count);
    end if;
  end loop;

  if to_regprocedure('public.financial_require_actor()') is null
     or to_regprocedure('public.financial_require_admin()') is null
     or to_regprocedure('public.financial_get_or_create_budget_year(uuid,uuid,integer,uuid)') is null
     or to_regprocedure('public.financial_get_budget_year_balance(uuid)') is null
     or to_regprocedure('public.financial_require_available_amount(uuid,bigint,text)') is null
     or to_regprocedure('public.financial_write_audit(uuid,uuid,text,text,uuid,uuid,jsonb)') is null
     or to_regprocedure('public.create_or_submit_transfer(uuid,uuid,bigint,text,text,date,uuid,boolean)') is null
     or to_regprocedure('public.confirm_execution(uuid,bigint,date,text,uuid)') is null
     or to_regprocedure('public.create_carryover(uuid,uuid,bigint,text,date,uuid)') is null
     or to_regprocedure('public.financial_create_ledger_cutover(date,text)') is null
     or to_regprocedure('public.create_project_budget_cohort(uuid,integer,bigint,text,text,uuid)') is null
     or to_regprocedure('public.financial_review_legacy_baseline(uuid,text,text)') is null then
    raise exception using errcode = '55000', message =
      'Ledger policy delta found an unexpected migration-18/19 function signature set.';
  end if;

  if to_regclass('public.financial_ledger_runtime') is not null
     or to_regclass('public.financial_project_lineages') is not null then
    raise exception using errcode = '55000', message =
      'The superseded runtime/lineage hardening draft appears to have been applied. Stop and diagnose; do not layer this delta over it.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Shared fingerprints, runtime binding, and write-origin policy
-- ---------------------------------------------------------------------------

create or replace function public.financial_request_fingerprint(p_payload jsonb)
returns text
language sql
immutable
strict
security definer
set search_path = public, pg_temp
as $$
  select encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.financial_assert_same_fingerprint(
  p_existing text,
  p_requested text,
  p_entity text
)
returns void
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_existing is distinct from p_requested then
    raise exception using errcode = '23505', message =
      format('Idempotency key payload mismatch for %s.', coalesce(p_entity, 'Ledger request'));
  end if;
end;
$$;

create table public.financial_ledger_runtime (
  singleton boolean primary key default true check (singleton),
  environment_kind text not null default 'UNBOUND'
    check (environment_kind in ('UNBOUND', 'TEST')),
  mode text not null default 'DISABLED'
    constraint financial_ledger_runtime_mode_value_check
    check (mode in ('DISABLED', 'RECONCILIATION', 'TEST')),
  bound_project_ref text,
  baseline_as_of date not null default date '2026-08-31'
    check (baseline_as_of = date '2026-08-31'),
  native_start_date date not null default date '2026-09-01'
    check (native_start_date = date '2026-09-01'),
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  reason text,
  constraint financial_ledger_runtime_binding_check check (
    (environment_kind = 'UNBOUND' and mode = 'DISABLED' and bound_project_ref is null)
    or (environment_kind = 'TEST' and bound_project_ref is not null
        and char_length(btrim(bound_project_ref)) between 6 and 100)
  ),
  constraint financial_ledger_runtime_mode_environment_check check (
    mode = 'DISABLED' or environment_kind = 'TEST'
  ),
  constraint financial_ledger_runtime_reason_length_check check (
    reason is null or char_length(reason) <= 1000
  )
);

create table public.financial_ledger_runtime_events (
  id uuid primary key default gen_random_uuid(),
  runtime_singleton boolean not null default true
    references public.financial_ledger_runtime(singleton) on delete restrict,
  event_type text not null check (event_type in ('BOUND_TO_TEST', 'MODE_CHANGED')),
  previous_environment_kind text not null,
  previous_mode text not null,
  previous_bound_project_ref text,
  next_environment_kind text not null,
  next_mode text not null,
  next_bound_project_ref text,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp()
);

insert into public.financial_ledger_runtime (singleton)
values (true);

create or replace function public.financial_prevent_append_only_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message =
    format('%s records are append-only.', tg_table_name);
end;
$$;

create trigger financial_ledger_runtime_events_immutable
  before update or delete on public.financial_ledger_runtime_events
  for each row execute function public.financial_prevent_append_only_mutation();

create or replace function public.financial_bind_test_ledger_environment(
  p_expected_project_ref text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message =
      'Only service_role may bind this database to a previously verified TEST project ref.';
  end if;
  if char_length(btrim(coalesce(p_expected_project_ref, ''))) not between 6 and 100
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      'A verified TEST project ref and binding reason are required.';
  end if;

  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true
  for update;

  if v_runtime.environment_kind = 'TEST' then
    if v_runtime.bound_project_ref is distinct from btrim(p_expected_project_ref) then
      raise exception using errcode = '55000', message =
        'Ledger runtime is already bound to a different TEST project ref.';
    end if;
    return;
  end if;
  if v_runtime.environment_kind <> 'UNBOUND' or v_runtime.mode <> 'DISABLED'
     or v_runtime.bound_project_ref is not null then
    raise exception using errcode = '55000', message =
      'Ledger binding is only allowed from UNBOUND / DISABLED.';
  end if;

  update public.financial_ledger_runtime
  set environment_kind = 'TEST',
      bound_project_ref = btrim(p_expected_project_ref),
      changed_by = null,
      changed_at = clock_timestamp(),
      reason = btrim(p_reason)
  where singleton = true;

  insert into public.financial_ledger_runtime_events (
    event_type, previous_environment_kind, previous_mode, previous_bound_project_ref,
    next_environment_kind, next_mode, next_bound_project_ref, reason, changed_by
  ) values (
    'BOUND_TO_TEST', v_runtime.environment_kind, v_runtime.mode, v_runtime.bound_project_ref,
    'TEST', 'DISABLED', btrim(p_expected_project_ref), btrim(p_reason), null
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
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if p_mode not in ('DISABLED', 'RECONCILIATION', 'TEST')
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      'Ledger mode must be DISABLED, RECONCILIATION, or TEST and requires a reason.';
  end if;
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true
  for update;
  if v_runtime.environment_kind <> 'TEST' or v_runtime.bound_project_ref is null then
    raise exception using errcode = '55000', message =
      'Ledger mode cannot change until the database is bound to a verified TEST project ref.';
  end if;
  if v_runtime.mode = p_mode then
    return;
  end if;

  update public.financial_ledger_runtime
  set mode = p_mode,
      changed_by = v_actor_id,
      changed_at = clock_timestamp(),
      reason = btrim(p_reason)
  where singleton = true;

  insert into public.financial_ledger_runtime_events (
    event_type, previous_environment_kind, previous_mode, previous_bound_project_ref,
    next_environment_kind, next_mode, next_bound_project_ref, reason, changed_by
  ) values (
    'MODE_CHANGED', v_runtime.environment_kind, v_runtime.mode, v_runtime.bound_project_ref,
    v_runtime.environment_kind, p_mode, v_runtime.bound_project_ref, btrim(p_reason), v_actor_id
  );
  perform public.financial_write_audit(
    null, null, 'LEDGER_RUNTIME_MODE_CHANGED', 'financial_ledger_runtime', null,
    v_actor_id, jsonb_build_object('previous_mode', v_runtime.mode, 'next_mode', p_mode)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Purpose-scoped source evidence
-- ---------------------------------------------------------------------------

create table public.ledger_evidence (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  evidence_scope text not null check (evidence_scope in (
    'LEGACY_RECONSTRUCTION', 'BASELINE', 'PROJECT_LINEAGE', 'NATIVE_TRANSACTION'
  )),
  source_type text not null check (source_type in ('LEGACY_EXCEL', 'LEGACY_EXPORT', 'SIGNED_DOCUMENT')),
  source_system text not null check (char_length(btrim(source_system)) between 1 and 200),
  source_file_name text not null check (char_length(btrim(source_file_name)) between 1 and 500),
  source_file_sha256 text not null check (source_file_sha256 ~ '^[0-9a-f]{64}$'),
  source_sheet_name text check (source_sheet_name is null or char_length(source_sheet_name) <= 200),
  source_row_reference text check (source_row_reference is null or char_length(source_row_reference) <= 200),
  external_reference text check (external_reference is null or char_length(external_reference) <= 500),
  evidence_note text check (evidence_note is null or char_length(evidence_note) <= 1000),
  source_as_of_date date not null,
  import_batch_id uuid not null,
  verification_status text not null default 'DRAFT'
    check (verification_status in ('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED')),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  submitted_by uuid references public.profiles(id) on delete restrict,
  submitted_at timestamptz,
  verified_by uuid references public.profiles(id) on delete restrict,
  verified_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  constraint ledger_evidence_scope_date_check check (
    (evidence_scope in ('LEGACY_RECONSTRUCTION', 'BASELINE')
      and source_as_of_date between date '2022-01-01' and date '2026-08-31')
    or (evidence_scope = 'PROJECT_LINEAGE' and source_as_of_date >= date '2022-01-01')
    or (evidence_scope = 'NATIVE_TRANSACTION' and source_as_of_date >= date '2026-09-01')
  ),
  constraint ledger_evidence_submission_shape check (
    (verification_status = 'DRAFT' and submitted_by is null and submitted_at is null
      and verified_by is null and verified_at is null and rejected_by is null and rejected_at is null)
    or (verification_status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and verified_by is null and verified_at is null and rejected_by is null and rejected_at is null)
    or (verification_status = 'VERIFIED' and submitted_by is not null and submitted_at is not null
      and verified_by is not null and verified_at is not null and verified_by <> created_by
      and rejected_by is null and rejected_at is null)
    or (verification_status = 'REJECTED' and submitted_by is not null and submitted_at is not null
      and rejected_by is not null and rejected_at is not null and rejected_by <> created_by
      and rejection_reason is not null)
  )
);

create index ledger_evidence_region_status_idx
  on public.ledger_evidence(region_id, verification_status, source_as_of_date);
create index ledger_evidence_file_hash_idx
  on public.ledger_evidence(source_file_sha256, import_batch_id);

create or replace function public.financial_validate_evidence_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Ledger evidence cannot be deleted.';
  end if;
  if old.verification_status in ('VERIFIED', 'REJECTED') then
    raise exception using errcode = '55000', message = 'Terminal Ledger evidence is immutable.';
  end if;
  if old.verification_status = 'DRAFT' and new.verification_status = 'DRAFT' then
    if row(new.region_id, new.idempotency_key, new.created_by, new.created_at)
       is distinct from
       row(old.region_id, old.idempotency_key, old.created_by, old.created_at) then
      raise exception using errcode = '55000', message = 'Ledger evidence identity is immutable.';
    end if;
    return new;
  end if;
  if row(
       new.region_id, new.evidence_scope, new.source_type, new.source_system, new.source_file_name,
       new.source_file_sha256, new.source_sheet_name, new.source_row_reference,
       new.external_reference, new.evidence_note, new.source_as_of_date,
       new.import_batch_id, new.idempotency_key, new.request_fingerprint,
       new.created_by, new.created_at
     ) is distinct from row(
       old.region_id, old.evidence_scope, old.source_type, old.source_system, old.source_file_name,
       old.source_file_sha256, old.source_sheet_name, old.source_row_reference,
       old.external_reference, old.evidence_note, old.source_as_of_date,
       old.import_batch_id, old.idempotency_key, old.request_fingerprint,
       old.created_by, old.created_at
     ) then
    raise exception using errcode = '55000', message = 'Ledger evidence source facts are immutable.';
  end if;
  if not (
    (old.verification_status = 'DRAFT' and new.verification_status = 'SUBMITTED')
    or (old.verification_status = 'SUBMITTED' and new.verification_status in ('VERIFIED', 'REJECTED'))
  ) then
    raise exception using errcode = '23514', message = 'Invalid Ledger evidence state transition.';
  end if;
  return new;
end;
$$;

create trigger ledger_evidence_immutable
  before update or delete on public.ledger_evidence
  for each row execute function public.financial_validate_evidence_mutation();

-- ---------------------------------------------------------------------------
-- 3. Normalized, evidence-backed funding lineage
-- ---------------------------------------------------------------------------

create table public.financial_project_lineages (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED')),
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  submitted_by uuid references public.profiles(id) on delete restrict,
  submitted_at timestamptz,
  verified_by uuid references public.profiles(id) on delete restrict,
  verified_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  constraint financial_project_lineages_state_shape check (
    (status = 'DRAFT' and submitted_by is null and verified_by is null and rejected_by is null)
    or (status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and verified_by is null and rejected_by is null)
    or (status = 'VERIFIED' and submitted_by is not null and verified_by is not null
      and verified_at is not null and verified_by <> created_by and rejected_by is null)
    or (status = 'REJECTED' and submitted_by is not null and rejected_by is not null
      and rejected_at is not null and rejected_by <> created_by and rejection_reason is not null)
  )
);

create table public.financial_project_lineage_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  lineage_id uuid not null references public.financial_project_lineages(id) on delete restrict,
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  evidence_id uuid not null references public.ledger_evidence(id) on delete restrict,
  assigned_by uuid not null references public.profiles(id) on delete restrict,
  assigned_at timestamptz not null default clock_timestamp(),
  unique (lineage_id, project_id),
  unique (lineage_id, fiscal_year)
);

create index financial_project_lineages_region_status_idx
  on public.financial_project_lineages(region_id, status);
create index financial_project_lineage_members_project_idx
  on public.financial_project_lineage_members(project_id, lineage_id);

create or replace function public.financial_validate_project_lineage_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_region_id uuid;
  v_project_year integer;
  v_lineage_region_id uuid;
  v_lineage_status text;
  v_evidence_region_id uuid;
  v_evidence_scope text;
  v_evidence_status text;
begin
  select region_id, year
    into v_project_region_id, v_project_year
  from public.projects
  where id = new.project_id;
  select region_id, status
    into v_lineage_region_id, v_lineage_status
  from public.financial_project_lineages
  where id = new.lineage_id;
  select region_id, evidence_scope, verification_status
    into v_evidence_region_id, v_evidence_scope, v_evidence_status
  from public.ledger_evidence
  where id = new.evidence_id;
  if v_project_region_id is null or v_project_year is null then
    raise exception using errcode = '23514', message =
      'Lineage members require an existing project with region and fiscal year.';
  end if;
  if v_lineage_status <> 'DRAFT' then
    raise exception using errcode = '55000', message =
      'Lineage members may only be changed while the lineage is DRAFT.';
  end if;
  if new.region_id <> v_project_region_id or new.region_id <> v_lineage_region_id
     or new.region_id <> v_evidence_region_id or new.fiscal_year <> v_project_year
     or v_evidence_scope <> 'PROJECT_LINEAGE' or v_evidence_status = 'REJECTED' then
    raise exception using errcode = '23514', message =
      'Every lineage member must match the lineage/project region and fiscal year and use non-rejected PROJECT_LINEAGE evidence.';
  end if;
  return new;
end;
$$;

create trigger financial_project_lineage_members_validate
  before insert or update on public.financial_project_lineage_members
  for each row execute function public.financial_validate_project_lineage_member();

create or replace function public.financial_validate_lineage_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.status in ('VERIFIED', 'REJECTED') then
    raise exception using errcode = '55000', message = 'Verified/rejected funding lineage is immutable.';
  end if;
  if old.status = 'DRAFT' and new.status = 'DRAFT' then
    if row(new.region_id, new.idempotency_key, new.created_by, new.created_at)
       is distinct from
       row(old.region_id, old.idempotency_key, old.created_by, old.created_at) then
      raise exception using errcode = '55000', message = 'Funding lineage identity is immutable.';
    end if;
    return new;
  end if;
  if row(new.region_id, new.reason, new.idempotency_key,
         new.request_fingerprint, new.created_by, new.created_at)
     is distinct from
     row(old.region_id, old.reason, old.idempotency_key,
         old.request_fingerprint, old.created_by, old.created_at) then
    raise exception using errcode = '55000', message = 'Funding lineage facts are immutable.';
  end if;
  if not (
    (old.status = 'DRAFT' and new.status = 'SUBMITTED')
    or (old.status = 'SUBMITTED' and new.status in ('VERIFIED', 'REJECTED'))
  ) then
    raise exception using errcode = '23514', message = 'Invalid funding lineage state transition.';
  end if;
  return new;
end;
$$;

create or replace function public.financial_validate_lineage_member_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lineage_id uuid;
begin
  v_lineage_id := case when tg_op = 'DELETE' then old.lineage_id else new.lineage_id end;
  if not exists (
    select 1 from public.financial_project_lineages
    where id = v_lineage_id and status = 'DRAFT'
  ) then
    raise exception using errcode = '55000', message =
      'Lineage members are immutable after the lineage is submitted.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger financial_project_lineages_immutable
  before update or delete on public.financial_project_lineages
  for each row execute function public.financial_validate_lineage_mutation();

create trigger financial_project_lineage_members_immutable
  before update or delete on public.financial_project_lineage_members
  for each row execute function public.financial_validate_lineage_member_mutation();

-- ---------------------------------------------------------------------------
-- 4. Origin/evidence/fingerprint columns on the existing Ledger
-- ---------------------------------------------------------------------------

alter table public.project_budget_cohorts
  add column effective_date date not null,
  add column record_origin text not null,
  add column evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  add column request_fingerprint text not null,
  add column reconciliation_status text not null;

alter table public.project_fund_transfers
  add column record_origin text not null,
  add column evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  add column request_fingerprint text not null;

alter table public.project_execution_records
  add column record_origin text not null,
  add column evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  add column request_fingerprint text not null;

alter table public.project_carryovers
  add column record_origin text not null,
  add column evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  add column request_fingerprint text not null;

alter table public.project_budget_adjustments
  add column record_origin text not null,
  add column evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  add column request_fingerprint text not null;

alter table public.project_budget_cohorts
  drop constraint if exists project_budget_cohorts_source_type_check,
  drop constraint if exists project_budget_cohorts_origin_year_by_source_check,
  drop constraint if exists project_budget_cohorts_legacy_carryover_state_check;

alter table public.project_budget_cohorts
  add constraint project_budget_cohorts_source_type_policy_check check (
    source_type in ('STANDARD', 'LEGACY_RECONSTRUCTION')
  ),
  add constraint project_budget_cohorts_origin_policy_check check (
    origin_fiscal_year between 2000 and 2200
    and (
      (source_type = 'STANDARD'
        and record_origin = 'SYSTEM_NATIVE'
        and evidence_id is null
        and initial_allocation > 0
        and legacy_carryover_status is null
        and legacy_prior_carryover_count is null)
      or
      (source_type = 'LEGACY_RECONSTRUCTION'
        and record_origin = 'LEGACY_EXCEL'
        and evidence_id is not null
        and initial_allocation >= 0
        and legacy_carryover_status = 'VERIFIED'
        and legacy_prior_carryover_count = 0
        and extract(year from effective_date)::integer = origin_fiscal_year)
    )
  ),
  add constraint project_budget_cohorts_origin_date_check check (
    (record_origin = 'SYSTEM_NATIVE' and effective_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and effective_date between date '2022-01-01' and date '2026-08-31')
  ),
  add constraint project_budget_cohorts_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint project_budget_cohorts_reconciliation_check
    check (reconciliation_status in ('RECONCILED', 'UNRECONCILED'));

alter table public.project_fund_transfers
  add constraint project_fund_transfers_origin_policy_check check (
    (record_origin = 'SYSTEM_NATIVE' and evidence_id is null and effective_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and evidence_id is not null
      and effective_date between date '2022-01-01' and date '2026-08-31')
  ),
  add constraint project_fund_transfers_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$');

alter table public.project_execution_records
  add constraint project_execution_records_origin_policy_check check (
    (record_origin = 'SYSTEM_NATIVE' and evidence_id is null and execution_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and evidence_id is not null
      and execution_date between date '2022-01-01' and date '2026-08-31')
  ),
  add constraint project_execution_records_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$');

alter table public.project_carryovers
  add constraint project_carryovers_origin_policy_check check (
    (record_origin = 'SYSTEM_NATIVE' and evidence_id is null and effective_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and evidence_id is not null
      and effective_date between date '2022-01-01' and date '2026-08-31')
  ),
  add constraint project_carryovers_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$');

alter table public.project_budget_adjustments
  add constraint project_budget_adjustments_origin_policy_check check (
    (record_origin = 'SYSTEM_NATIVE' and evidence_id is null and effective_date >= date '2026-09-01')
    or
    (record_origin = 'LEGACY_EXCEL' and evidence_id is not null
      and effective_date between date '2022-01-01' and date '2026-08-31')
  ),
  add constraint project_budget_adjustments_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$');

create or replace function public.financial_require_ledger_write(
  p_record_origin text,
  p_effective_date date,
  p_evidence_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_runtime public.financial_ledger_runtime%rowtype;
begin
  select * into v_runtime
  from public.financial_ledger_runtime
  where singleton = true;
  if v_runtime.environment_kind <> 'TEST' or v_runtime.bound_project_ref is null then
    raise exception using errcode = '55000', message =
      'Ledger writes require an explicit verified TEST project-ref binding.';
  end if;
  if v_runtime.mode = 'DISABLED' then
    raise exception using errcode = '55000', message =
      'DISABLED mode blocks every monetary Ledger materialization.';
  end if;
  if p_record_origin = 'SYSTEM_NATIVE' then
    if v_runtime.mode <> 'TEST' or p_evidence_id is not null
       or p_effective_date < v_runtime.native_start_date then
      raise exception using errcode = '23514', message =
        'SYSTEM_NATIVE writes require TEST mode, no Legacy evidence, and an effective date on/after 2026-09-01.';
    end if;
  elsif p_record_origin = 'LEGACY_EXCEL' then
    if v_runtime.mode not in ('RECONCILIATION', 'TEST')
       or p_effective_date not between date '2022-01-01' and v_runtime.baseline_as_of
       or p_evidence_id is null
       or not exists (
         select 1 from public.ledger_evidence
         where id = p_evidence_id
           and evidence_scope = 'LEGACY_RECONSTRUCTION'
           and verification_status = 'VERIFIED'
       ) then
      raise exception using errcode = '23514', message =
        'LEGACY_EXCEL writes require RECONCILIATION or TEST mode, a 2022-01-01..2026-08-31 date, and VERIFIED LEGACY_RECONSTRUCTION evidence.';
    end if;
  else
    raise exception using errcode = '23514', message =
      'Ledger record_origin must be SYSTEM_NATIVE or LEGACY_EXCEL.';
  end if;
end;
$$;

create or replace function public.financial_enforce_ledger_origin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_effective_date date;
begin
  if tg_table_name = 'project_budget_cohorts' then
    v_effective_date := new.effective_date;
  elsif tg_table_name = 'project_execution_records' then
    v_effective_date := new.execution_date;
  else
    v_effective_date := new.effective_date;
  end if;
  perform public.financial_require_ledger_write(new.record_origin, v_effective_date, new.evidence_id);
  return new;
end;
$$;

drop trigger if exists project_fund_transfers_effective_date_guard on public.project_fund_transfers;
drop trigger if exists project_execution_records_effective_date_guard on public.project_execution_records;
drop trigger if exists project_carryovers_effective_date_guard on public.project_carryovers;
drop trigger if exists project_budget_adjustments_effective_date_guard on public.project_budget_adjustments;

create trigger project_budget_cohorts_origin_guard
  before insert or update on public.project_budget_cohorts
  for each row execute function public.financial_enforce_ledger_origin();
create trigger project_fund_transfers_origin_guard
  before insert or update on public.project_fund_transfers
  for each row execute function public.financial_enforce_ledger_origin();
create trigger project_execution_records_origin_guard
  before insert or update on public.project_execution_records
  for each row execute function public.financial_enforce_ledger_origin();
create trigger project_carryovers_origin_guard
  before insert or update on public.project_carryovers
  for each row execute function public.financial_enforce_ledger_origin();
create trigger project_budget_adjustments_origin_guard
  before insert or update on public.project_budget_adjustments
  for each row execute function public.financial_enforce_ledger_origin();

-- ---------------------------------------------------------------------------
-- 5. Maker-checker request envelope for native non-execution changes
-- ---------------------------------------------------------------------------

create table public.financial_ledger_change_requests (
  id uuid primary key default gen_random_uuid(),
  request_type text not null check (request_type in (
    'CARRYOVER', 'BUDGET_ADJUSTMENT', 'EXECUTION_REVERSAL',
    'CARRYOVER_REVERSAL', 'TRANSFER_REVERSAL', 'ADJUSTMENT_REVERSAL'
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
  constraint financial_ledger_change_requests_state_shape check (
    (status = 'DRAFT' and submitted_by is null and approved_by is null and rejected_by is null and applied_by is null)
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

create index financial_ledger_change_requests_region_status_idx
  on public.financial_ledger_change_requests(region_id, status, request_type);

-- ---------------------------------------------------------------------------
-- 6. Manual Legacy history reconstruction staging
-- ---------------------------------------------------------------------------

create table public.legacy_ledger_reconstruction_entries (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  event_type text not null check (event_type in (
    'ALLOCATION', 'EXECUTION', 'CARRYOVER', 'TRANSFER', 'ADJUSTMENT'
  )),
  project_id uuid not null references public.projects(id) on delete restrict,
  destination_project_id uuid references public.projects(id) on delete restrict,
  funding_entry_id uuid references public.legacy_ledger_reconstruction_entries(id) on delete restrict,
  lineage_id uuid references public.financial_project_lineages(id) on delete restrict,
  evidence_id uuid not null references public.ledger_evidence(id) on delete restrict,
  origin_fiscal_year integer check (origin_fiscal_year between 2000 and 2200),
  fiscal_year integer not null check (fiscal_year between 2000 and 2200),
  destination_fiscal_year integer check (destination_fiscal_year between 2000 and 2200),
  legacy_prior_carryover_count smallint check (legacy_prior_carryover_count between 0 and 2),
  amount bigint not null check (amount > 0),
  effective_date date not null check (effective_date between date '2022-01-01' and date '2026-08-31'),
  carryover_sequence smallint check (carryover_sequence between 1 and 2),
  carryover_type text check (carryover_type in ('MYEONGSI', 'SAGO')),
  adjustment_type text check (adjustment_type in (
    'RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_INCREASE', 'CORRECTION_DECREASE'
  )),
  reason_code text check (reason_code is null or char_length(reason_code) <= 100),
  memo text check (memo is null or char_length(memo) <= 1000),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'APPLIED')),
  idempotency_key uuid not null unique,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  submitted_by uuid references public.profiles(id) on delete restrict,
  submitted_at timestamptz,
  verified_by uuid references public.profiles(id) on delete restrict,
  verified_at timestamptz,
  rejected_by uuid references public.profiles(id) on delete restrict,
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  applied_by uuid references public.profiles(id) on delete restrict,
  applied_at timestamptz,
  applied_cohort_id uuid references public.project_budget_cohorts(id) on delete restrict,
  materialized_table text,
  materialized_record_id uuid,
  constraint legacy_ledger_reconstruction_event_shape check (
    (event_type = 'ALLOCATION'
      and funding_entry_id is null and destination_project_id is null
      and origin_fiscal_year = fiscal_year and legacy_prior_carryover_count = 0
      and lineage_id is null and carryover_sequence is null and carryover_type is null
      and adjustment_type is null)
    or
    (event_type = 'EXECUTION'
      and funding_entry_id is not null and destination_project_id is null
      and origin_fiscal_year is null and legacy_prior_carryover_count is null
      and carryover_sequence is null and carryover_type is null and adjustment_type is null)
    or
    (event_type = 'CARRYOVER'
      and funding_entry_id is not null and destination_project_id is not null
      and origin_fiscal_year is null and legacy_prior_carryover_count is null
      and destination_fiscal_year = fiscal_year + 1 and lineage_id is not null
      and carryover_sequence is not null and carryover_type is not null
      and adjustment_type is null)
    or
    (event_type = 'TRANSFER'
      and funding_entry_id is not null and destination_project_id is not null
      and origin_fiscal_year is null and legacy_prior_carryover_count is null
      and destination_fiscal_year = fiscal_year and carryover_sequence is null
      and carryover_type is null and adjustment_type is null)
    or
    (event_type = 'ADJUSTMENT'
      and funding_entry_id is not null and destination_project_id is null
      and origin_fiscal_year is null and legacy_prior_carryover_count is null
      and adjustment_type is not null and carryover_sequence is null and carryover_type is null)
  ),
  constraint legacy_ledger_reconstruction_state_shape check (
    (status = 'DRAFT' and submitted_by is null and verified_by is null and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and verified_by is null and rejected_by is null and applied_by is null)
    or (status = 'VERIFIED' and verified_by is not null and verified_at is not null
      and verified_by <> created_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> created_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and verified_by is not null and verified_by <> created_by
      and applied_by is not null and applied_by <> created_by and applied_at is not null
      and materialized_table is not null and materialized_record_id is not null)
  )
);

create index legacy_ledger_reconstruction_region_status_idx
  on public.legacy_ledger_reconstruction_entries(region_id, status, event_type);
create index legacy_ledger_reconstruction_funding_idx
  on public.legacy_ledger_reconstruction_entries(funding_entry_id, fiscal_year);

-- DRAFT facts may only be edited through the owner-region RPC. Once submitted,
-- core facts are immutable; only the state-machine actor/timestamp fields move.
create or replace function public.financial_validate_legacy_reconstruction_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Legacy reconstruction entries cannot be deleted.';
  end if;
  if old.status in ('REJECTED', 'APPLIED') then
    raise exception using errcode = '55000', message = 'Terminal Legacy reconstruction entries are immutable.';
  end if;
  if old.status = 'DRAFT' and new.status = 'DRAFT' then
    return new;
  end if;
  if row(new.region_id, new.event_type, new.project_id, new.destination_project_id,
         new.funding_entry_id, new.lineage_id, new.evidence_id, new.origin_fiscal_year,
         new.fiscal_year, new.destination_fiscal_year, new.legacy_prior_carryover_count,
         new.amount, new.effective_date, new.carryover_sequence, new.carryover_type,
         new.adjustment_type, new.reason_code, new.memo, new.idempotency_key,
         new.request_fingerprint, new.created_by, new.created_at)
     is distinct from
     row(old.region_id, old.event_type, old.project_id, old.destination_project_id,
         old.funding_entry_id, old.lineage_id, old.evidence_id, old.origin_fiscal_year,
         old.fiscal_year, old.destination_fiscal_year, old.legacy_prior_carryover_count,
         old.amount, old.effective_date, old.carryover_sequence, old.carryover_type,
         old.adjustment_type, old.reason_code, old.memo, old.idempotency_key,
         old.request_fingerprint, old.created_by, old.created_at) then
    raise exception using errcode = '55000', message = 'Submitted Legacy reconstruction facts are immutable.';
  end if;
  if not (
    (old.status = 'DRAFT' and new.status = 'SUBMITTED')
    or (old.status = 'SUBMITTED' and new.status in ('VERIFIED', 'REJECTED'))
    or (old.status = 'VERIFIED' and new.status = 'APPLIED')
  ) then
    raise exception using errcode = '23514', message = 'Invalid Legacy reconstruction state transition.';
  end if;
  return new;
end;
$$;

create trigger legacy_ledger_reconstruction_state_guard
  before update or delete on public.legacy_ledger_reconstruction_entries
  for each row execute function public.financial_validate_legacy_reconstruction_mutation();

-- ---------------------------------------------------------------------------
-- 7. Baseline classification and correction workflow columns
-- ---------------------------------------------------------------------------

alter table public.project_financial_baselines
  add column evidence_id uuid references public.ledger_evidence(id) on delete restrict,
  add column legacy_funding_entry_id uuid
    references public.legacy_ledger_reconstruction_entries(id) on delete restrict,
  add column origin_fiscal_year integer,
  add column legacy_prior_carryover_count smallint;

alter table public.project_financial_baselines
  drop constraint if exists project_financial_baselines_verification_status_check,
  drop constraint if exists project_financial_baselines_amounts_required_when_verified,
  drop constraint if exists project_financial_baselines_verification_check;

alter table public.project_financial_baselines
  add constraint project_financial_baselines_classification_check check (
    verification_status in (
      'NEEDS_REVIEW', 'RECONCILED', 'HISTORICAL', 'EXCLUDED', 'ACTIVE_AT_CUTOVER'
    )
  ),
  add constraint project_financial_baselines_amount_policy_check check (
    verification_status not in ('RECONCILED', 'ACTIVE_AT_CUTOVER')
    or (adjusted_allocation is not null and cumulative_execution is not null
      and adjusted_allocation >= 0 and cumulative_execution >= 0
      and cumulative_execution <= adjusted_allocation)
  ),
  add constraint project_financial_baselines_evidence_policy_check check (
    (verification_status = 'NEEDS_REVIEW' and verified_by is null and verified_at is null
      and legacy_funding_entry_id is null and origin_fiscal_year is null
      and legacy_prior_carryover_count is null and ledger_budget_year_id is null)
    or
    (verification_status = 'RECONCILED'
      and evidence_id is not null and verified_by is not null and verified_at is not null
      and legacy_funding_entry_id is null and origin_fiscal_year is null
      and legacy_prior_carryover_count is null and ledger_budget_year_id is null)
    or
    (verification_status = 'HISTORICAL'
      and evidence_id is not null and verified_by is not null and verified_at is not null
      and legacy_funding_entry_id is not null and origin_fiscal_year between 2000 and 2200
      and legacy_prior_carryover_count between 0 and 2 and ledger_budget_year_id is null)
    or
    (verification_status = 'EXCLUDED'
      and verified_by is not null and verified_at is not null
      and char_length(btrim(coalesce(verification_note, ''))) between 1 and 1000
      and legacy_funding_entry_id is null and origin_fiscal_year is null
      and legacy_prior_carryover_count is null and ledger_budget_year_id is null)
    or
    (verification_status = 'ACTIVE_AT_CUTOVER'
      and evidence_id is not null and verified_by is not null and verified_at is not null
      and legacy_funding_entry_id is not null
      and origin_fiscal_year between 2000 and 2200
      and legacy_prior_carryover_count between 0 and 2
      and extract(year from baseline_as_of)::integer - origin_fiscal_year
        = legacy_prior_carryover_count)
  );

alter table public.project_baseline_corrections
  add column idempotency_key uuid not null unique,
  add column request_fingerprint text not null,
  add column submitted_by uuid references public.profiles(id) on delete restrict,
  add column submitted_at timestamptz,
  add column rejected_by uuid references public.profiles(id) on delete restrict,
  add column rejected_at timestamptz,
  add column rejection_reason text;

alter table public.project_baseline_corrections
  drop constraint if exists project_baseline_corrections_approval_check,
  add constraint project_baseline_corrections_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint project_baseline_corrections_state_policy_check check (
    (status = 'DRAFT' and submitted_by is null and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'SUBMITTED' and submitted_by is not null and submitted_at is not null
      and approved_by is null and rejected_by is null and applied_by is null)
    or (status = 'APPROVED' and approved_by is not null and approved_at is not null
      and approved_by <> requested_by and rejected_by is null and applied_by is null)
    or (status = 'REJECTED' and rejected_by is not null and rejected_at is not null
      and rejected_by <> requested_by and rejection_reason is not null and applied_by is null)
    or (status = 'APPLIED' and approved_by is not null and approved_by <> requested_by
      and applied_by is not null and applied_by <> requested_by and applied_at is not null)
  );

-- ---------------------------------------------------------------------------
-- 8. Evidence and lineage RPCs
-- ---------------------------------------------------------------------------

create or replace function public.financial_register_ledger_evidence(
  p_region_id uuid,
  p_evidence_scope text,
  p_source_type text,
  p_source_system text,
  p_source_file_name text,
  p_source_file_sha256 text,
  p_source_sheet_name text,
  p_source_row_reference text,
  p_external_reference text,
  p_evidence_note text,
  p_source_as_of_date date,
  p_import_batch_id uuid,
  p_idempotency_key uuid,
  p_submit boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_payload jsonb;
  v_fingerprint text;
  v_evidence public.ledger_evidence%rowtype;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Evidence may only be registered for the actor region.';
  end if;
  if p_idempotency_key is null or p_import_batch_id is null
     or p_evidence_scope not in (
       'LEGACY_RECONSTRUCTION', 'BASELINE', 'PROJECT_LINEAGE', 'NATIVE_TRANSACTION'
     )
     or p_source_type not in ('LEGACY_EXCEL', 'LEGACY_EXPORT', 'SIGNED_DOCUMENT')
     or p_source_file_sha256 !~ '^[0-9a-f]{64}$'
     or not (
       (p_evidence_scope in ('LEGACY_RECONSTRUCTION', 'BASELINE')
         and p_source_as_of_date between date '2022-01-01' and date '2026-08-31')
       or (p_evidence_scope = 'PROJECT_LINEAGE' and p_source_as_of_date >= date '2022-01-01')
       or (p_evidence_scope = 'NATIVE_TRANSACTION' and p_source_as_of_date >= date '2026-09-01')
     ) then
    raise exception using errcode = '22023', message = 'Invalid immutable Ledger evidence input.';
  end if;
  v_payload := jsonb_build_object(
    'region_id', p_region_id, 'evidence_scope', p_evidence_scope, 'source_type', p_source_type,
    'source_system', btrim(p_source_system), 'source_file_name', btrim(p_source_file_name),
    'source_file_sha256', lower(p_source_file_sha256),
    'source_sheet_name', nullif(btrim(p_source_sheet_name), ''),
    'source_row_reference', nullif(btrim(p_source_row_reference), ''),
    'external_reference', nullif(btrim(p_external_reference), ''),
    'evidence_note', nullif(btrim(p_evidence_note), ''),
    'source_as_of_date', p_source_as_of_date, 'import_batch_id', p_import_batch_id
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_evidence
  from public.ledger_evidence
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_evidence.request_fingerprint, v_fingerprint, 'ledger_evidence'
    );
    return v_evidence.id;
  end if;

  insert into public.ledger_evidence (
    region_id, evidence_scope, source_type, source_system, source_file_name, source_file_sha256,
    source_sheet_name, source_row_reference, external_reference, evidence_note,
    source_as_of_date, import_batch_id, verification_status, idempotency_key,
    request_fingerprint, created_by, submitted_by, submitted_at
  ) values (
    p_region_id, p_evidence_scope, p_source_type, btrim(p_source_system), btrim(p_source_file_name),
    lower(p_source_file_sha256), nullif(btrim(p_source_sheet_name), ''),
    nullif(btrim(p_source_row_reference), ''), nullif(btrim(p_external_reference), ''),
    nullif(btrim(p_evidence_note), ''), p_source_as_of_date, p_import_batch_id,
    case when coalesce(p_submit, false) then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when coalesce(p_submit, false) then v_actor_id else null end,
    case when coalesce(p_submit, false) then clock_timestamp() else null end
  ) returning * into v_evidence;
  return v_evidence.id;
end;
$$;

create or replace function public.financial_update_ledger_evidence_draft(
  p_evidence_id uuid,
  p_evidence_scope text,
  p_source_type text,
  p_source_system text,
  p_source_file_name text,
  p_source_file_sha256 text,
  p_source_sheet_name text,
  p_source_row_reference text,
  p_external_reference text,
  p_evidence_note text,
  p_source_as_of_date date,
  p_import_batch_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_evidence public.ledger_evidence%rowtype;
  v_payload jsonb;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_evidence from public.ledger_evidence where id = p_evidence_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger evidence was not found.'; end if;
  if v_evidence.verification_status <> 'DRAFT'
     or (v_role = 'local_user' and (v_evidence.created_by <> v_actor_id or v_evidence.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT evidence may be edited.';
  end if;
  if p_import_batch_id is null
     or p_evidence_scope not in (
       'LEGACY_RECONSTRUCTION', 'BASELINE', 'PROJECT_LINEAGE', 'NATIVE_TRANSACTION'
     )
     or p_source_type not in ('LEGACY_EXCEL', 'LEGACY_EXPORT', 'SIGNED_DOCUMENT')
     or p_source_file_sha256 !~ '^[0-9a-f]{64}$'
     or not (
       (p_evidence_scope in ('LEGACY_RECONSTRUCTION', 'BASELINE')
         and p_source_as_of_date between date '2022-01-01' and date '2026-08-31')
       or (p_evidence_scope = 'PROJECT_LINEAGE' and p_source_as_of_date >= date '2022-01-01')
       or (p_evidence_scope = 'NATIVE_TRANSACTION' and p_source_as_of_date >= date '2026-09-01')
     ) then
    raise exception using errcode = '22023', message = 'Invalid DRAFT Ledger evidence input.';
  end if;
  v_payload := jsonb_build_object(
    'region_id', v_evidence.region_id, 'evidence_scope', p_evidence_scope,
    'source_type', p_source_type, 'source_system', btrim(p_source_system),
    'source_file_name', btrim(p_source_file_name),
    'source_file_sha256', lower(p_source_file_sha256),
    'source_sheet_name', nullif(btrim(p_source_sheet_name), ''),
    'source_row_reference', nullif(btrim(p_source_row_reference), ''),
    'external_reference', nullif(btrim(p_external_reference), ''),
    'evidence_note', nullif(btrim(p_evidence_note), ''),
    'source_as_of_date', p_source_as_of_date, 'import_batch_id', p_import_batch_id
  );
  update public.ledger_evidence
  set evidence_scope = p_evidence_scope,
      source_type = p_source_type,
      source_system = btrim(p_source_system),
      source_file_name = btrim(p_source_file_name),
      source_file_sha256 = lower(p_source_file_sha256),
      source_sheet_name = nullif(btrim(p_source_sheet_name), ''),
      source_row_reference = nullif(btrim(p_source_row_reference), ''),
      external_reference = nullif(btrim(p_external_reference), ''),
      evidence_note = nullif(btrim(p_evidence_note), ''),
      source_as_of_date = p_source_as_of_date,
      import_batch_id = p_import_batch_id,
      request_fingerprint = public.financial_request_fingerprint(v_payload)
  where id = v_evidence.id;
end;
$$;

create or replace function public.financial_submit_ledger_evidence(p_evidence_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_evidence public.ledger_evidence%rowtype;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_evidence from public.ledger_evidence where id = p_evidence_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger evidence was not found.'; end if;
  if v_evidence.verification_status = 'SUBMITTED' then return; end if;
  if v_evidence.verification_status <> 'DRAFT'
     or (v_role = 'local_user' and (v_evidence.created_by <> v_actor_id or v_evidence.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT evidence may be submitted.';
  end if;
  update public.ledger_evidence
  set verification_status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_evidence.id;
end;
$$;

create or replace function public.financial_verify_ledger_evidence(p_evidence_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_evidence public.ledger_evidence%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_evidence from public.ledger_evidence where id = p_evidence_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger evidence was not found.'; end if;
  if v_evidence.verification_status = 'VERIFIED' then return; end if;
  if v_evidence.verification_status <> 'SUBMITTED' or v_evidence.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Evidence verification requires a different admin from the maker.';
  end if;
  update public.ledger_evidence
  set verification_status = 'VERIFIED', verified_by = v_actor_id, verified_at = clock_timestamp()
  where id = v_evidence.id;
  perform public.financial_write_audit(
    null, v_evidence.region_id, 'LEDGER_EVIDENCE_VERIFIED', 'ledger_evidence',
    v_evidence.id, v_actor_id,
    jsonb_build_object('evidence_scope', v_evidence.evidence_scope,
      'source_as_of_date', v_evidence.source_as_of_date,
      'import_batch_id', v_evidence.import_batch_id)
  );
end;
$$;

create or replace function public.financial_reject_ledger_evidence(
  p_evidence_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_evidence public.ledger_evidence%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Evidence rejection reason is required.';
  end if;
  select * into v_evidence from public.ledger_evidence where id = p_evidence_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger evidence was not found.'; end if;
  if v_evidence.verification_status = 'REJECTED' then return; end if;
  if v_evidence.verification_status <> 'SUBMITTED' or v_evidence.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Evidence rejection requires a different admin from the maker.';
  end if;
  update public.ledger_evidence
  set verification_status = 'REJECTED', rejected_by = v_actor_id,
      rejected_at = clock_timestamp(), rejection_reason = btrim(p_reason)
  where id = v_evidence.id;
end;
$$;

create or replace function public.financial_create_project_lineage(
  p_region_id uuid,
  p_reason text,
  p_project_ids uuid[],
  p_member_evidence_ids uuid[],
  p_idempotency_key uuid,
  p_submit boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_members jsonb;
  v_payload jsonb;
  v_fingerprint text;
  v_lineage public.financial_project_lineages%rowtype;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if v_role = 'local_user' and p_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Lineage may only be proposed for the actor region.';
  end if;
  if p_idempotency_key is null or coalesce(cardinality(p_project_ids), 0) < 2
     or coalesce(cardinality(p_member_evidence_ids), -1) <> cardinality(p_project_ids)
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message =
      'Lineage requires reason, idempotency key, at least two projects, and one evidence id per member.';
  end if;
  if (select count(distinct item) from unnest(p_project_ids) as item) <> cardinality(p_project_ids) then
    raise exception using errcode = '23514', message = 'A project may appear only once in a lineage proposal.';
  end if;
  if exists (
    select 1 from unnest(p_project_ids) as requested(project_id)
    left join public.projects on projects.id = requested.project_id
    where projects.id is null or projects.region_id <> p_region_id or projects.year is null
  ) then
    raise exception using errcode = '23514', message = 'All lineage projects must exist in the same region with a fiscal year.';
  end if;
  if exists (
    select 1
    from unnest(p_member_evidence_ids) as requested(evidence_id)
    left join public.ledger_evidence as evidence on evidence.id = requested.evidence_id
    where evidence.id is null or evidence.region_id <> p_region_id
      or evidence.evidence_scope <> 'PROJECT_LINEAGE'
      or evidence.verification_status = 'REJECTED'
  ) then
    raise exception using errcode = '23514', message =
      'Each lineage member requires its own non-rejected, same-region PROJECT_LINEAGE evidence.';
  end if;
  select jsonb_agg(
    jsonb_build_object('project_id', requested.project_id, 'evidence_id', requested.evidence_id)
    order by requested.project_id, requested.evidence_id
  ) into v_members
  from unnest(p_project_ids, p_member_evidence_ids) as requested(project_id, evidence_id);
  v_payload := jsonb_build_object(
    'region_id', p_region_id, 'reason', btrim(p_reason), 'members', v_members
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_lineage from public.financial_project_lineages
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_lineage.request_fingerprint, v_fingerprint, 'financial_project_lineages'
    );
    return v_lineage.id;
  end if;

  insert into public.financial_project_lineages (
    region_id, status, reason, idempotency_key, request_fingerprint, created_by
  ) values (
    p_region_id, 'DRAFT', btrim(p_reason), p_idempotency_key, v_fingerprint, v_actor_id
  ) returning * into v_lineage;

  insert into public.financial_project_lineage_members (
    project_id, lineage_id, region_id, fiscal_year, evidence_id, assigned_by
  )
  select projects.id, v_lineage.id, projects.region_id, projects.year,
    requested.evidence_id, v_actor_id
  from unnest(p_project_ids, p_member_evidence_ids) as requested(project_id, evidence_id)
  join public.projects on projects.id = requested.project_id;
  if coalesce(p_submit, false) then
    if exists (
      select 1 from unnest(p_member_evidence_ids) as requested(evidence_id)
      join public.ledger_evidence as evidence on evidence.id = requested.evidence_id
      where evidence.verification_status not in ('SUBMITTED', 'VERIFIED')
    ) then
      raise exception using errcode = '23514', message =
        'A submitted lineage requires submitted or VERIFIED evidence for every member.';
    end if;
    update public.financial_project_lineages
    set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
    where id = v_lineage.id;
    v_lineage.status := 'SUBMITTED';
  end if;
  perform public.financial_write_audit(
    p_project_ids[1], p_region_id, 'LEDGER_LINEAGE_CREATED', 'financial_project_lineages',
    v_lineage.id, v_actor_id, jsonb_build_object('member_project_ids', v_members, 'status', v_lineage.status)
  );
  return v_lineage.id;
end;
$$;

create or replace function public.financial_update_project_lineage_draft(
  p_lineage_id uuid,
  p_reason text,
  p_project_ids uuid[],
  p_member_evidence_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_lineage public.financial_project_lineages%rowtype;
  v_members jsonb;
  v_payload jsonb;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_lineage from public.financial_project_lineages where id = p_lineage_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Funding lineage was not found.'; end if;
  if v_lineage.status <> 'DRAFT'
     or (v_role = 'local_user' and (v_lineage.created_by <> v_actor_id or v_lineage.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT lineage may be edited.';
  end if;
  if coalesce(cardinality(p_project_ids), 0) < 2
     or coalesce(cardinality(p_member_evidence_ids), -1) <> cardinality(p_project_ids)
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000
     or (select count(distinct item) from unnest(p_project_ids) as item) <> cardinality(p_project_ids) then
    raise exception using errcode = '22023', message = 'A DRAFT lineage requires unique projects and one evidence id per member.';
  end if;
  if exists (
    select 1 from unnest(p_project_ids, p_member_evidence_ids) as requested(project_id, evidence_id)
    left join public.projects on projects.id = requested.project_id
    left join public.ledger_evidence as evidence on evidence.id = requested.evidence_id
    where projects.id is null or projects.region_id <> v_lineage.region_id or projects.year is null
      or evidence.id is null or evidence.region_id <> v_lineage.region_id
      or evidence.evidence_scope <> 'PROJECT_LINEAGE'
      or evidence.verification_status = 'REJECTED'
  ) then
    raise exception using errcode = '23514', message =
      'Every DRAFT lineage member must match the lineage region/year and have PROJECT_LINEAGE evidence.';
  end if;
  select jsonb_agg(
    jsonb_build_object('project_id', requested.project_id, 'evidence_id', requested.evidence_id)
    order by requested.project_id, requested.evidence_id
  ) into v_members
  from unnest(p_project_ids, p_member_evidence_ids) as requested(project_id, evidence_id);
  v_payload := jsonb_build_object(
    'region_id', v_lineage.region_id, 'reason', btrim(p_reason), 'members', v_members
  );
  delete from public.financial_project_lineage_members where lineage_id = v_lineage.id;
  update public.financial_project_lineages
  set reason = btrim(p_reason), request_fingerprint = public.financial_request_fingerprint(v_payload)
  where id = v_lineage.id;
  insert into public.financial_project_lineage_members (
    project_id, lineage_id, region_id, fiscal_year, evidence_id, assigned_by
  )
  select projects.id, v_lineage.id, projects.region_id, projects.year,
    requested.evidence_id, v_actor_id
  from unnest(p_project_ids, p_member_evidence_ids) as requested(project_id, evidence_id)
  join public.projects on projects.id = requested.project_id;
end;
$$;

create or replace function public.financial_submit_project_lineage(p_lineage_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_lineage public.financial_project_lineages%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_lineage from public.financial_project_lineages where id = p_lineage_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Funding lineage was not found.'; end if;
  if v_lineage.status = 'SUBMITTED' then return; end if;
  if v_lineage.status <> 'DRAFT'
     or (v_role = 'local_user' and (v_lineage.created_by <> v_actor_id or v_lineage.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT lineage may be submitted.';
  end if;
  if (select count(*) from public.financial_project_lineage_members
      where lineage_id = v_lineage.id) < 2
     or exists (
       select 1
       from public.financial_project_lineage_members as members
       join public.ledger_evidence as evidence on evidence.id = members.evidence_id
       where members.lineage_id = v_lineage.id
         and (evidence.region_id <> v_lineage.region_id
           or evidence.evidence_scope <> 'PROJECT_LINEAGE'
           or evidence.verification_status not in ('SUBMITTED', 'VERIFIED'))
     ) then
    raise exception using errcode = '23514', message =
      'Lineage submission requires at least two members with submitted PROJECT_LINEAGE evidence.';
  end if;
  update public.financial_project_lineages
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_lineage.id;
end;
$$;

create or replace function public.financial_verify_project_lineage(p_lineage_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_lineage public.financial_project_lineages%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_lineage from public.financial_project_lineages where id = p_lineage_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Funding lineage was not found.'; end if;
  if v_lineage.status = 'VERIFIED' then return; end if;
  if v_lineage.status <> 'SUBMITTED' or v_lineage.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Lineage VERIFY requires a different admin from the maker.';
  end if;
  if (select count(*) from public.financial_project_lineage_members
      where lineage_id = v_lineage.id) < 2
     or exists (
       select 1
       from public.financial_project_lineage_members as members
       left join public.ledger_evidence as evidence on evidence.id = members.evidence_id
       where members.lineage_id = v_lineage.id
         and (evidence.id is null or evidence.region_id <> v_lineage.region_id
           or evidence.evidence_scope <> 'PROJECT_LINEAGE'
           or evidence.verification_status <> 'VERIFIED')
     ) then
    raise exception using errcode = '23514', message =
      'Lineage VERIFY requires VERIFIED same-region PROJECT_LINEAGE evidence for every member.';
  end if;
  -- Lock member projects in deterministic order so two concurrent proposals
  -- cannot both become VERIFIED for the same project.
  perform 1
  from public.projects
  where id in (
    select project_id from public.financial_project_lineage_members
    where lineage_id = v_lineage.id
  )
  order by id
  for update;
  if exists (
    select 1
    from public.financial_project_lineage_members as proposed
    join public.financial_project_lineage_members as existing
      on existing.project_id = proposed.project_id
      and existing.lineage_id <> proposed.lineage_id
    join public.financial_project_lineages as existing_lineage
      on existing_lineage.id = existing.lineage_id
      and existing_lineage.status = 'VERIFIED'
    where proposed.lineage_id = v_lineage.id
  ) then
    raise exception using errcode = '23505', message =
      'A project already belongs to another VERIFIED funding lineage.';
  end if;
  update public.financial_project_lineages
  set status = 'VERIFIED', verified_by = v_actor_id, verified_at = clock_timestamp()
  where id = v_lineage.id;
  perform public.financial_write_audit(
    null, v_lineage.region_id, 'LEDGER_LINEAGE_VERIFIED', 'financial_project_lineages',
    v_lineage.id, v_actor_id, jsonb_build_object(
      'member_evidence_count', (select count(*) from public.financial_project_lineage_members
        where lineage_id = v_lineage.id)
    )
  );
end;
$$;

create or replace function public.financial_reject_project_lineage(
  p_lineage_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_lineage public.financial_project_lineages%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Lineage rejection reason is required.';
  end if;
  select * into v_lineage from public.financial_project_lineages where id = p_lineage_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Funding lineage was not found.'; end if;
  if v_lineage.status = 'REJECTED' then return; end if;
  if v_lineage.status <> 'SUBMITTED' or v_lineage.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Lineage rejection requires a different admin from the maker.';
  end if;
  update public.financial_project_lineages
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_lineage.id;
end;
$$;

-- This guard deliberately never uses project_code, project names, or fuzzy
-- similarity. Same region alone is insufficient: both wallets need members in
-- the same final-person VERIFIED lineage and adjacent fiscal years.
create or replace function public.financial_assert_carryover_same_verified_lineage(
  p_source_project_id uuid,
  p_destination_project_id uuid,
  p_source_fiscal_year integer,
  p_destination_fiscal_year integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_lineage_id uuid;
  v_destination_lineage_id uuid;
  v_source_region_id uuid;
  v_destination_region_id uuid;
begin
  select members.lineage_id, members.region_id
    into v_source_lineage_id, v_source_region_id
  from public.financial_project_lineage_members as members
  join public.financial_project_lineages as lineages
    on lineages.id = members.lineage_id and lineages.status = 'VERIFIED'
  where members.project_id = p_source_project_id
    and members.fiscal_year = p_source_fiscal_year;
  select members.lineage_id, members.region_id
    into v_destination_lineage_id, v_destination_region_id
  from public.financial_project_lineage_members as members
  join public.financial_project_lineages as lineages
    on lineages.id = members.lineage_id and lineages.status = 'VERIFIED'
  where members.project_id = p_destination_project_id
    and members.fiscal_year = p_destination_fiscal_year;
  if v_source_lineage_id is null or v_destination_lineage_id is null then
    raise exception using errcode = '55000', message =
      'Carryover is blocked until both projects belong to a VERIFIED funding lineage.';
  end if;
  if v_source_lineage_id <> v_destination_lineage_id
     or v_source_region_id <> v_destination_region_id
     or p_destination_fiscal_year <> p_source_fiscal_year + 1 then
    raise exception using errcode = '23514', message =
      'Carryover requires the same VERIFIED lineage, region, and immediately following fiscal year.';
  end if;
  return v_source_lineage_id;
end;
$$;

create or replace function public.financial_expected_carryover_sequence(
  p_budget_cohort_id uuid,
  p_source_fiscal_year integer,
  p_destination_fiscal_year integer
)
returns smallint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_type text;
  v_origin_fiscal_year integer;
  v_prior_count smallint;
  v_sequence integer;
begin
  select source_type, origin_fiscal_year, legacy_prior_carryover_count
    into v_source_type, v_origin_fiscal_year, v_prior_count
  from public.project_budget_cohorts
  where id = p_budget_cohort_id;
  if not found or p_destination_fiscal_year <> p_source_fiscal_year + 1 then
    raise exception using errcode = '23514', message = 'Carryover requires an existing cohort and adjacent fiscal years.';
  end if;
  if v_source_type <> 'STANDARD' and (v_origin_fiscal_year is null or v_prior_count <> 0) then
    raise exception using errcode = '23514', message =
      'Legacy cohorts must start at the verified first allocation year with prior carryover count 0.';
  end if;
  v_sequence := p_destination_fiscal_year - v_origin_fiscal_year;
  if v_sequence not in (1, 2) then
    raise exception using errcode = '23514', message = 'Carryover is limited to two occurrences.';
  end if;
  return v_sequence::smallint;
end;
$$;

-- Migration 19 already validates same-cohort direction, reversal shape, and
-- MYEONGSI/SAGO rules. Replace only its Legacy sequence branch so known origin
-- and explicit prior-count can coexist without treating origin as UNKNOWN.
create or replace function public.financial_validate_wallet_relationship()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source public.project_budget_years%rowtype;
  v_destination public.project_budget_years%rowtype;
  v_original public.project_carryovers%rowtype;
  v_expected_sequence smallint;
  v_expected_type text;
begin
  if tg_table_name = 'project_fund_transfers' then
    select * into v_source from public.project_budget_years where id = new.source_budget_year_id;
    select * into v_destination from public.project_budget_years where id = new.destination_budget_year_id;
    if v_source.id is null or v_destination.id is null then
      raise exception using errcode = '23503', message = 'Transfer wallet was not found.';
    end if;
    if v_source.budget_cohort_id <> v_destination.budget_cohort_id
       or v_source.fiscal_year <> v_destination.fiscal_year then
      raise exception using errcode = '23514', message = 'Transfer requires the same cohort and fiscal year.';
    end if;
    return new;
  end if;

  if tg_table_name = 'project_carryovers' then
    select * into v_source from public.project_budget_years where id = new.source_budget_year_id;
    select * into v_destination from public.project_budget_years where id = new.destination_budget_year_id;
    if v_source.id is null or v_destination.id is null then
      raise exception using errcode = '23503', message = 'Carryover wallet was not found.';
    end if;
    if v_source.budget_cohort_id <> v_destination.budget_cohort_id then
      raise exception using errcode = '23514', message = 'Carryover must preserve its funding cohort.';
    end if;
    if new.transaction_kind = 'NORMAL' then
      v_expected_sequence := public.financial_expected_carryover_sequence(
        v_source.budget_cohort_id, v_source.fiscal_year, v_destination.fiscal_year
      );
      v_expected_type := case when v_expected_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
      if new.carryover_sequence <> v_expected_sequence or new.carryover_type <> v_expected_type then
        raise exception using errcode = '23514', message =
          'Carryover occurrence/type must match the verified cohort history.';
      end if;
    else
      select * into v_original from public.project_carryovers where id = new.reversal_of;
      if v_original.id is null or v_original.status <> 'CONFIRMED'
         or v_original.transaction_kind <> 'NORMAL'
         or new.source_budget_year_id <> v_original.destination_budget_year_id
         or new.destination_budget_year_id <> v_original.source_budget_year_id
         or new.carryover_sequence <> v_original.carryover_sequence
         or new.carryover_type <> v_original.carryover_type
         or v_destination.fiscal_year <> v_source.fiscal_year - 1 then
        raise exception using errcode = '23514', message = 'Carryover reversal must exactly reverse a confirmed normal carryover.';
      end if;
    end if;
    return new;
  end if;
  raise exception using errcode = '22023', message = 'Unsupported Ledger relationship target.';
end;
$$;

create or replace function public.financial_validate_carryover_verified_lineage()
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
  if new.transaction_kind = 'NORMAL' then
    select project_id, fiscal_year into v_source_project_id, v_source_fiscal_year
    from public.project_budget_years where id = new.source_budget_year_id;
    select project_id, fiscal_year into v_destination_project_id, v_destination_fiscal_year
    from public.project_budget_years where id = new.destination_budget_year_id;
    perform public.financial_assert_carryover_same_verified_lineage(
      v_source_project_id, v_destination_project_id,
      v_source_fiscal_year, v_destination_fiscal_year
    );
  end if;
  return new;
end;
$$;

drop trigger if exists project_carryovers_validate_lineage on public.project_carryovers;
create trigger project_carryovers_validate_lineage
  before insert or update of source_budget_year_id, destination_budget_year_id
  on public.project_carryovers
  for each row execute function public.financial_validate_carryover_verified_lineage();

-- ---------------------------------------------------------------------------
-- 9. Manual Legacy reconstruction RPCs and idempotent materialization
-- ---------------------------------------------------------------------------

create or replace function public.financial_validate_legacy_reconstruction_values(
  p_event_type text,
  p_project_id uuid,
  p_destination_project_id uuid,
  p_funding_entry_id uuid,
  p_lineage_id uuid,
  p_evidence_id uuid,
  p_origin_fiscal_year integer,
  p_fiscal_year integer,
  p_destination_fiscal_year integer,
  p_legacy_prior_carryover_count smallint,
  p_amount bigint,
  p_effective_date date,
  p_carryover_sequence smallint,
  p_carryover_type text,
  p_adjustment_type text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_region_id uuid;
  v_project_year integer;
  v_destination_region_id uuid;
  v_destination_year integer;
  v_funding public.legacy_ledger_reconstruction_entries%rowtype;
  v_verified_lineage_id uuid;
  v_expected_sequence smallint;
begin
  select region_id, year into v_region_id, v_project_year
  from public.projects where id = p_project_id;
  if v_region_id is null or v_project_year is distinct from p_fiscal_year then
    raise exception using errcode = '23514', message =
      'Legacy reconstruction project and fiscal year must match an existing project row.';
  end if;
  if p_amount is null or p_amount <= 0
     or p_effective_date not between date '2022-01-01' and date '2026-08-31'
     or p_event_type not in ('ALLOCATION', 'EXECUTION', 'CARRYOVER', 'TRANSFER', 'ADJUSTMENT') then
    raise exception using errcode = '22023', message = 'Invalid Legacy reconstruction event, amount, or date.';
  end if;
  if not exists (
    select 1 from public.ledger_evidence
    where id = p_evidence_id and region_id = v_region_id
      and evidence_scope = 'LEGACY_RECONSTRUCTION'
      and verification_status <> 'REJECTED'
  ) then
    raise exception using errcode = '23514', message = 'Legacy evidence must belong to the event region and not be rejected.';
  end if;

  if p_event_type = 'ALLOCATION' then
    if p_funding_entry_id is not null or p_destination_project_id is not null
       or p_origin_fiscal_year is distinct from p_fiscal_year
       or p_legacy_prior_carryover_count is distinct from 0
       or extract(year from p_effective_date)::integer <> p_fiscal_year
       or p_lineage_id is not null or p_carryover_sequence is not null
       or p_carryover_type is not null or p_adjustment_type is not null then
      raise exception using errcode = '23514', message =
        'Legacy ALLOCATION must use the first allocation project/year: fiscal_year = origin_fiscal_year and prior carryover count = 0.';
    end if;
  else
    if p_origin_fiscal_year is not null or p_legacy_prior_carryover_count is not null then
      raise exception using errcode = '23514', message =
        'Non-ALLOCATION Legacy events must leave origin_fiscal_year and legacy_prior_carryover_count NULL and derive origin from funding_entry_id.';
    end if;
    select * into v_funding
    from public.legacy_ledger_reconstruction_entries
      where id = p_funding_entry_id and event_type = 'ALLOCATION'
        and region_id = v_region_id and status <> 'REJECTED';
    if not found or v_funding.fiscal_year <> v_funding.origin_fiscal_year
       or v_funding.legacy_prior_carryover_count <> 0 then
      raise exception using errcode = '23514', message = 'Legacy events require a same-region ALLOCATION funding entry.';
    end if;
  end if;

  if p_event_type = 'EXECUTION' then
    if p_destination_project_id is not null or p_carryover_sequence is not null
       or p_carryover_type is not null or p_adjustment_type is not null then
      raise exception using errcode = '23514', message = 'Contradictory Legacy EXECUTION facts.';
    end if;
  elsif p_event_type in ('CARRYOVER', 'TRANSFER') then
    select region_id, year into v_destination_region_id, v_destination_year
    from public.projects where id = p_destination_project_id;
    if v_destination_region_id is distinct from v_region_id
       or v_destination_year is distinct from p_destination_fiscal_year then
      raise exception using errcode = '23514', message = 'Legacy destination project must match region and destination fiscal year.';
    end if;
    if p_event_type = 'CARRYOVER' and (
      p_destination_fiscal_year is distinct from p_fiscal_year + 1
      or p_lineage_id is null or p_carryover_sequence not between 1 and 2
      or p_carryover_type not in ('MYEONGSI', 'SAGO') or p_adjustment_type is not null
    ) then
      raise exception using errcode = '23514', message = 'Legacy CARRYOVER requires explicit lineage, occurrence, type, and adjacent years.';
    end if;
    if p_event_type = 'CARRYOVER' then
      v_verified_lineage_id := public.financial_assert_carryover_same_verified_lineage(
        p_project_id, p_destination_project_id, p_fiscal_year, p_destination_fiscal_year
      );
      if p_lineage_id is distinct from v_verified_lineage_id then
        raise exception using errcode = '23514', message =
          'Selected Legacy CARRYOVER lineage must equal the VERIFIED lineage connecting source and destination.';
      end if;
      v_expected_sequence := (p_destination_fiscal_year - v_funding.origin_fiscal_year)::smallint;
      if p_carryover_sequence is distinct from v_expected_sequence
         or p_carryover_type is distinct from
           (case when v_expected_sequence = 1 then 'MYEONGSI' else 'SAGO' end)
         or (v_expected_sequence = 1 and (
           p_project_id <> v_funding.project_id
           or p_fiscal_year <> v_funding.origin_fiscal_year
         ))
         or (v_expected_sequence = 2 and not exists (
           select 1 from public.legacy_ledger_reconstruction_entries as previous
           where previous.funding_entry_id = v_funding.id
             and previous.event_type = 'CARRYOVER'
             and previous.status <> 'REJECTED'
             and previous.carryover_sequence = 1
             and previous.destination_project_id = p_project_id
             and previous.destination_fiscal_year = p_fiscal_year
         )) then
        raise exception using errcode = '23514', message =
          'Legacy CARRYOVER must form an explicit sequence-1/2 history from the first allocation year.';
      end if;
    end if;
    if p_event_type = 'TRANSFER' and (
      p_destination_fiscal_year is distinct from p_fiscal_year
      or p_carryover_sequence is not null or p_carryover_type is not null
      or p_adjustment_type is not null
    ) then
      raise exception using errcode = '23514', message = 'Legacy TRANSFER requires same-year explicit source/destination projects.';
    end if;
  elsif p_event_type = 'ADJUSTMENT' then
    if p_destination_project_id is not null
       or p_adjustment_type not in ('RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_INCREASE', 'CORRECTION_DECREASE')
       or p_carryover_sequence is not null or p_carryover_type is not null then
      raise exception using errcode = '23514', message = 'Legacy ADJUSTMENT requires an explicit adjustment type.';
    end if;
  end if;
  return v_region_id;
end;
$$;

create or replace function public.financial_create_legacy_reconstruction_entry(
  p_event_type text,
  p_project_id uuid,
  p_destination_project_id uuid,
  p_funding_entry_id uuid,
  p_lineage_id uuid,
  p_evidence_id uuid,
  p_origin_fiscal_year integer,
  p_fiscal_year integer,
  p_destination_fiscal_year integer,
  p_legacy_prior_carryover_count smallint,
  p_amount bigint,
  p_effective_date date,
  p_carryover_sequence smallint,
  p_carryover_type text,
  p_adjustment_type text,
  p_reason_code text,
  p_memo text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_region_id uuid;
  v_payload jsonb;
  v_fingerprint text;
  v_entry public.legacy_ledger_reconstruction_entries%rowtype;
begin
  select actor_id, actor_role, actor_region_id
    into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'Legacy reconstruction idempotency key is required.';
  end if;
  v_region_id := public.financial_validate_legacy_reconstruction_values(
    p_event_type, p_project_id, p_destination_project_id, p_funding_entry_id,
    p_lineage_id, p_evidence_id, p_origin_fiscal_year, p_fiscal_year,
    p_destination_fiscal_year, p_legacy_prior_carryover_count, p_amount,
    p_effective_date, p_carryover_sequence, p_carryover_type, p_adjustment_type
  );
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'Legacy drafts may only be created for the actor region.';
  end if;
  v_payload := jsonb_build_object(
    'event_type', p_event_type, 'project_id', p_project_id,
    'destination_project_id', p_destination_project_id, 'funding_entry_id', p_funding_entry_id,
    'lineage_id', p_lineage_id, 'evidence_id', p_evidence_id,
    'fiscal_year', p_fiscal_year,
    'destination_fiscal_year', p_destination_fiscal_year,
    'amount', p_amount, 'effective_date', p_effective_date,
    'carryover_sequence', p_carryover_sequence, 'carryover_type', p_carryover_type,
    'adjustment_type', p_adjustment_type, 'reason_code', nullif(btrim(p_reason_code), ''),
    'memo', nullif(btrim(p_memo), '')
  ) || case when p_event_type = 'ALLOCATION' then jsonb_build_object(
    'origin_fiscal_year', p_origin_fiscal_year,
    'legacy_prior_carryover_count', p_legacy_prior_carryover_count
  ) else '{}'::jsonb end;
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_entry from public.legacy_ledger_reconstruction_entries
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_entry.request_fingerprint, v_fingerprint, 'legacy_ledger_reconstruction_entries'
    );
    return v_entry.id;
  end if;

  insert into public.legacy_ledger_reconstruction_entries (
    region_id, event_type, project_id, destination_project_id, funding_entry_id,
    lineage_id, evidence_id, origin_fiscal_year, fiscal_year, destination_fiscal_year,
    legacy_prior_carryover_count, amount, effective_date, carryover_sequence,
    carryover_type, adjustment_type, reason_code, memo, status, idempotency_key,
    request_fingerprint, created_by
  ) values (
    v_region_id, p_event_type, p_project_id, p_destination_project_id, p_funding_entry_id,
    p_lineage_id, p_evidence_id, p_origin_fiscal_year, p_fiscal_year,
    p_destination_fiscal_year, p_legacy_prior_carryover_count, p_amount,
    p_effective_date, p_carryover_sequence, p_carryover_type, p_adjustment_type,
    nullif(btrim(p_reason_code), ''), nullif(btrim(p_memo), ''), 'DRAFT',
    p_idempotency_key, v_fingerprint, v_actor_id
  ) returning * into v_entry;
  return v_entry.id;
end;
$$;

create or replace function public.financial_update_legacy_reconstruction_entry(
  p_entry_id uuid,
  p_event_type text,
  p_project_id uuid,
  p_destination_project_id uuid,
  p_funding_entry_id uuid,
  p_lineage_id uuid,
  p_evidence_id uuid,
  p_origin_fiscal_year integer,
  p_fiscal_year integer,
  p_destination_fiscal_year integer,
  p_legacy_prior_carryover_count smallint,
  p_amount bigint,
  p_effective_date date,
  p_carryover_sequence smallint,
  p_carryover_type text,
  p_adjustment_type text,
  p_reason_code text,
  p_memo text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_region_id uuid;
  v_entry public.legacy_ledger_reconstruction_entries%rowtype;
  v_payload jsonb;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_entry from public.legacy_ledger_reconstruction_entries where id = p_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Legacy reconstruction entry was not found.'; end if;
  if v_entry.status <> 'DRAFT'
     or (v_role = 'local_user' and (v_entry.created_by <> v_actor_id or v_entry.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT Legacy entry may be edited.';
  end if;
  v_region_id := public.financial_validate_legacy_reconstruction_values(
    p_event_type, p_project_id, p_destination_project_id, p_funding_entry_id,
    p_lineage_id, p_evidence_id, p_origin_fiscal_year, p_fiscal_year,
    p_destination_fiscal_year, p_legacy_prior_carryover_count, p_amount,
    p_effective_date, p_carryover_sequence, p_carryover_type, p_adjustment_type
  );
  if v_region_id <> v_entry.region_id or (v_role = 'local_user' and v_region_id <> v_actor_region_id) then
    raise exception using errcode = '42501', message = 'A Legacy draft cannot move to another region.';
  end if;
  v_payload := jsonb_build_object(
    'event_type', p_event_type, 'project_id', p_project_id,
    'destination_project_id', p_destination_project_id, 'funding_entry_id', p_funding_entry_id,
    'lineage_id', p_lineage_id, 'evidence_id', p_evidence_id,
    'fiscal_year', p_fiscal_year,
    'destination_fiscal_year', p_destination_fiscal_year,
    'amount', p_amount, 'effective_date', p_effective_date,
    'carryover_sequence', p_carryover_sequence, 'carryover_type', p_carryover_type,
    'adjustment_type', p_adjustment_type, 'reason_code', nullif(btrim(p_reason_code), ''),
    'memo', nullif(btrim(p_memo), '')
  ) || case when p_event_type = 'ALLOCATION' then jsonb_build_object(
    'origin_fiscal_year', p_origin_fiscal_year,
    'legacy_prior_carryover_count', p_legacy_prior_carryover_count
  ) else '{}'::jsonb end;
  update public.legacy_ledger_reconstruction_entries
  set event_type = p_event_type, project_id = p_project_id,
      destination_project_id = p_destination_project_id, funding_entry_id = p_funding_entry_id,
      lineage_id = p_lineage_id, evidence_id = p_evidence_id,
      origin_fiscal_year = p_origin_fiscal_year, fiscal_year = p_fiscal_year,
      destination_fiscal_year = p_destination_fiscal_year,
      legacy_prior_carryover_count = p_legacy_prior_carryover_count,
      amount = p_amount, effective_date = p_effective_date,
      carryover_sequence = p_carryover_sequence, carryover_type = p_carryover_type,
      adjustment_type = p_adjustment_type, reason_code = nullif(btrim(p_reason_code), ''),
      memo = nullif(btrim(p_memo), ''),
      request_fingerprint = public.financial_request_fingerprint(v_payload)
  where id = v_entry.id;
end;
$$;

create or replace function public.financial_submit_legacy_reconstruction(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_entry public.legacy_ledger_reconstruction_entries%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_entry from public.legacy_ledger_reconstruction_entries where id = p_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Legacy reconstruction entry was not found.'; end if;
  if v_entry.status = 'SUBMITTED' then return; end if;
  if v_entry.status <> 'DRAFT'
     or (v_role = 'local_user' and (v_entry.created_by <> v_actor_id or v_entry.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT Legacy entry may be submitted.';
  end if;
  update public.legacy_ledger_reconstruction_entries
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_entry.id;
  perform public.financial_write_audit(
    v_entry.project_id, v_entry.region_id, 'LEGACY_RECONSTRUCTION_SUBMITTED',
    'legacy_ledger_reconstruction_entries', v_entry.id, v_actor_id,
    jsonb_build_object('event_type', v_entry.event_type, 'request_fingerprint', v_entry.request_fingerprint)
  );
end;
$$;

create or replace function public.financial_verify_legacy_reconstruction(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_entry public.legacy_ledger_reconstruction_entries%rowtype;
  v_funding public.legacy_ledger_reconstruction_entries%rowtype;
  v_verified_lineage_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_entry from public.legacy_ledger_reconstruction_entries where id = p_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Legacy reconstruction entry was not found.'; end if;
  if v_entry.status = 'VERIFIED' then return; end if;
  if v_entry.status <> 'SUBMITTED' or v_entry.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Legacy VERIFY requires a different admin from the maker.';
  end if;
  if not exists (
    select 1 from public.ledger_evidence
    where id = v_entry.evidence_id and region_id = v_entry.region_id
      and evidence_scope = 'LEGACY_RECONSTRUCTION'
      and verification_status = 'VERIFIED'
  ) then
    raise exception using errcode = '23514', message = 'Legacy VERIFY requires VERIFIED same-region evidence.';
  end if;
  if v_entry.event_type <> 'ALLOCATION' then
    if v_entry.origin_fiscal_year is not null or v_entry.legacy_prior_carryover_count is not null then
      raise exception using errcode = '23514', message =
        'Non-ALLOCATION Legacy events must derive origin facts only from funding_entry_id.';
    end if;
    select * into v_funding
    from public.legacy_ledger_reconstruction_entries
    where id = v_entry.funding_entry_id and event_type = 'ALLOCATION'
      and region_id = v_entry.region_id
      and status in ('VERIFIED', 'APPLIED') and origin_fiscal_year is not null
      and fiscal_year = origin_fiscal_year and legacy_prior_carryover_count = 0;
    if not found then
      raise exception using errcode = '23514', message = 'Legacy VERIFY requires a verified allocation with known origin/count.';
    end if;
  end if;
  if v_entry.event_type = 'CARRYOVER' then
    v_verified_lineage_id := public.financial_assert_carryover_same_verified_lineage(
      v_entry.project_id, v_entry.destination_project_id,
      v_entry.fiscal_year, v_entry.destination_fiscal_year
    );
    if v_entry.lineage_id is distinct from v_verified_lineage_id then
      raise exception using errcode = '23514', message =
        'Selected Legacy CARRYOVER lineage must equal the VERIFIED source/destination lineage.';
    end if;
    if v_entry.carryover_sequence is distinct from
         (v_entry.destination_fiscal_year - v_funding.origin_fiscal_year)::smallint
       or v_entry.carryover_type is distinct from (case
         when v_entry.destination_fiscal_year - v_funding.origin_fiscal_year = 1
           then 'MYEONGSI'
         when v_entry.destination_fiscal_year - v_funding.origin_fiscal_year = 2
           then 'SAGO'
         else null
       end) then
      raise exception using errcode = '23514', message =
        'Legacy CARRYOVER sequence/type must be recalculated from the funding ALLOCATION origin year.';
    end if;
    if not exists (
      select 1 from public.legacy_ledger_reconstruction_entries as funding
      where funding.id = v_entry.funding_entry_id and funding.event_type = 'ALLOCATION'
        and funding.status = 'APPLIED' and funding.fiscal_year = funding.origin_fiscal_year
        and funding.legacy_prior_carryover_count = 0
    ) or (v_entry.carryover_sequence = 2 and not exists (
      select 1 from public.legacy_ledger_reconstruction_entries as previous
      where previous.funding_entry_id = v_entry.funding_entry_id
        and previous.event_type = 'CARRYOVER' and previous.status = 'APPLIED'
        and previous.carryover_sequence = 1
        and previous.destination_project_id = v_entry.project_id
        and previous.destination_fiscal_year = v_entry.fiscal_year
    )) then
      raise exception using errcode = '23514', message =
        'Legacy CARRYOVER VERIFY requires the applied first allocation and every prior carryover in sequence.';
    end if;
  end if;
  update public.legacy_ledger_reconstruction_entries
  set status = 'VERIFIED', verified_by = v_actor_id, verified_at = clock_timestamp()
  where id = v_entry.id;
  perform public.financial_write_audit(
    v_entry.project_id, v_entry.region_id, 'LEGACY_RECONSTRUCTION_VERIFIED',
    'legacy_ledger_reconstruction_entries', v_entry.id, v_actor_id,
    jsonb_build_object('event_type', v_entry.event_type, 'evidence_id', v_entry.evidence_id)
  );
end;
$$;

create or replace function public.financial_reject_legacy_reconstruction(
  p_entry_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_entry public.legacy_ledger_reconstruction_entries%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Legacy rejection reason is required.';
  end if;
  select * into v_entry from public.legacy_ledger_reconstruction_entries where id = p_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Legacy reconstruction entry was not found.'; end if;
  if v_entry.status = 'REJECTED' then return; end if;
  if v_entry.status <> 'SUBMITTED' or v_entry.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Legacy rejection requires a different admin from the maker.';
  end if;
  update public.legacy_ledger_reconstruction_entries
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_entry.id;
end;
$$;

create or replace function public.financial_apply_legacy_reconstruction(p_entry_id uuid)
returns table (materialized_table text, materialized_record_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_entry public.legacy_ledger_reconstruction_entries%rowtype;
  v_funding public.legacy_ledger_reconstruction_entries%rowtype;
  v_source_wallet_id uuid;
  v_destination_wallet_id uuid;
  v_record_id uuid;
  v_table text;
  v_verified_lineage_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_entry from public.legacy_ledger_reconstruction_entries where id = p_entry_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Legacy reconstruction entry was not found.'; end if;
  if v_entry.status = 'APPLIED' then
    return query select v_entry.materialized_table, v_entry.materialized_record_id;
    return;
  end if;
  if v_entry.status <> 'VERIFIED' or v_entry.created_by = v_actor_id
     or v_entry.verified_by is null or v_entry.verified_by = v_entry.created_by then
    raise exception using errcode = '42501', message = 'Legacy APPLY requires VERIFIED state and a different admin from the maker.';
  end if;
  perform public.financial_require_ledger_write('LEGACY_EXCEL', v_entry.effective_date, v_entry.evidence_id);

  if v_entry.event_type = 'ALLOCATION' then
    if v_entry.fiscal_year <> v_entry.origin_fiscal_year
       or v_entry.legacy_prior_carryover_count <> 0 then
      raise exception using errcode = '23514', message =
        'Legacy ALLOCATION can only materialize from the first allocation project/year with prior carryover count 0.';
    end if;
    insert into public.project_budget_cohorts (
      origin_project_id, origin_fiscal_year, initial_allocation, allocation_type,
      memo, idempotency_key, created_by, source_type, legacy_carryover_status,
      legacy_prior_carryover_count, carryover_verified_by, carryover_verified_at,
      carryover_verification_note, effective_date, record_origin, evidence_id,
      request_fingerprint, reconciliation_status
    ) values (
      v_entry.project_id, v_entry.origin_fiscal_year, v_entry.amount, 'INITIAL',
      v_entry.memo, v_entry.idempotency_key, v_entry.created_by, 'LEGACY_RECONSTRUCTION',
      'VERIFIED', v_entry.legacy_prior_carryover_count, v_entry.verified_by,
      v_entry.verified_at, coalesce(v_entry.memo, 'Verified Legacy reconstruction'),
      v_entry.effective_date, 'LEGACY_EXCEL', v_entry.evidence_id,
      v_entry.request_fingerprint, 'RECONCILED'
    ) returning id into v_record_id;
    v_source_wallet_id := public.financial_get_or_create_budget_year(
      v_entry.project_id, v_record_id, v_entry.fiscal_year, v_entry.created_by
    );
    update public.legacy_ledger_reconstruction_entries
    set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
        applied_cohort_id = v_record_id, materialized_table = 'project_budget_cohorts',
        materialized_record_id = v_record_id
    where id = v_entry.id;
    v_table := 'project_budget_cohorts';
  else
    if v_entry.origin_fiscal_year is not null or v_entry.legacy_prior_carryover_count is not null then
      raise exception using errcode = '23514', message =
        'Non-ALLOCATION Legacy APPLY derives origin facts only from the referenced ALLOCATION.';
    end if;
    select * into v_funding
    from public.legacy_ledger_reconstruction_entries
    where id = v_entry.funding_entry_id and event_type = 'ALLOCATION' and status = 'APPLIED'
      and region_id = v_entry.region_id
      and applied_cohort_id is not null and fiscal_year = origin_fiscal_year
      and legacy_prior_carryover_count = 0;
    if not found then
      raise exception using errcode = '23514', message = 'Apply the referenced Legacy ALLOCATION before this event.';
    end if;
    select id into v_source_wallet_id
    from public.project_budget_years
    where project_id = v_entry.project_id
      and budget_cohort_id = v_funding.applied_cohort_id
      and fiscal_year = v_entry.fiscal_year;
    if not found then
      raise exception using errcode = '23514', message =
        'Legacy event source wallet must already exist through the applied allocation/carryover history.';
    end if;

    if v_entry.event_type = 'EXECUTION' then
      perform 1 from public.project_budget_years where id = v_source_wallet_id for update;
      perform public.financial_require_available_amount(
        v_source_wallet_id, v_entry.amount, 'Insufficient Legacy cohort balance for reconstructed execution.'
      );
      insert into public.project_execution_records (
        budget_year_id, amount, execution_date, status, transaction_kind, memo,
        idempotency_key, created_by, confirmed_by, confirmed_at,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_wallet_id, v_entry.amount, v_entry.effective_date, 'CONFIRMED', 'NORMAL',
        v_entry.memo, v_entry.idempotency_key, v_entry.created_by, v_actor_id, clock_timestamp(),
        'LEGACY_EXCEL', v_entry.evidence_id, v_entry.request_fingerprint
      ) returning id into v_record_id;
      v_table := 'project_execution_records';
    elsif v_entry.event_type = 'CARRYOVER' then
      v_verified_lineage_id := public.financial_assert_carryover_same_verified_lineage(
        v_entry.project_id, v_entry.destination_project_id,
        v_entry.fiscal_year, v_entry.destination_fiscal_year
      );
      if v_entry.lineage_id is distinct from v_verified_lineage_id then
        raise exception using errcode = '23514', message =
          'Selected Legacy CARRYOVER lineage must equal the VERIFIED source/destination lineage at APPLY.';
      end if;
      if v_entry.carryover_sequence is distinct from
           (v_entry.destination_fiscal_year - v_funding.origin_fiscal_year)::smallint
         or v_entry.carryover_type is distinct from (case
           when v_entry.destination_fiscal_year - v_funding.origin_fiscal_year = 1
             then 'MYEONGSI'
           when v_entry.destination_fiscal_year - v_funding.origin_fiscal_year = 2
             then 'SAGO'
           else null
         end) then
        raise exception using errcode = '23514', message =
          'Legacy CARRYOVER APPLY recalculates sequence/type from the funding ALLOCATION origin year.';
      end if;
      if v_entry.carryover_sequence = 2 and not exists (
        select 1 from public.legacy_ledger_reconstruction_entries as previous
        where previous.funding_entry_id = v_entry.funding_entry_id
          and previous.event_type = 'CARRYOVER' and previous.status = 'APPLIED'
          and previous.carryover_sequence = 1
          and previous.destination_project_id = v_entry.project_id
          and previous.destination_fiscal_year = v_entry.fiscal_year
      ) then
        raise exception using errcode = '23514', message =
          'Second Legacy carryover cannot APPLY before the first carryover has been APPLIED.';
      end if;
      v_destination_wallet_id := public.financial_get_or_create_budget_year(
        v_entry.destination_project_id, v_funding.applied_cohort_id,
        v_entry.destination_fiscal_year, v_entry.created_by
      );
      perform 1 from public.project_budget_years
      where id = any(array[v_source_wallet_id, v_destination_wallet_id]) order by id for update;
      perform public.financial_require_available_amount(
        v_source_wallet_id, v_entry.amount, 'Insufficient Legacy cohort balance for reconstructed carryover.'
      );
      insert into public.project_carryovers (
        source_budget_year_id, destination_budget_year_id, amount, carryover_sequence,
        carryover_type, status, transaction_kind, memo, idempotency_key,
        created_by, confirmed_by, confirmed_at, effective_date,
        record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_wallet_id, v_destination_wallet_id, v_entry.amount,
        v_entry.carryover_sequence, v_entry.carryover_type, 'CONFIRMED', 'NORMAL',
        v_entry.memo, v_entry.idempotency_key, v_entry.created_by, v_actor_id,
        clock_timestamp(), v_entry.effective_date, 'LEGACY_EXCEL',
        v_entry.evidence_id, v_entry.request_fingerprint
      ) returning id into v_record_id;
      v_table := 'project_carryovers';
    elsif v_entry.event_type = 'TRANSFER' then
      v_destination_wallet_id := public.financial_get_or_create_budget_year(
        v_entry.destination_project_id, v_funding.applied_cohort_id,
        v_entry.destination_fiscal_year, v_entry.created_by
      );
      perform 1 from public.project_budget_years
      where id = any(array[v_source_wallet_id, v_destination_wallet_id]) order by id for update;
      perform public.financial_require_available_amount(
        v_source_wallet_id, v_entry.amount, 'Insufficient Legacy cohort balance for reconstructed transfer.'
      );
      insert into public.project_fund_transfers (
        source_budget_year_id, destination_budget_year_id, amount, status, transaction_kind,
        reason_code, memo, effective_date, idempotency_key, created_by, submitted_at,
        confirmed_by, confirmed_at, record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_wallet_id, v_destination_wallet_id, v_entry.amount, 'CONFIRMED', 'NORMAL',
        v_entry.reason_code, v_entry.memo, v_entry.effective_date, v_entry.idempotency_key,
        v_entry.created_by, v_entry.submitted_at, v_actor_id, clock_timestamp(),
        'LEGACY_EXCEL', v_entry.evidence_id, v_entry.request_fingerprint
      ) returning id into v_record_id;
      v_table := 'project_fund_transfers';
    elsif v_entry.event_type = 'ADJUSTMENT' then
      if v_entry.adjustment_type in ('RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_DECREASE') then
        perform public.financial_require_available_amount(
          v_source_wallet_id, v_entry.amount, 'Insufficient Legacy cohort balance for reconstructed adjustment.'
        );
      end if;
      insert into public.project_budget_adjustments (
        budget_year_id, adjustment_type, amount, status, transaction_kind,
        reason_code, memo, effective_date, idempotency_key, created_by,
        confirmed_by, confirmed_at, record_origin, evidence_id, request_fingerprint
      ) values (
        v_source_wallet_id, v_entry.adjustment_type, v_entry.amount, 'CONFIRMED', 'NORMAL',
        v_entry.reason_code, v_entry.memo, v_entry.effective_date, v_entry.idempotency_key,
        v_entry.created_by, v_actor_id, clock_timestamp(), 'LEGACY_EXCEL',
        v_entry.evidence_id, v_entry.request_fingerprint
      ) returning id into v_record_id;
      v_table := 'project_budget_adjustments';
    end if;
    update public.legacy_ledger_reconstruction_entries
    set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
        applied_cohort_id = v_funding.applied_cohort_id, materialized_table = v_table,
        materialized_record_id = v_record_id
    where id = v_entry.id;
  end if;

  perform public.financial_write_audit(
    v_entry.project_id, v_entry.region_id, 'LEGACY_RECONSTRUCTION_APPLIED',
    'legacy_ledger_reconstruction_entries', v_entry.id, v_actor_id,
    jsonb_build_object('event_type', v_entry.event_type,
      'materialized_table', v_table, 'materialized_record_id', v_record_id,
      'evidence_id', v_entry.evidence_id)
  );
  return query select v_table, v_record_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Vetted SYSTEM_NATIVE cohort, execution, and transfer RPCs
-- ---------------------------------------------------------------------------

drop function public.create_project_budget_cohort(uuid, integer, bigint, text, text, uuid);
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
  v_project_region_id uuid;
  v_project_year integer;
  v_payload jsonb;
  v_fingerprint text;
  v_cohort public.project_budget_cohorts%rowtype;
  v_budget_year_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  perform public.financial_require_ledger_write('SYSTEM_NATIVE', p_effective_date, null);
  if p_idempotency_key is null or p_initial_allocation is null or p_initial_allocation <= 0
     or p_origin_fiscal_year not between 2000 and 2200
     or p_allocation_type not in ('INITIAL', 'EXTERNAL_INCREASE') then
    raise exception using errcode = '22023', message = 'Invalid SYSTEM_NATIVE funding cohort input.';
  end if;
  select region_id, year into v_project_region_id, v_project_year
  from public.projects where id = p_project_id and project_code is not null;
  if v_project_region_id is null or v_project_year is distinct from p_origin_fiscal_year then
    raise exception using errcode = '23514', message = 'Funding cohort project and origin fiscal year must match.';
  end if;
  v_payload := jsonb_build_object(
    'project_id', p_project_id, 'origin_fiscal_year', p_origin_fiscal_year,
    'initial_allocation', p_initial_allocation, 'allocation_type', p_allocation_type,
    'memo', nullif(btrim(p_memo), ''), 'effective_date', p_effective_date,
    'record_origin', 'SYSTEM_NATIVE', 'evidence_id', null
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_cohort from public.project_budget_cohorts
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_cohort.request_fingerprint, v_fingerprint, 'project_budget_cohorts'
    );
    v_budget_year_id := public.financial_get_or_create_budget_year(
      v_cohort.origin_project_id, v_cohort.id, v_cohort.origin_fiscal_year, v_actor_id
    );
    return query select v_cohort.id, v_budget_year_id;
    return;
  end if;
  insert into public.project_budget_cohorts (
    origin_project_id, origin_fiscal_year, initial_allocation, allocation_type,
    memo, idempotency_key, created_by, source_type, effective_date,
    record_origin, evidence_id, request_fingerprint, reconciliation_status
  ) values (
    p_project_id, p_origin_fiscal_year, p_initial_allocation, p_allocation_type,
    nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id, 'STANDARD',
    p_effective_date, 'SYSTEM_NATIVE', null, v_fingerprint, 'RECONCILED'
  ) returning * into v_cohort;
  v_budget_year_id := public.financial_get_or_create_budget_year(
    p_project_id, v_cohort.id, p_origin_fiscal_year, v_actor_id
  );
  perform public.financial_write_audit(
    p_project_id, v_project_region_id, 'CREATE_BUDGET_COHORT', 'project_budget_cohorts',
    v_cohort.id, v_actor_id, v_payload || jsonb_build_object('budget_year_id', v_budget_year_id)
  );
  return query select v_cohort.id, v_budget_year_id;
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
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_wallet public.project_budget_years%rowtype;
  v_region_id uuid;
  v_payload jsonb;
  v_fingerprint text;
  v_execution public.project_execution_records%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  perform public.financial_require_ledger_write('SYSTEM_NATIVE', p_execution_date, null);
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Execution amount/date/idempotency key are required.';
  end if;
  v_payload := jsonb_build_object(
    'budget_year_id', p_budget_year_id, 'amount', p_amount,
    'execution_date', p_execution_date, 'memo', nullif(btrim(p_memo), ''),
    'record_origin', 'SYSTEM_NATIVE', 'evidence_id', null
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_execution from public.project_execution_records
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_execution.request_fingerprint, v_fingerprint, 'project_execution_records'
    );
    return query select v_execution.id, v_execution.status;
    return;
  end if;
  select * into v_wallet from public.project_budget_years
  where id = p_budget_year_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Execution wallet was not found.'; end if;
  select region_id into v_region_id from public.projects where id = v_wallet.project_id;
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'A local user may execute only own-region funds.';
  end if;
  perform public.financial_require_available_amount(
    p_budget_year_id, p_amount, 'Insufficient available funds for execution.'
  );
  insert into public.project_execution_records (
    budget_year_id, amount, execution_date, status, transaction_kind, memo,
    idempotency_key, created_by, confirmed_by, confirmed_at,
    record_origin, evidence_id, request_fingerprint
  ) values (
    p_budget_year_id, p_amount, p_execution_date, 'CONFIRMED', 'NORMAL',
    nullif(btrim(p_memo), ''), p_idempotency_key, v_actor_id, v_actor_id,
    clock_timestamp(), 'SYSTEM_NATIVE', null, v_fingerprint
  ) returning * into v_execution;
  perform public.financial_write_audit(
    v_wallet.project_id, v_region_id, 'EXECUTION_CONFIRMED', 'project_execution_records',
    v_execution.id, v_actor_id, v_payload
  );
  return query select v_execution.id, v_execution.status;
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
set search_path = public, pg_temp
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
  v_requested_status text := case when coalesce(p_submit, true) then 'PENDING_APPROVAL' else 'DRAFT' end;
  v_payload jsonb;
  v_fingerprint text;
  v_transfer public.project_fund_transfers%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  perform public.financial_require_ledger_write('SYSTEM_NATIVE', p_effective_date, null);
  if p_idempotency_key is null or p_amount is null or p_amount <= 0 then
    raise exception using errcode = '22023', message = 'Transfer amount/date/idempotency key are required.';
  end if;
  select * into v_source from public.project_budget_years where id = p_source_budget_year_id;
  if not found then raise exception using errcode = 'P0002', message = 'Transfer source wallet was not found.'; end if;
  select region_id into v_source_region_id from public.projects where id = v_source.project_id;
  select region_id, year into v_destination_region_id, v_destination_year
  from public.projects where id = p_destination_project_id and project_code is not null;
  if v_destination_region_id is null or v_destination_region_id <> v_source_region_id
     or v_destination_year is distinct from v_source.fiscal_year
     or p_destination_project_id = v_source.project_id then
    raise exception using errcode = '23514', message = 'Transfer requires distinct same-region projects in the same fiscal year.';
  end if;
  if v_role = 'local_user' and v_source_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'A local user may request only own-region transfers.';
  end if;
  v_payload := jsonb_build_object(
    'source_budget_year_id', p_source_budget_year_id,
    'destination_project_id', p_destination_project_id, 'amount', p_amount,
    'reason_code', nullif(btrim(p_reason_code), ''), 'memo', nullif(btrim(p_memo), ''),
    'effective_date', p_effective_date, 'record_origin', 'SYSTEM_NATIVE', 'evidence_id', null
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_transfer from public.project_fund_transfers
  where idempotency_key = p_idempotency_key;
  if found then
    if v_transfer.created_by <> v_actor_id and v_role <> 'admin' then
      raise exception using errcode = '42501', message = 'Another maker owns this transfer idempotency key.';
    end if;
    perform public.financial_assert_same_fingerprint(
      v_transfer.request_fingerprint, v_fingerprint, 'project_fund_transfers'
    );
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;
  v_destination_budget_year_id := public.financial_get_or_create_budget_year(
    p_destination_project_id, v_source.budget_cohort_id, v_source.fiscal_year, v_actor_id
  );
  perform 1 from public.project_budget_years
  where id = any(array[p_source_budget_year_id, v_destination_budget_year_id]) order by id for update;
  if v_requested_status = 'PENDING_APPROVAL' then
    perform public.financial_require_available_amount(
      p_source_budget_year_id, p_amount, 'Insufficient available funds for transfer reservation.'
    );
  end if;
  insert into public.project_fund_transfers (
    source_budget_year_id, destination_budget_year_id, amount, status, transaction_kind,
    reason_code, memo, effective_date, idempotency_key, created_by, submitted_at,
    record_origin, evidence_id, request_fingerprint
  ) values (
    p_source_budget_year_id, v_destination_budget_year_id, p_amount, v_requested_status, 'NORMAL',
    nullif(btrim(p_reason_code), ''), nullif(btrim(p_memo), ''), p_effective_date,
    p_idempotency_key, v_actor_id,
    case when v_requested_status = 'PENDING_APPROVAL' then clock_timestamp() else null end,
    'SYSTEM_NATIVE', null, v_fingerprint
  ) returning * into v_transfer;
  perform public.financial_write_audit(
    v_source.project_id, v_source_region_id,
    case when v_requested_status = 'PENDING_APPROVAL' then 'TRANSFER_SUBMITTED' else 'TRANSFER_DRAFTED' end,
    'project_fund_transfers', v_transfer.id, v_actor_id, v_payload
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

create or replace function public.approve_transfer(
  p_transfer_id uuid,
  p_resolution_note text default null
)
returns table (transfer_id uuid, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_transfer public.project_fund_transfers%rowtype;
  v_source_project_id uuid;
  v_source_region_id uuid;
  v_available bigint;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id;
  if not found then raise exception using errcode = 'P0002', message = 'Transfer request was not found.'; end if;
  perform 1 from public.project_budget_years
  where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
  order by id for update;
  select * into v_transfer from public.project_fund_transfers where id = p_transfer_id for update;
  if v_transfer.status = 'CONFIRMED' then
    return query select v_transfer.id, v_transfer.status;
    return;
  end if;
  if v_transfer.status <> 'PENDING_APPROVAL' or v_transfer.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Transfer approval requires PENDING_APPROVAL and a different admin from the maker.';
  end if;
  select available_to_commit into v_available
  from public.financial_get_budget_year_balance(v_transfer.source_budget_year_id);
  if v_available is null or v_available < 0 then
    raise exception using errcode = '23514', message = 'Available balance is insufficient after concurrent confirmed activity.';
  end if;
  update public.project_fund_transfers
  set status = 'CONFIRMED', confirmed_by = v_actor_id, confirmed_at = clock_timestamp(),
      resolution_note = nullif(btrim(p_resolution_note), '')
  where id = v_transfer.id returning * into v_transfer;
  select projects.id, projects.region_id into v_source_project_id, v_source_region_id
  from public.project_budget_years as wallet
  join public.projects on projects.id = wallet.project_id
  where wallet.id = v_transfer.source_budget_year_id;
  perform public.financial_write_audit(
    v_source_project_id, v_source_region_id, 'TRANSFER_CONFIRMED', 'project_fund_transfers',
    v_transfer.id, v_actor_id, jsonb_build_object(
      'amount', v_transfer.amount, 'request_fingerprint', v_transfer.request_fingerprint
    )
  );
  return query select v_transfer.id, v_transfer.status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Native maker-checker request RPCs and materialization
-- ---------------------------------------------------------------------------

create or replace function public.financial_validate_change_request_payload(
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
  v_amount bigint;
  v_effective_date date;
  v_source public.project_budget_years%rowtype;
  v_destination_project_id uuid;
  v_destination_region_id uuid;
  v_destination_year integer;
  v_budget_year_id uuid;
  v_original_record_id uuid;
  v_reversed_amount bigint;
  v_execution public.project_execution_records%rowtype;
  v_carryover public.project_carryovers%rowtype;
  v_transfer public.project_fund_transfers%rowtype;
  v_adjustment public.project_budget_adjustments%rowtype;
begin
  if p_request_type is null or p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or p_request_type not in (
       'CARRYOVER', 'BUDGET_ADJUSTMENT', 'EXECUTION_REVERSAL',
       'CARRYOVER_REVERSAL', 'TRANSFER_REVERSAL', 'ADJUSTMENT_REVERSAL'
     )
     or not (p_payload ?& array['amount', 'effective_date'])
     or jsonb_typeof(p_payload -> 'amount') <> 'number'
     or (p_payload ->> 'amount') !~ '^[1-9][0-9]*$'
     or jsonb_typeof(p_payload -> 'effective_date') <> 'string'
     or (p_payload ->> 'effective_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or (p_payload ? 'memo' and p_payload -> 'memo' <> 'null'::jsonb
       and (jsonb_typeof(p_payload -> 'memo') <> 'string'
         or char_length(p_payload ->> 'memo') > 1000)) then
    raise exception using errcode = '22023', message =
      'Ledger change request has an unsupported type or malformed amount/effective_date/memo.';
  end if;
  v_amount := (p_payload ->> 'amount')::bigint;
  v_effective_date := (p_payload ->> 'effective_date')::date;
  if v_effective_date::text <> p_payload ->> 'effective_date' then
    raise exception using errcode = '22023', message = 'Ledger change effective_date must be a real ISO calendar date.';
  end if;

  if p_request_type = 'CARRYOVER' then
    if not (p_payload ?& array['source_budget_year_id', 'destination_project_id'])
       or jsonb_typeof(p_payload -> 'source_budget_year_id') <> 'string'
       or jsonb_typeof(p_payload -> 'destination_project_id') <> 'string' then
      raise exception using errcode = '22023', message =
        'CARRYOVER requires UUID source_budget_year_id and destination_project_id.';
    end if;
    select * into v_source
    from public.project_budget_years
    where id = (p_payload ->> 'source_budget_year_id')::uuid;
    if found then
      select region_id into v_region_id
      from public.projects where id = v_source.project_id;
    end if;
    v_destination_project_id := (p_payload ->> 'destination_project_id')::uuid;
    select region_id, year into v_destination_region_id, v_destination_year
    from public.projects where id = v_destination_project_id;
    if v_source.id is null or v_destination_region_id is null
       or v_destination_region_id <> v_region_id
       or v_destination_year <> v_source.fiscal_year + 1 then
      raise exception using errcode = '23514', message =
        'CARRYOVER requires existing same-region source/destination rows in adjacent fiscal years.';
    end if;
    perform public.financial_assert_carryover_same_verified_lineage(
      v_source.project_id, v_destination_project_id, v_source.fiscal_year, v_destination_year
    );
  elsif p_request_type = 'BUDGET_ADJUSTMENT' then
    if not (p_payload ?& array['budget_year_id', 'adjustment_type'])
       or jsonb_typeof(p_payload -> 'budget_year_id') <> 'string'
       or jsonb_typeof(p_payload -> 'adjustment_type') <> 'string'
       or (p_payload ->> 'adjustment_type') not in (
         'RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_INCREASE', 'CORRECTION_DECREASE'
       ) then
      raise exception using errcode = '22023', message =
        'BUDGET_ADJUSTMENT requires UUID budget_year_id and a supported adjustment_type.';
    end if;
    v_budget_year_id := (p_payload ->> 'budget_year_id')::uuid;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_budget_year_id;
  elsif p_request_type = 'EXECUTION_REVERSAL' then
    if not (p_payload ? 'original_record_id')
       or jsonb_typeof(p_payload -> 'original_record_id') <> 'string' then
      raise exception using errcode = '22023', message = 'EXECUTION_REVERSAL requires UUID original_record_id.';
    end if;
    v_original_record_id := (p_payload ->> 'original_record_id')::uuid;
    select records.* into v_execution
    from public.project_execution_records as records
    where records.id = v_original_record_id
      and records.status = 'CONFIRMED' and records.transaction_kind = 'NORMAL';
    if not found then
      raise exception using errcode = '23514', message = 'EXECUTION_REVERSAL requires a confirmed normal execution.';
    end if;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_execution.budget_year_id;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_execution_records
    where reversal_of = v_execution.id and transaction_kind = 'REVERSAL';
    if v_amount > v_execution.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Requested execution reversal exceeds the currently unreversed amount.';
    end if;
  elsif p_request_type = 'CARRYOVER_REVERSAL' then
    if not (p_payload ? 'original_record_id')
       or jsonb_typeof(p_payload -> 'original_record_id') <> 'string' then
      raise exception using errcode = '22023', message = 'CARRYOVER_REVERSAL requires UUID original_record_id.';
    end if;
    v_original_record_id := (p_payload ->> 'original_record_id')::uuid;
    select * into v_carryover from public.project_carryovers
    where id = v_original_record_id and status = 'CONFIRMED' and transaction_kind = 'NORMAL';
    if not found then
      raise exception using errcode = '23514', message = 'CARRYOVER_REVERSAL requires a confirmed normal carryover.';
    end if;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_carryover.destination_budget_year_id;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_carryovers
    where reversal_of = v_carryover.id and transaction_kind = 'REVERSAL';
    if v_amount > v_carryover.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Requested carryover reversal exceeds the currently unreversed amount.';
    end if;
  elsif p_request_type = 'TRANSFER_REVERSAL' then
    if not (p_payload ? 'original_record_id')
       or jsonb_typeof(p_payload -> 'original_record_id') <> 'string' then
      raise exception using errcode = '22023', message = 'TRANSFER_REVERSAL requires UUID original_record_id.';
    end if;
    v_original_record_id := (p_payload ->> 'original_record_id')::uuid;
    select * into v_transfer from public.project_fund_transfers
    where id = v_original_record_id and status = 'CONFIRMED' and transaction_kind = 'NORMAL';
    if not found then
      raise exception using errcode = '23514', message = 'TRANSFER_REVERSAL requires a confirmed normal transfer.';
    end if;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_transfer.destination_budget_year_id;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_fund_transfers
    where reversal_of = v_transfer.id and transaction_kind = 'REVERSAL' and status = 'CONFIRMED';
    if v_amount > v_transfer.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Requested transfer reversal exceeds the currently unreversed amount.';
    end if;
  elsif p_request_type = 'ADJUSTMENT_REVERSAL' then
    if not (p_payload ? 'original_record_id')
       or jsonb_typeof(p_payload -> 'original_record_id') <> 'string' then
      raise exception using errcode = '22023', message = 'ADJUSTMENT_REVERSAL requires UUID original_record_id.';
    end if;
    v_original_record_id := (p_payload ->> 'original_record_id')::uuid;
    select * into v_adjustment from public.project_budget_adjustments
    where id = v_original_record_id and status = 'CONFIRMED' and transaction_kind = 'NORMAL';
    if not found then
      raise exception using errcode = '23514', message = 'ADJUSTMENT_REVERSAL requires a confirmed normal adjustment.';
    end if;
    select projects.region_id into v_region_id
    from public.project_budget_years as wallets
    join public.projects on projects.id = wallets.project_id
    where wallets.id = v_adjustment.budget_year_id;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_budget_adjustments
    where reversal_of = v_adjustment.id and transaction_kind = 'REVERSAL';
    if v_amount > v_adjustment.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Requested adjustment reversal exceeds the currently unreversed amount.';
    end if;
  end if;
  if v_region_id is null then
    raise exception using errcode = 'P0002', message = 'Ledger change request source record was not found.';
  end if;
  return v_region_id;
exception
  when invalid_text_representation or invalid_datetime_format
    or datetime_field_overflow or numeric_value_out_of_range then
    raise exception using errcode = '22023', message =
      'Ledger change request contains a malformed UUID, date, or bigint.';
end;
$$;

create or replace function public.financial_change_request_region(
  p_request_type text,
  p_payload jsonb
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.financial_validate_change_request_payload(p_request_type, p_payload);
$$;

create or replace function public.financial_validate_change_request_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.status in ('REJECTED', 'APPLIED') then
    raise exception using errcode = '55000', message = 'Terminal Ledger change requests are immutable.';
  end if;
  if row(new.request_type, new.region_id, new.payload, new.idempotency_key,
         new.request_fingerprint, new.requested_by, new.requested_at)
     is distinct from
     row(old.request_type, old.region_id, old.payload, old.idempotency_key,
         old.request_fingerprint, old.requested_by, old.requested_at) then
    raise exception using errcode = '55000', message = 'Ledger change request facts are immutable.';
  end if;
  if not (
    (old.status = 'DRAFT' and new.status = 'SUBMITTED')
    or (old.status = 'SUBMITTED' and new.status in ('APPROVED', 'REJECTED'))
    or (old.status = 'APPROVED' and new.status = 'APPLIED')
  ) then
    raise exception using errcode = '23514', message = 'Invalid Ledger change request state transition.';
  end if;
  return new;
end;
$$;

create trigger financial_ledger_change_requests_state_guard
  before update or delete on public.financial_ledger_change_requests
  for each row execute function public.financial_validate_change_request_mutation();

create or replace function public.financial_create_ledger_change_request(
  p_request_type text,
  p_payload jsonb,
  p_idempotency_key uuid,
  p_submit boolean default true
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
  v_effective_date date;
  v_canonical_payload jsonb;
  v_fingerprint text;
  v_request public.financial_ledger_change_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'Ledger change request requires an idempotency key.';
  end if;
  v_region_id := public.financial_validate_change_request_payload(p_request_type, p_payload);
  v_effective_date := (p_payload ->> 'effective_date')::date;
  perform public.financial_require_ledger_write('SYSTEM_NATIVE', v_effective_date, null);
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'A local user may request only own-region Ledger changes.';
  end if;
  v_canonical_payload := jsonb_build_object(
    'request_type', p_request_type, 'payload', p_payload,
    'record_origin', 'SYSTEM_NATIVE', 'evidence_id', null
  );
  v_fingerprint := public.financial_request_fingerprint(v_canonical_payload);
  select * into v_request from public.financial_ledger_change_requests
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_request.request_fingerprint, v_fingerprint, 'financial_ledger_change_requests'
    );
    return query select v_request.id, v_request.status;
    return;
  end if;
  insert into public.financial_ledger_change_requests (
    request_type, region_id, payload, status, idempotency_key, request_fingerprint,
    requested_by, submitted_by, submitted_at
  ) values (
    p_request_type, v_region_id, p_payload,
    case when coalesce(p_submit, true) then 'SUBMITTED' else 'DRAFT' end,
    p_idempotency_key, v_fingerprint, v_actor_id,
    case when coalesce(p_submit, true) then v_actor_id else null end,
    case when coalesce(p_submit, true) then clock_timestamp() else null end
  ) returning * into v_request;
  if v_request.status = 'SUBMITTED' then
    perform public.financial_write_audit(
      null, v_region_id, 'LEDGER_CHANGE_SUBMITTED', 'financial_ledger_change_requests',
      v_request.id, v_actor_id,
      jsonb_build_object('request_type', p_request_type, 'request_fingerprint', v_fingerprint)
    );
  end if;
  return query select v_request.id, v_request.status;
end;
$$;

create or replace function public.financial_submit_ledger_change_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_request public.financial_ledger_change_requests%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select * into v_request from public.financial_ledger_change_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger change request was not found.'; end if;
  if v_request.status = 'SUBMITTED' then return; end if;
  if v_request.status <> 'DRAFT'
     or (v_role = 'local_user' and (v_request.requested_by <> v_actor_id or v_request.region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT request may be submitted.';
  end if;
  update public.financial_ledger_change_requests
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_request.id;
end;
$$;

create or replace function public.financial_approve_ledger_change_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_ledger_change_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_ledger_change_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger change request was not found.'; end if;
  if v_request.status = 'APPROVED' then return; end if;
  if v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Ledger change approval requires a different admin from the maker.';
  end if;
  update public.financial_ledger_change_requests
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where id = v_request.id;
end;
$$;

create or replace function public.financial_reject_ledger_change_request(
  p_request_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_ledger_change_requests%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Ledger change rejection reason is required.';
  end if;
  select * into v_request from public.financial_ledger_change_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger change request was not found.'; end if;
  if v_request.status = 'REJECTED' then return; end if;
  if v_request.status <> 'SUBMITTED' or v_request.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Ledger change rejection requires a different admin from the maker.';
  end if;
  update public.financial_ledger_change_requests
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_request.id;
end;
$$;

create or replace function public.financial_apply_ledger_change_request(p_request_id uuid)
returns table (materialized_table text, materialized_record_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_request public.financial_ledger_change_requests%rowtype;
  v_validated_region_id uuid;
  v_amount bigint;
  v_effective_date date;
  v_source public.project_budget_years%rowtype;
  v_destination_project_id uuid;
  v_destination_region_id uuid;
  v_destination_year integer;
  v_destination_wallet_id uuid;
  v_origin_year integer;
  v_sequence smallint;
  v_type text;
  v_record_id uuid;
  v_table text;
  v_reversed_amount bigint;
  v_execution public.project_execution_records%rowtype;
  v_carryover public.project_carryovers%rowtype;
  v_transfer public.project_fund_transfers%rowtype;
  v_adjustment public.project_budget_adjustments%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_request from public.financial_ledger_change_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger change request was not found.'; end if;
  if v_request.status = 'APPLIED' then
    return query select v_request.materialized_table, v_request.materialized_record_id;
    return;
  end if;
  if v_request.status <> 'APPROVED' or v_request.requested_by = v_actor_id
     or v_request.approved_by is null or v_request.approved_by = v_request.requested_by then
    raise exception using errcode = '42501', message = 'Ledger APPLY requires approved maker-checker separation.';
  end if;
  v_validated_region_id := public.financial_validate_change_request_payload(
    v_request.request_type, v_request.payload
  );
  if v_validated_region_id is distinct from v_request.region_id then
    raise exception using errcode = '23514', message =
      'Ledger change request region no longer matches its current source records.';
  end if;
  v_amount := (v_request.payload ->> 'amount')::bigint;
  v_effective_date := (v_request.payload ->> 'effective_date')::date;
  perform public.financial_require_ledger_write('SYSTEM_NATIVE', v_effective_date, null);

  if v_request.request_type = 'CARRYOVER' then
    select * into v_source from public.project_budget_years
    where id = (v_request.payload ->> 'source_budget_year_id')::uuid;
    v_destination_project_id := (v_request.payload ->> 'destination_project_id')::uuid;
    select region_id, year into v_destination_region_id, v_destination_year
    from public.projects where id = v_destination_project_id;
    perform public.financial_assert_carryover_same_verified_lineage(
      v_source.project_id, v_destination_project_id, v_source.fiscal_year, v_destination_year
    );
    select origin_fiscal_year into v_origin_year
    from public.project_budget_cohorts where id = v_source.budget_cohort_id;
    if v_origin_year is null then
      raise exception using errcode = '23514', message = 'Carryover cannot promote a cohort with unknown origin fiscal year.';
    end if;
    v_sequence := public.financial_expected_carryover_sequence(
      v_source.budget_cohort_id, v_source.fiscal_year, v_destination_year
    );
    if v_sequence not in (1, 2) then
      raise exception using errcode = '23514', message = 'Carryover is limited to two occurrences.';
    end if;
    v_type := case when v_sequence = 1 then 'MYEONGSI' else 'SAGO' end;
    v_destination_wallet_id := public.financial_get_or_create_budget_year(
      v_destination_project_id, v_source.budget_cohort_id, v_destination_year, v_request.requested_by
    );
    perform 1 from public.project_budget_years
    where id = any(array[v_source.id, v_destination_wallet_id]) order by id for update;
    perform public.financial_require_available_amount(v_source.id, v_amount, 'Insufficient funds for carryover.');
    insert into public.project_carryovers (
      source_budget_year_id, destination_budget_year_id, amount, carryover_sequence,
      carryover_type, status, transaction_kind, memo, idempotency_key,
      created_by, confirmed_by, confirmed_at, effective_date,
      record_origin, evidence_id, request_fingerprint
    ) values (
      v_source.id, v_destination_wallet_id, v_amount, v_sequence, v_type,
      'CONFIRMED', 'NORMAL', nullif(btrim(v_request.payload ->> 'memo'), ''),
      v_request.idempotency_key, v_request.requested_by, v_actor_id, clock_timestamp(),
      v_effective_date, 'SYSTEM_NATIVE', null, v_request.request_fingerprint
    ) returning id into v_record_id;
    v_table := 'project_carryovers';
  elsif v_request.request_type = 'BUDGET_ADJUSTMENT' then
    select * into v_source from public.project_budget_years
    where id = (v_request.payload ->> 'budget_year_id')::uuid for update;
    if (v_request.payload ->> 'adjustment_type') not in (
      'RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_INCREASE', 'CORRECTION_DECREASE'
    ) then raise exception using errcode = '22023', message = 'Invalid adjustment type.'; end if;
    if (v_request.payload ->> 'adjustment_type') in ('RETURN', 'EXTERNAL_DECREASE', 'CORRECTION_DECREASE') then
      perform public.financial_require_available_amount(v_source.id, v_amount, 'Insufficient funds for adjustment.');
    end if;
    insert into public.project_budget_adjustments (
      budget_year_id, adjustment_type, amount, status, transaction_kind,
      reason_code, memo, effective_date, idempotency_key, created_by,
      confirmed_by, confirmed_at, record_origin, evidence_id, request_fingerprint
    ) values (
      v_source.id, v_request.payload ->> 'adjustment_type', v_amount, 'CONFIRMED', 'NORMAL',
      nullif(btrim(v_request.payload ->> 'reason_code'), ''),
      nullif(btrim(v_request.payload ->> 'memo'), ''), v_effective_date,
      v_request.idempotency_key, v_request.requested_by, v_actor_id, clock_timestamp(),
      'SYSTEM_NATIVE', null, v_request.request_fingerprint
    ) returning id into v_record_id;
    v_table := 'project_budget_adjustments';
  elsif v_request.request_type = 'EXECUTION_REVERSAL' then
    select * into v_execution from public.project_execution_records
    where id = (v_request.payload ->> 'original_record_id')::uuid;
    if not found or v_execution.status <> 'CONFIRMED' or v_execution.transaction_kind <> 'NORMAL' then
      raise exception using errcode = '23514', message = 'Only confirmed normal execution may be reversed.';
    end if;
    perform 1 from public.project_budget_years where id = v_execution.budget_year_id for update;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_execution_records where reversal_of = v_execution.id and transaction_kind = 'REVERSAL';
    if v_amount > v_execution.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Execution reversal exceeds the unreversed amount.';
    end if;
    insert into public.project_execution_records (
      budget_year_id, amount, execution_date, status, transaction_kind, reversal_of,
      memo, idempotency_key, created_by, confirmed_by, confirmed_at,
      record_origin, evidence_id, request_fingerprint
    ) values (
      v_execution.budget_year_id, v_amount, v_effective_date, 'CONFIRMED', 'REVERSAL',
      v_execution.id, nullif(btrim(v_request.payload ->> 'memo'), ''),
      v_request.idempotency_key, v_request.requested_by, v_actor_id, clock_timestamp(),
      'SYSTEM_NATIVE', null, v_request.request_fingerprint
    ) returning id into v_record_id;
    v_table := 'project_execution_records';
  elsif v_request.request_type = 'CARRYOVER_REVERSAL' then
    select * into v_carryover from public.project_carryovers
    where id = (v_request.payload ->> 'original_record_id')::uuid;
    if not found or v_carryover.status <> 'CONFIRMED' or v_carryover.transaction_kind <> 'NORMAL' then
      raise exception using errcode = '23514', message = 'Only confirmed normal carryover may be reversed.';
    end if;
    perform 1 from public.project_budget_years
    where id = any(array[v_carryover.source_budget_year_id, v_carryover.destination_budget_year_id])
    order by id for update;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_carryovers where reversal_of = v_carryover.id and transaction_kind = 'REVERSAL';
    if v_amount > v_carryover.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Carryover reversal exceeds the unreversed amount.';
    end if;
    perform public.financial_require_available_amount(
      v_carryover.destination_budget_year_id, v_amount, 'Insufficient destination balance for carryover reversal.'
    );
    insert into public.project_carryovers (
      source_budget_year_id, destination_budget_year_id, amount, carryover_sequence,
      carryover_type, status, transaction_kind, reversal_of, memo, idempotency_key,
      created_by, confirmed_by, confirmed_at, effective_date,
      record_origin, evidence_id, request_fingerprint
    ) values (
      v_carryover.destination_budget_year_id, v_carryover.source_budget_year_id, v_amount,
      v_carryover.carryover_sequence, v_carryover.carryover_type, 'CONFIRMED', 'REVERSAL',
      v_carryover.id, nullif(btrim(v_request.payload ->> 'memo'), ''),
      v_request.idempotency_key, v_request.requested_by, v_actor_id, clock_timestamp(),
      v_effective_date, 'SYSTEM_NATIVE', null, v_request.request_fingerprint
    ) returning id into v_record_id;
    v_table := 'project_carryovers';
  elsif v_request.request_type = 'TRANSFER_REVERSAL' then
    select * into v_transfer from public.project_fund_transfers
    where id = (v_request.payload ->> 'original_record_id')::uuid;
    if not found or v_transfer.status <> 'CONFIRMED' or v_transfer.transaction_kind <> 'NORMAL' then
      raise exception using errcode = '23514', message = 'Only confirmed normal transfer may be reversed.';
    end if;
    perform 1 from public.project_budget_years
    where id = any(array[v_transfer.source_budget_year_id, v_transfer.destination_budget_year_id])
    order by id for update;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_fund_transfers where reversal_of = v_transfer.id
      and transaction_kind = 'REVERSAL' and status = 'CONFIRMED';
    if v_amount > v_transfer.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Transfer reversal exceeds the unreversed amount.';
    end if;
    perform public.financial_require_available_amount(
      v_transfer.destination_budget_year_id, v_amount, 'Insufficient destination balance for transfer reversal.'
    );
    insert into public.project_fund_transfers (
      source_budget_year_id, destination_budget_year_id, amount, status, transaction_kind,
      reversal_of, reason_code, memo, effective_date, idempotency_key, created_by,
      submitted_at, confirmed_by, confirmed_at, record_origin, evidence_id, request_fingerprint
    ) values (
      v_transfer.destination_budget_year_id, v_transfer.source_budget_year_id, v_amount,
      'CONFIRMED', 'REVERSAL', v_transfer.id, 'REVERSAL',
      nullif(btrim(v_request.payload ->> 'memo'), ''), v_effective_date,
      v_request.idempotency_key, v_request.requested_by, v_request.submitted_at,
      v_actor_id, clock_timestamp(), 'SYSTEM_NATIVE', null, v_request.request_fingerprint
    ) returning id into v_record_id;
    v_table := 'project_fund_transfers';
  elsif v_request.request_type = 'ADJUSTMENT_REVERSAL' then
    select * into v_adjustment from public.project_budget_adjustments
    where id = (v_request.payload ->> 'original_record_id')::uuid;
    if not found or v_adjustment.status <> 'CONFIRMED' or v_adjustment.transaction_kind <> 'NORMAL' then
      raise exception using errcode = '23514', message = 'Only confirmed normal adjustment may be reversed.';
    end if;
    perform 1 from public.project_budget_years where id = v_adjustment.budget_year_id for update;
    select coalesce(sum(amount), 0) into v_reversed_amount
    from public.project_budget_adjustments where reversal_of = v_adjustment.id and transaction_kind = 'REVERSAL';
    if v_amount > v_adjustment.amount - v_reversed_amount then
      raise exception using errcode = '23514', message = 'Adjustment reversal exceeds the unreversed amount.';
    end if;
    if v_adjustment.adjustment_type = 'CORRECTION_INCREASE' then
      perform public.financial_require_available_amount(
        v_adjustment.budget_year_id, v_amount, 'Insufficient balance for adjustment reversal.'
      );
    end if;
    insert into public.project_budget_adjustments (
      budget_year_id, adjustment_type, amount, status, transaction_kind, reversal_of,
      reason_code, memo, effective_date, idempotency_key, created_by,
      confirmed_by, confirmed_at, record_origin, evidence_id, request_fingerprint
    ) values (
      v_adjustment.budget_year_id, v_adjustment.adjustment_type, v_amount, 'CONFIRMED',
      'REVERSAL', v_adjustment.id, 'REVERSAL',
      nullif(btrim(v_request.payload ->> 'memo'), ''), v_effective_date,
      v_request.idempotency_key, v_request.requested_by, v_actor_id, clock_timestamp(),
      'SYSTEM_NATIVE', null, v_request.request_fingerprint
    ) returning id into v_record_id;
    v_table := 'project_budget_adjustments';
  end if;

  update public.financial_ledger_change_requests
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp(),
      materialized_table = v_table, materialized_record_id = v_record_id
  where id = v_request.id;
  perform public.financial_write_audit(
    null, v_request.region_id, 'LEDGER_CHANGE_APPLIED', 'financial_ledger_change_requests',
    v_request.id, v_actor_id, jsonb_build_object(
      'request_type', v_request.request_type, 'materialized_table', v_table,
      'materialized_record_id', v_record_id
    )
  );
  return query select v_table, v_record_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Baseline classification, correction, and fixed cutover RPCs
-- ---------------------------------------------------------------------------

alter table public.financial_ledger_cutovers
  add constraint financial_ledger_cutovers_fixed_policy_dates check (
    operating_start_date = date '2026-09-01'
    and baseline_as_of = date '2026-08-31'
  ),
  add constraint financial_ledger_cutovers_maker_checker check (
    status <> 'CONFIRMED' or confirmed_by <> created_by
  );

create or replace function public.financial_validate_baseline_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel text := current_setting('app.financial_baseline_write_channel', true);
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Legacy Baseline rows cannot be deleted.';
  end if;
  if v_channel not in ('REVIEW', 'CORRECTION', 'CUTOVER') then
    raise exception using errcode = '42501', message =
      'Direct Baseline updates are blocked; use review/correction/cutover RPCs.';
  end if;
  if exists (
    select 1 from public.financial_ledger_cutovers
    where id = old.cutover_id and status = 'CONFIRMED'
  ) and v_channel <> 'CORRECTION' then
    raise exception using errcode = '55000', message =
      'Confirmed Baseline rows may only change through an approved correction workflow.';
  end if;
  return new;
end;
$$;

create trigger project_financial_baselines_direct_mutation_guard
  before update or delete on public.project_financial_baselines
  for each row execute function public.financial_validate_baseline_mutation();

create or replace function public.financial_validate_baseline_correction_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' or old.status in ('REJECTED', 'APPLIED') then
    raise exception using errcode = '55000', message = 'Terminal Baseline corrections are immutable.';
  end if;
  if row(new.baseline_id, new.reason, new.effective_from, new.effective_to,
         new.previous_values, new.proposed_values, new.idempotency_key,
         new.request_fingerprint, new.requested_by, new.requested_at)
     is distinct from
     row(old.baseline_id, old.reason, old.effective_from, old.effective_to,
         old.previous_values, old.proposed_values, old.idempotency_key,
         old.request_fingerprint, old.requested_by, old.requested_at) then
    raise exception using errcode = '55000', message = 'Submitted Baseline correction facts are immutable.';
  end if;
  if not (
    (old.status = 'DRAFT' and new.status = 'SUBMITTED')
    or (old.status = 'SUBMITTED' and new.status in ('APPROVED', 'REJECTED'))
    or (old.status = 'APPROVED' and new.status = 'APPLIED')
  ) then
    raise exception using errcode = '23514', message = 'Invalid Baseline correction state transition.';
  end if;
  return new;
end;
$$;

create trigger project_baseline_corrections_state_guard
  before update or delete on public.project_baseline_corrections
  for each row execute function public.financial_validate_baseline_correction_mutation();

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
    raise exception using errcode = '23514', message = 'Approved native start date is 2026-09-01.';
  end if;
  if exists (
    select 1 from public.financial_ledger_cutovers
    where status in ('PREPARING', 'REVIEWING', 'CONFIRMED')
  ) then
    raise exception using errcode = '23505', message = 'An active or confirmed Ledger Cutover already exists.';
  end if;
  insert into public.financial_ledger_cutovers (
    operating_start_date, baseline_as_of, status, created_by, memo
  ) values (
    date '2026-09-01', date '2026-08-31', 'PREPARING', v_actor_id,
    nullif(btrim(p_memo), '')
  ) returning id into v_cutover_id;
  perform public.financial_write_audit(
    null, null, 'LEDGER_CUTOVER_CREATED', 'financial_ledger_cutovers',
    v_cutover_id, v_actor_id,
    jsonb_build_object('baseline_as_of', date '2026-08-31', 'native_start_date', date '2026-09-01')
  );
  return v_cutover_id;
end;
$$;

create or replace function public.financial_prepare_legacy_baselines(p_cutover_id uuid)
returns table (baseline_candidates integer, auto_excluded integer, needs_review integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  perform 1 from public.financial_ledger_cutovers
  where id = p_cutover_id and status = 'PREPARING' and baseline_as_of = date '2026-08-31'
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'Only the fixed PREPARING Cutover may snapshot Baseline candidates.';
  end if;
  lock table public.projects in share row exclusive mode;
  insert into public.project_financial_baselines (
    cutover_id, project_id, baseline_as_of, original_allocation,
    adjusted_allocation, cumulative_execution, verification_status,
    verification_note, source_type, source_snapshot
  )
  select p_cutover_id, projects.id, date '2026-08-31', projects.original_alloc,
    projects.alloc, projects.exec, 'NEEDS_REVIEW',
    'Candidate snapshot only; no automatic financial classification or wallet creation.',
    'LEGACY_BASELINE',
    jsonb_build_object(
      'project_id', projects.project_id, 'project_code', projects.project_code,
      'year', projects.year, 'original_alloc', projects.original_alloc,
      'alloc', projects.alloc, 'exec', projects.exec, 'captured_at', clock_timestamp()
    )
  from public.projects
  on conflict (cutover_id, project_id) do nothing;
  update public.financial_ledger_cutovers set status = 'REVIEWING' where id = p_cutover_id;
  return query
  select count(*)::integer, 0::integer,
    count(*) filter (where verification_status = 'NEEDS_REVIEW')::integer
  from public.project_financial_baselines where cutover_id = p_cutover_id;
end;
$$;

drop function public.financial_review_legacy_baseline(uuid, text, text);

create or replace function public.financial_resolve_applied_legacy_baseline_wallet(
  p_baseline_id uuid,
  p_classification text,
  p_legacy_funding_entry_id uuid,
  p_origin_fiscal_year integer,
  p_legacy_prior_carryover_count smallint,
  p_adjusted_allocation bigint,
  p_cumulative_execution bigint
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_baseline public.project_financial_baselines%rowtype;
  v_funding public.legacy_ledger_reconstruction_entries%rowtype;
  v_project_region_id uuid;
  v_project_year integer;
  v_budget_year_id uuid;
  v_ledger_execution bigint;
  v_available_balance bigint;
  v_cohort_accounting_balance bigint;
begin
  select * into v_baseline
  from public.project_financial_baselines
  where id = p_baseline_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Baseline was not found.';
  end if;
  select region_id, year into v_project_region_id, v_project_year
  from public.projects where id = v_baseline.project_id;
  if not found then raise exception using errcode = 'P0002', message = 'Baseline project was not found.'; end if;
  select * into v_funding
  from public.legacy_ledger_reconstruction_entries
  where id = p_legacy_funding_entry_id and event_type = 'ALLOCATION'
    and status = 'APPLIED' and region_id = v_project_region_id
    and applied_cohort_id is not null
    and fiscal_year = origin_fiscal_year
    and legacy_prior_carryover_count = 0;
  if p_classification not in ('HISTORICAL', 'ACTIVE_AT_CUTOVER')
     or not found
     or p_origin_fiscal_year is distinct from v_funding.origin_fiscal_year
     or p_legacy_prior_carryover_count is distinct from
       (v_project_year - v_funding.origin_fiscal_year)::smallint
     or p_legacy_prior_carryover_count not between 0 and 2 then
    raise exception using errcode = '23514', message =
      'HISTORICAL/ACTIVE Baselines must reference an APPLIED first-year Legacy ALLOCATION and the project-year carryover depth.';
  end if;
  if not exists (
    with recursive applied_path(project_id, fiscal_year, carryover_count) as (
      select v_funding.project_id, v_funding.fiscal_year, 0
      union all
      select carryovers.destination_project_id, carryovers.destination_fiscal_year,
        path.carryover_count + 1
      from applied_path as path
      join public.legacy_ledger_reconstruction_entries as carryovers
        on carryovers.funding_entry_id = v_funding.id
       and carryovers.event_type = 'CARRYOVER'
       and carryovers.status = 'APPLIED'
       and carryovers.project_id = path.project_id
       and carryovers.fiscal_year = path.fiscal_year
       and carryovers.destination_fiscal_year = path.fiscal_year + 1
       and carryovers.carryover_sequence = path.carryover_count + 1
      where path.carryover_count < 2
    )
    select 1 from applied_path
    where project_id = v_baseline.project_id and fiscal_year = v_project_year
      and carryover_count = p_legacy_prior_carryover_count
  ) then
    raise exception using errcode = '23514', message =
      'HISTORICAL/ACTIVE Baselines require a complete APPLIED carryover path from the first allocation project/year.';
  end if;
  select id into v_budget_year_id
  from public.project_budget_years
  where budget_cohort_id = v_funding.applied_cohort_id
    and project_id = v_baseline.project_id and fiscal_year = v_project_year;
  if not found then
    raise exception using errcode = '23514', message =
      'HISTORICAL/ACTIVE Baselines require a wallet materialized by APPLIED Legacy reconstruction.';
  end if;
  select coalesce(sum(case when transaction_kind = 'NORMAL' then amount else -amount end), 0)
    into v_ledger_execution
  from public.project_execution_records
  where budget_year_id = v_budget_year_id and status = 'CONFIRMED';
  select accounting_balance into v_available_balance
  from public.financial_get_budget_year_balance(v_budget_year_id);
  select coalesce(sum(balance.accounting_balance), 0)::bigint
    into v_cohort_accounting_balance
  from public.project_budget_years as wallets
  cross join lateral public.financial_get_budget_year_balance(wallets.id) as balance
  where wallets.budget_cohort_id = v_funding.applied_cohort_id;
  if p_classification = 'HISTORICAL' then
    if v_cohort_accounting_balance <> 0 then
      raise exception using errcode = '23514', message =
        'HISTORICAL requires complete APPLIED reconstruction with zero remaining cohort accounting balance.';
    end if;
    return v_budget_year_id;
  end if;
  if v_project_year is distinct from extract(year from v_baseline.baseline_as_of)::integer
     or p_adjusted_allocation is null or p_cumulative_execution is null
     or p_adjusted_allocation < 0 or p_cumulative_execution < 0
     or p_cumulative_execution > p_adjusted_allocation
     or v_ledger_execution <> p_cumulative_execution
     or v_available_balance <> p_adjusted_allocation - p_cumulative_execution
     or v_available_balance is null or v_available_balance <= 0 then
    raise exception using errcode = '23514', message =
      'ACTIVE_AT_CUTOVER requires a reconciled Cutover-year APPLIED wallet with accounting_balance > 0; zero balance is HISTORICAL.';
  end if;
  return v_budget_year_id;
end;
$$;

create function public.financial_review_legacy_baseline(
  p_baseline_id uuid,
  p_classification text,
  p_verification_note text,
  p_evidence_id uuid,
  p_legacy_funding_entry_id uuid,
  p_origin_fiscal_year integer,
  p_legacy_prior_carryover_count smallint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_baseline public.project_financial_baselines%rowtype;
  v_region_id uuid;
  v_budget_year_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if p_classification not in ('RECONCILED', 'HISTORICAL', 'EXCLUDED', 'ACTIVE_AT_CUTOVER')
     or char_length(btrim(coalesce(p_verification_note, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Explicit Baseline classification and reason are required.';
  end if;
  select baselines.* into v_baseline
  from public.project_financial_baselines as baselines
  join public.financial_ledger_cutovers as cutovers on cutovers.id = baselines.cutover_id
  where baselines.id = p_baseline_id and cutovers.status = 'REVIEWING'
  for update of baselines;
  if not found or v_baseline.verification_status <> 'NEEDS_REVIEW' then
    raise exception using errcode = '23514', message = 'Only NEEDS_REVIEW rows in a REVIEWING Cutover may be classified.';
  end if;
  select region_id into v_region_id from public.projects where id = v_baseline.project_id;
  if p_classification in ('RECONCILED', 'HISTORICAL', 'ACTIVE_AT_CUTOVER') and not exists (
    select 1 from public.ledger_evidence
    where id = p_evidence_id and region_id = v_region_id
      and evidence_scope = 'BASELINE' and verification_status = 'VERIFIED'
  ) then
    raise exception using errcode = '23514', message = 'This Baseline classification requires VERIFIED same-region evidence.';
  end if;
  if p_classification in ('HISTORICAL', 'ACTIVE_AT_CUTOVER') and (
    p_legacy_funding_entry_id is null
    or p_origin_fiscal_year not between 2000 and 2200
    or p_legacy_prior_carryover_count not between 0 and 2
    or (p_classification = 'ACTIVE_AT_CUTOVER' and (
      v_baseline.adjusted_allocation is null or v_baseline.cumulative_execution is null
      or v_baseline.adjusted_allocation < 0 or v_baseline.cumulative_execution < 0
      or v_baseline.cumulative_execution > v_baseline.adjusted_allocation
    ))
  ) then
    raise exception using errcode = '23514', message =
      'HISTORICAL/ACTIVE require APPLIED Legacy funding, known origin/count, and BASELINE evidence; ACTIVE also requires valid amounts.';
  end if;
  if p_classification in ('HISTORICAL', 'ACTIVE_AT_CUTOVER') then
    v_budget_year_id := public.financial_resolve_applied_legacy_baseline_wallet(
      v_baseline.id, p_classification, p_legacy_funding_entry_id, p_origin_fiscal_year,
      p_legacy_prior_carryover_count, v_baseline.adjusted_allocation,
      v_baseline.cumulative_execution
    );
  elsif p_legacy_funding_entry_id is not null
        or p_origin_fiscal_year is not null
        or p_legacy_prior_carryover_count is not null then
    raise exception using errcode = '23514', message =
      'Only HISTORICAL or ACTIVE_AT_CUTOVER may carry an APPLIED Legacy funding reference.';
  end if;
  perform set_config('app.financial_baseline_write_channel', 'REVIEW', true);
  update public.project_financial_baselines
  set verification_status = p_classification,
      verification_note = btrim(p_verification_note),
      evidence_id = p_evidence_id,
      legacy_funding_entry_id = case when p_classification in ('HISTORICAL', 'ACTIVE_AT_CUTOVER')
        then p_legacy_funding_entry_id else null end,
      ledger_budget_year_id = null,
      origin_fiscal_year = case when p_classification in ('HISTORICAL', 'ACTIVE_AT_CUTOVER')
        then p_origin_fiscal_year else null end,
      legacy_prior_carryover_count = case when p_classification in ('HISTORICAL', 'ACTIVE_AT_CUTOVER')
        then p_legacy_prior_carryover_count else null end,
      verified_by = v_actor_id,
      verified_at = clock_timestamp()
  where id = v_baseline.id;
  perform public.financial_write_audit(
    v_baseline.project_id, v_region_id, 'REVIEW_LEGACY_BASELINE',
    'project_financial_baselines', v_baseline.id, v_actor_id,
    jsonb_build_object('classification', p_classification, 'evidence_id', p_evidence_id,
      'legacy_funding_entry_id', p_legacy_funding_entry_id,
      'origin_fiscal_year', p_origin_fiscal_year,
      'legacy_prior_carryover_count', p_legacy_prior_carryover_count)
  );
end;
$$;

-- Compatibility name retained, but it is now a read-only report. It never
-- auto-promotes projects merely because projects.alloc/projects.exec reconcile.
create or replace function public.financial_verify_reconciled_legacy_baselines(p_cutover_id uuid)
returns table (verified_count integer, remaining_needs_review integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.financial_require_admin();
  return query
  select count(*) filter (where verification_status = 'RECONCILED')::integer,
    count(*) filter (where verification_status = 'NEEDS_REVIEW')::integer
  from public.project_financial_baselines
  where cutover_id = p_cutover_id;
end;
$$;

create or replace function public.financial_confirm_ledger_cutover(p_cutover_id uuid)
returns table (confirmed_baselines integer, excluded_baselines integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_cutover public.financial_ledger_cutovers%rowtype;
  v_baseline public.project_financial_baselines%rowtype;
  v_budget_year_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  if not exists (
    select 1 from public.financial_ledger_runtime
    where singleton = true and environment_kind = 'TEST'
      and bound_project_ref is not null and mode in ('RECONCILIATION', 'TEST')
  ) then
    raise exception using errcode = '55000', message =
      'Cutover confirm requires a bound TEST environment in RECONCILIATION or TEST mode.';
  end if;
  select * into v_cutover from public.financial_ledger_cutovers
  where id = p_cutover_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Ledger Cutover was not found.'; end if;
  if v_cutover.status = 'CONFIRMED' then
    return query select
      count(*) filter (where verification_status = 'ACTIVE_AT_CUTOVER')::integer,
      count(*) filter (where verification_status = 'EXCLUDED')::integer
    from public.project_financial_baselines where cutover_id = p_cutover_id;
    return;
  end if;
  if v_cutover.status <> 'REVIEWING' or v_cutover.created_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Cutover confirm requires REVIEWING and a different admin from the maker.';
  end if;
  if exists (
    select 1 from public.projects
    left join public.project_financial_baselines as baselines
      on baselines.cutover_id = p_cutover_id and baselines.project_id = projects.id
    where baselines.id is null
      or baselines.verification_status not in ('HISTORICAL', 'EXCLUDED', 'ACTIVE_AT_CUTOVER')
  ) then
    raise exception using errcode = '23514', message =
      'Every project must be explicitly HISTORICAL, EXCLUDED, or ACTIVE_AT_CUTOVER; RECONCILED alone is not final.';
  end if;
  if exists (
    select 1 from public.project_financial_baselines as baselines
    left join public.ledger_evidence as evidence on evidence.id = baselines.evidence_id
    where baselines.cutover_id = p_cutover_id
      and baselines.verification_status in ('HISTORICAL', 'ACTIVE_AT_CUTOVER')
      and (evidence.verification_status is distinct from 'VERIFIED'
        or evidence.evidence_scope is distinct from 'BASELINE'
        or baselines.legacy_funding_entry_id is null
        or baselines.origin_fiscal_year is null
        or baselines.legacy_prior_carryover_count is null)
  ) then
    raise exception using errcode = '23514', message =
      'HISTORICAL/ACTIVE rows require VERIFIED BASELINE evidence and an APPLIED Legacy funding reference with known origin/count.';
  end if;

  for v_baseline in
    select * from public.project_financial_baselines
    where cutover_id = p_cutover_id
      and verification_status in ('HISTORICAL', 'ACTIVE_AT_CUTOVER')
    order by project_id
  loop
    v_budget_year_id := public.financial_resolve_applied_legacy_baseline_wallet(
      v_baseline.id, v_baseline.verification_status, v_baseline.legacy_funding_entry_id,
      v_baseline.origin_fiscal_year, v_baseline.legacy_prior_carryover_count,
      v_baseline.adjusted_allocation, v_baseline.cumulative_execution
    );
    perform 1 from public.project_budget_years
    where id = v_budget_year_id for update;
    v_budget_year_id := public.financial_resolve_applied_legacy_baseline_wallet(
      v_baseline.id, v_baseline.verification_status, v_baseline.legacy_funding_entry_id,
      v_baseline.origin_fiscal_year, v_baseline.legacy_prior_carryover_count,
      v_baseline.adjusted_allocation, v_baseline.cumulative_execution
    );
    perform set_config('app.financial_baseline_write_channel', 'CUTOVER', true);
    update public.project_financial_baselines
    set ledger_budget_year_id = case
      when v_baseline.verification_status = 'ACTIVE_AT_CUTOVER' then v_budget_year_id
      else null
    end
    where id = v_baseline.id;
  end loop;

  update public.financial_ledger_cutovers
  set status = 'CONFIRMED', confirmed_by = v_actor_id, confirmed_at = clock_timestamp()
  where id = v_cutover.id;
  perform public.financial_write_audit(
    null, null, 'LEDGER_CUTOVER_CONFIRMED', 'financial_ledger_cutovers',
    v_cutover.id, v_actor_id,
    jsonb_build_object('baseline_as_of', v_cutover.baseline_as_of,
      'native_start_date', v_cutover.operating_start_date)
  );
  return query select
    count(*) filter (where verification_status = 'ACTIVE_AT_CUTOVER')::integer,
    count(*) filter (where verification_status = 'EXCLUDED')::integer
  from public.project_financial_baselines where cutover_id = p_cutover_id;
end;
$$;

-- Keep migration-19 metadata history behavior aligned with the new final
-- classification name. HISTORICAL/EXCLUDED rows never create active wallets.
create or replace function public.financial_metadata_history_project_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutover_id uuid;
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
  where baselines.project_id = new.id
    and baselines.verification_status = 'ACTIVE_AT_CUTOVER'
    and cutovers.status = 'CONFIRMED'
  limit 1;
  if v_cutover_id is not null then
    perform public.financial_capture_project_metadata_history(
      new.id, v_cutover_id, timezone('Asia/Seoul', clock_timestamp())::date, 'PROJECT_UPDATE'
    );
  end if;
  return new;
end;
$$;

create or replace function public.financial_metadata_history_small_category_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project_id uuid;
  v_cutover_id uuid;
begin
  if tg_op = 'DELETE' then v_project_id := old.project_id; else v_project_id := new.project_id; end if;
  select baselines.cutover_id into v_cutover_id
  from public.project_financial_baselines as baselines
  join public.financial_ledger_cutovers as cutovers on cutovers.id = baselines.cutover_id
  where baselines.project_id = v_project_id
    and baselines.verification_status = 'ACTIVE_AT_CUTOVER'
    and cutovers.status = 'CONFIRMED'
  limit 1;
  if v_cutover_id is not null then
    perform public.financial_capture_project_metadata_history(
      v_project_id, v_cutover_id,
      timezone('Asia/Seoul', clock_timestamp())::date, 'SMALL_CATEGORY_UPDATE'
    );
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.financial_request_baseline_correction(
  p_baseline_id uuid,
  p_proposed_values jsonb,
  p_reason text,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_baseline public.project_financial_baselines%rowtype;
  v_region_id uuid;
  v_previous_values jsonb;
  v_payload jsonb;
  v_fingerprint text;
  v_correction public.project_baseline_corrections%rowtype;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  if p_idempotency_key is null or jsonb_typeof(p_proposed_values) <> 'object'
     or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000
     or p_effective_from is null or (p_effective_to is not null and p_effective_to < p_effective_from) then
    raise exception using errcode = '22023', message = 'Invalid Baseline correction request.';
  end if;
  select baselines.* into v_baseline
  from public.project_financial_baselines as baselines
  where baselines.id = p_baseline_id;
  if not found then raise exception using errcode = 'P0002', message = 'Baseline was not found.'; end if;
  select region_id into v_region_id from public.projects where id = v_baseline.project_id;
  if v_role = 'local_user' and v_region_id <> v_actor_region_id then
    raise exception using errcode = '42501', message = 'A local user may request only own-region Baseline corrections.';
  end if;
  if not (p_proposed_values ?& array[
    'verification_status', 'verification_note', 'adjusted_allocation',
    'cumulative_execution', 'evidence_id', 'legacy_funding_entry_id', 'origin_fiscal_year',
    'legacy_prior_carryover_count'
  ]) then
    raise exception using errcode = '22023', message = 'Baseline correction proposed_values must explicitly include every controlled field.';
  end if;
  v_previous_values := jsonb_build_object(
    'verification_status', v_baseline.verification_status,
    'verification_note', v_baseline.verification_note,
    'adjusted_allocation', v_baseline.adjusted_allocation,
    'cumulative_execution', v_baseline.cumulative_execution,
    'evidence_id', v_baseline.evidence_id,
    'legacy_funding_entry_id', v_baseline.legacy_funding_entry_id,
    'origin_fiscal_year', v_baseline.origin_fiscal_year,
    'legacy_prior_carryover_count', v_baseline.legacy_prior_carryover_count
  );
  v_payload := jsonb_build_object(
    'baseline_id', p_baseline_id, 'previous_values', v_previous_values,
    'proposed_values', p_proposed_values, 'reason', btrim(p_reason),
    'effective_from', p_effective_from, 'effective_to', p_effective_to
  );
  v_fingerprint := public.financial_request_fingerprint(v_payload);
  select * into v_correction from public.project_baseline_corrections
  where idempotency_key = p_idempotency_key;
  if found then
    perform public.financial_assert_same_fingerprint(
      v_correction.request_fingerprint, v_fingerprint, 'project_baseline_corrections'
    );
    return v_correction.id;
  end if;
  insert into public.project_baseline_corrections (
    baseline_id, status, reason, effective_from, effective_to,
    previous_values, proposed_values, requested_by, idempotency_key, request_fingerprint
  ) values (
    p_baseline_id, 'DRAFT', btrim(p_reason), p_effective_from, p_effective_to,
    v_previous_values, p_proposed_values, v_actor_id, p_idempotency_key, v_fingerprint
  ) returning * into v_correction;
  return v_correction.id;
end;
$$;

create or replace function public.financial_submit_baseline_correction(p_correction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_role text;
  v_actor_region_id uuid;
  v_correction public.project_baseline_corrections%rowtype;
  v_region_id uuid;
begin
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  select corrections.* into v_correction
  from public.project_baseline_corrections as corrections
  join public.project_financial_baselines as baselines on baselines.id = corrections.baseline_id
  where corrections.id = p_correction_id for update of corrections;
  if not found then raise exception using errcode = 'P0002', message = 'Baseline correction was not found.'; end if;
  select projects.region_id into v_region_id
  from public.project_financial_baselines as baselines
  join public.projects on projects.id = baselines.project_id
  where baselines.id = v_correction.baseline_id;
  if v_correction.status = 'SUBMITTED' then return; end if;
  if v_correction.status <> 'DRAFT'
     or (v_role = 'local_user' and (v_correction.requested_by <> v_actor_id or v_region_id <> v_actor_region_id)) then
    raise exception using errcode = '42501', message = 'Only the owner-region DRAFT correction may be submitted.';
  end if;
  update public.project_baseline_corrections
  set status = 'SUBMITTED', submitted_by = v_actor_id, submitted_at = clock_timestamp()
  where id = v_correction.id;
end;
$$;

create or replace function public.financial_approve_baseline_correction(p_correction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_correction public.project_baseline_corrections%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_correction from public.project_baseline_corrections where id = p_correction_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Baseline correction was not found.'; end if;
  if v_correction.status = 'APPROVED' then return; end if;
  if v_correction.status <> 'SUBMITTED' or v_correction.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Baseline correction approval requires a different admin from the maker.';
  end if;
  update public.project_baseline_corrections
  set status = 'APPROVED', approved_by = v_actor_id, approved_at = clock_timestamp()
  where id = v_correction.id;
end;
$$;

create or replace function public.financial_reject_baseline_correction(
  p_correction_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_correction public.project_baseline_corrections%rowtype;
begin
  v_actor_id := public.financial_require_admin();
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Baseline correction rejection reason is required.';
  end if;
  select * into v_correction from public.project_baseline_corrections where id = p_correction_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Baseline correction was not found.'; end if;
  if v_correction.status = 'REJECTED' then return; end if;
  if v_correction.status <> 'SUBMITTED' or v_correction.requested_by = v_actor_id then
    raise exception using errcode = '42501', message = 'Baseline correction rejection requires a different admin from the maker.';
  end if;
  update public.project_baseline_corrections
  set status = 'REJECTED', rejected_by = v_actor_id, rejected_at = clock_timestamp(),
      rejection_reason = btrim(p_reason)
  where id = v_correction.id;
end;
$$;

create or replace function public.financial_apply_baseline_correction(p_correction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid;
  v_correction public.project_baseline_corrections%rowtype;
  v_baseline public.project_financial_baselines%rowtype;
  v_region_id uuid;
  v_status text;
  v_evidence_id uuid;
  v_legacy_funding_entry_id uuid;
  v_origin_fiscal_year integer;
  v_legacy_prior_carryover_count smallint;
  v_adjusted_allocation bigint;
  v_cumulative_execution bigint;
  v_budget_year_id uuid;
begin
  v_actor_id := public.financial_require_admin();
  select * into v_correction from public.project_baseline_corrections where id = p_correction_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Baseline correction was not found.'; end if;
  if v_correction.status = 'APPLIED' then return; end if;
  if v_correction.status <> 'APPROVED' or v_correction.requested_by = v_actor_id
     or v_correction.approved_by = v_correction.requested_by then
    raise exception using errcode = '42501', message = 'Baseline correction APPLY requires maker-checker separation.';
  end if;
  select baselines.* into v_baseline
  from public.project_financial_baselines as baselines
  join public.financial_ledger_cutovers as cutovers on cutovers.id = baselines.cutover_id
  where baselines.id = v_correction.baseline_id and cutovers.status = 'REVIEWING'
  for update of baselines;
  if not found then
    raise exception using errcode = '55000', message =
      'This phase applies Baseline corrections before Cutover confirm; post-confirm accounting corrections require a Ledger change request.';
  end if;
  select region_id into v_region_id from public.projects where id = v_baseline.project_id;
  if v_correction.previous_values is distinct from jsonb_build_object(
    'verification_status', v_baseline.verification_status,
    'verification_note', v_baseline.verification_note,
    'adjusted_allocation', v_baseline.adjusted_allocation,
    'cumulative_execution', v_baseline.cumulative_execution,
    'evidence_id', v_baseline.evidence_id,
    'legacy_funding_entry_id', v_baseline.legacy_funding_entry_id,
    'origin_fiscal_year', v_baseline.origin_fiscal_year,
    'legacy_prior_carryover_count', v_baseline.legacy_prior_carryover_count
  ) then
    raise exception using errcode = '40001', message = 'Baseline changed after correction request; request a new correction.';
  end if;
  v_status := v_correction.proposed_values ->> 'verification_status';
  v_evidence_id := nullif(v_correction.proposed_values ->> 'evidence_id', '')::uuid;
  v_legacy_funding_entry_id := nullif(
    v_correction.proposed_values ->> 'legacy_funding_entry_id', ''
  )::uuid;
  v_origin_fiscal_year := nullif(v_correction.proposed_values ->> 'origin_fiscal_year', '')::integer;
  v_legacy_prior_carryover_count := nullif(
    v_correction.proposed_values ->> 'legacy_prior_carryover_count', ''
  )::smallint;
  v_adjusted_allocation := nullif(
    v_correction.proposed_values ->> 'adjusted_allocation', ''
  )::bigint;
  v_cumulative_execution := nullif(
    v_correction.proposed_values ->> 'cumulative_execution', ''
  )::bigint;
  if v_status not in ('NEEDS_REVIEW', 'RECONCILED', 'HISTORICAL', 'EXCLUDED', 'ACTIVE_AT_CUTOVER') then
    raise exception using errcode = '23514', message = 'Invalid corrected Baseline classification.';
  end if;
  if v_status in ('RECONCILED', 'HISTORICAL', 'ACTIVE_AT_CUTOVER') and not exists (
    select 1 from public.ledger_evidence
    where id = v_evidence_id and region_id = v_region_id
      and evidence_scope = 'BASELINE' and verification_status = 'VERIFIED'
  ) then
    raise exception using errcode = '23514', message = 'Corrected classification requires VERIFIED same-region evidence.';
  end if;
  if v_status in ('HISTORICAL', 'ACTIVE_AT_CUTOVER') then
    v_budget_year_id := public.financial_resolve_applied_legacy_baseline_wallet(
      v_baseline.id, v_status, v_legacy_funding_entry_id, v_origin_fiscal_year,
      v_legacy_prior_carryover_count, v_adjusted_allocation, v_cumulative_execution
    );
  elsif v_legacy_funding_entry_id is not null
        or v_origin_fiscal_year is not null
        or v_legacy_prior_carryover_count is not null then
    raise exception using errcode = '23514', message =
      'Only HISTORICAL or ACTIVE_AT_CUTOVER may carry an APPLIED Legacy funding reference.';
  end if;
  perform set_config('app.financial_baseline_write_channel', 'CORRECTION', true);
  update public.project_financial_baselines
  set verification_status = v_status,
      verification_note = v_correction.proposed_values ->> 'verification_note',
      adjusted_allocation = nullif(v_correction.proposed_values ->> 'adjusted_allocation', '')::bigint,
      cumulative_execution = nullif(v_correction.proposed_values ->> 'cumulative_execution', '')::bigint,
      evidence_id = v_evidence_id,
      legacy_funding_entry_id = v_legacy_funding_entry_id,
      ledger_budget_year_id = null,
      origin_fiscal_year = nullif(v_correction.proposed_values ->> 'origin_fiscal_year', '')::integer,
      legacy_prior_carryover_count = nullif(
        v_correction.proposed_values ->> 'legacy_prior_carryover_count', ''
      )::smallint,
      verified_by = case when v_status = 'NEEDS_REVIEW' then null else v_actor_id end,
      verified_at = case when v_status = 'NEEDS_REVIEW' then null else clock_timestamp() end
  where id = v_baseline.id;
  update public.project_baseline_corrections
  set status = 'APPLIED', applied_by = v_actor_id, applied_at = clock_timestamp()
  where id = v_correction.id;
  perform public.financial_write_audit(
    v_baseline.project_id, v_region_id, 'BASELINE_CORRECTION_APPLIED',
    'project_baseline_corrections', v_correction.id, v_actor_id,
    jsonb_build_object('previous_values', v_correction.previous_values,
      'proposed_values', v_correction.proposed_values)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Cohort accounting view: one denominator, materialized execution only
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
      coalesce((
        select sum(cohorts.initial_allocation)::numeric
        from public.project_budget_cohorts as cohorts
        join wallet on wallet.budget_cohort_id = cohorts.id
        where cohorts.source_type in ('STANDARD', 'LEGACY_RECONSTRUCTION')
          and cohorts.origin_project_id = wallet.project_id
          and cohorts.origin_fiscal_year = wallet.fiscal_year
      ), 0::numeric) as initial_amount,
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
      coalesce((select sum(amount)::numeric from public.project_fund_transfers
        where source_budget_year_id = p_budget_year_id and status = 'PENDING_APPROVAL'), 0::numeric) as pending_reservation
  ), totals as (
    select initial_amount + transfer_in - transfer_out + carryover_in - carryover_out
      + execution_effect + adjustment_effect as accounting_amount,
      pending_reservation
    from components
  )
  select accounting_amount::bigint, pending_reservation::bigint,
    (accounting_amount - pending_reservation)::bigint
  from totals;
$$;

create view public.financial_funding_cohort_execution
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
      as adjustment_effect
  from public.project_budget_years as budget_years
  join public.project_budget_adjustments as adjustments
    on adjustments.budget_year_id = budget_years.id and adjustments.status = 'CONFIRMED'
  group by budget_years.budget_cohort_id
)
select
  cohorts.id as cohort_id,
  cohorts.id as funding_reference_id,
  projects.region_id,
  cohorts.origin_project_id as project_id,
  cohorts.origin_fiscal_year,
  cohorts.initial_allocation,
  coalesce(execution_totals.cumulative_execution, 0)::bigint as verified_cumulative_execution,
  (cohorts.initial_allocation
    - coalesce(execution_totals.cumulative_execution, 0)
    + coalesce(adjustment_totals.adjustment_effect, 0))::bigint as remaining_balance,
  case when cohorts.initial_allocation > 0 then
    round(coalesce(execution_totals.cumulative_execution, 0)::numeric
      * 100 / cohorts.initial_allocation::numeric, 2)
    else null end as execution_rate,
  cohorts.record_origin,
  cohorts.evidence_id,
  cohorts.reconciliation_status,
  'CONFIRMED_LEDGER'::text as ledger_state
from public.project_budget_cohorts as cohorts
join public.projects on projects.id = cohorts.origin_project_id
left join execution_totals on execution_totals.budget_cohort_id = cohorts.id
left join adjustment_totals on adjustment_totals.budget_cohort_id = cohorts.id
where cohorts.record_origin = 'SYSTEM_NATIVE'
   or (cohorts.record_origin = 'LEGACY_EXCEL' and cohorts.reconciliation_status = 'RECONCILED')
union all
select
  null::uuid as cohort_id,
  entries.id as funding_reference_id,
  entries.region_id,
  entries.project_id,
  entries.origin_fiscal_year,
  entries.amount as initial_allocation,
  null::bigint as verified_cumulative_execution,
  null::bigint as remaining_balance,
  null::numeric as execution_rate,
  'LEGACY_EXCEL'::text as record_origin,
  entries.evidence_id,
  'UNRECONCILED'::text as reconciliation_status,
  ('RECONSTRUCTION_' || entries.status)::text as ledger_state
from public.legacy_ledger_reconstruction_entries as entries
where entries.event_type = 'ALLOCATION'
  and entries.status in ('DRAFT', 'SUBMITTED', 'VERIFIED');

create or replace function public.get_financial_funding_cohort_execution()
returns table (
  cohort_id uuid,
  funding_reference_id uuid,
  region_id uuid,
  project_id uuid,
  origin_fiscal_year integer,
  initial_allocation bigint,
  verified_cumulative_execution bigint,
  remaining_balance bigint,
  execution_rate numeric,
  record_origin text,
  evidence_id uuid,
  reconciliation_status text,
  ledger_state text
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
  select actor_id, actor_role, actor_region_id into v_actor_id, v_role, v_actor_region_id
  from public.financial_require_actor();
  return query
  select summary.cohort_id, summary.funding_reference_id, summary.region_id,
    summary.project_id, summary.origin_fiscal_year, summary.initial_allocation,
    summary.verified_cumulative_execution, summary.remaining_balance,
    summary.execution_rate, summary.record_origin, summary.evidence_id,
    summary.reconciliation_status, summary.ledger_state
  from public.financial_funding_cohort_execution as summary
  where v_role = 'admin' or summary.region_id = v_actor_region_id
  order by summary.origin_fiscal_year, summary.project_id, summary.funding_reference_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. RLS and least-privilege API surface
-- ---------------------------------------------------------------------------

alter table public.financial_ledger_runtime enable row level security;
alter table public.financial_ledger_runtime_events enable row level security;
alter table public.ledger_evidence enable row level security;
alter table public.financial_project_lineages enable row level security;
alter table public.financial_project_lineage_members enable row level security;
alter table public.financial_ledger_change_requests enable row level security;
alter table public.legacy_ledger_reconstruction_entries enable row level security;

create policy financial_ledger_runtime_select_authenticated
  on public.financial_ledger_runtime for select to authenticated using (true);
create policy financial_ledger_runtime_events_select_admin
  on public.financial_ledger_runtime_events for select to authenticated using (
    exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );
create policy ledger_evidence_select_region_or_admin
  on public.ledger_evidence for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = ledger_evidence.region_id))
  );
create policy financial_project_lineages_select_region_or_admin
  on public.financial_project_lineages for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = financial_project_lineages.region_id))
  );
create policy financial_project_lineage_members_select_region_or_admin
  on public.financial_project_lineage_members for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = financial_project_lineage_members.region_id))
  );
create policy financial_ledger_change_requests_select_region_or_admin
  on public.financial_ledger_change_requests for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = financial_ledger_change_requests.region_id))
  );
create policy legacy_ledger_reconstruction_select_region_or_admin
  on public.legacy_ledger_reconstruction_entries for select to authenticated using (
    exists (select 1 from public.profiles
      where id = auth.uid() and (role = 'admin' or region_id = legacy_ledger_reconstruction_entries.region_id))
  );

revoke all on table
  public.project_budget_cohorts, public.project_budget_years,
  public.project_fund_transfers, public.project_execution_records,
  public.project_carryovers, public.project_budget_adjustments,
  public.financial_ledger_cutovers, public.project_financial_baselines,
  public.project_baseline_corrections, public.project_metadata_history,
  public.financial_ledger_runtime, public.financial_ledger_runtime_events,
  public.ledger_evidence, public.financial_project_lineages,
  public.financial_project_lineage_members, public.financial_ledger_change_requests,
  public.legacy_ledger_reconstruction_entries
from public, anon, authenticated;

-- Explicitly call out the dangerous table privileges so a future review cannot
-- mistake an ALL-revoke for only DML. authenticated receives SELECT only below.
revoke insert, update, delete, truncate, references, trigger on table
  public.project_budget_cohorts, public.project_budget_years,
  public.project_fund_transfers, public.project_execution_records,
  public.project_carryovers, public.project_budget_adjustments,
  public.financial_ledger_cutovers, public.project_financial_baselines,
  public.project_baseline_corrections, public.project_metadata_history,
  public.financial_ledger_runtime, public.financial_ledger_runtime_events,
  public.ledger_evidence, public.financial_project_lineages,
  public.financial_project_lineage_members, public.financial_ledger_change_requests,
  public.legacy_ledger_reconstruction_entries
from anon, authenticated;

grant select on table
  public.project_budget_cohorts, public.project_budget_years,
  public.project_fund_transfers, public.project_execution_records,
  public.project_carryovers, public.project_budget_adjustments,
  public.financial_ledger_cutovers, public.project_financial_baselines,
  public.project_baseline_corrections, public.project_metadata_history,
  public.financial_ledger_runtime, public.financial_ledger_runtime_events,
  public.ledger_evidence, public.financial_project_lineages,
  public.financial_project_lineage_members, public.financial_ledger_change_requests,
  public.legacy_ledger_reconstruction_entries
to authenticated;

revoke all on public.financial_funding_cohort_execution from public, anon, authenticated;
grant select on public.financial_funding_cohort_execution to authenticated;

-- Internal helpers/triggers are never API-callable.
revoke all on function public.financial_request_fingerprint(jsonb) from public, anon, authenticated;
revoke all on function public.financial_assert_same_fingerprint(text, text, text) from public, anon, authenticated;
revoke all on function public.financial_prevent_append_only_mutation() from public, anon, authenticated;
revoke all on function public.financial_validate_evidence_mutation() from public, anon, authenticated;
revoke all on function public.financial_validate_project_lineage_member() from public, anon, authenticated;
revoke all on function public.financial_validate_lineage_mutation() from public, anon, authenticated;
revoke all on function public.financial_validate_lineage_member_mutation() from public, anon, authenticated;
revoke all on function public.financial_require_ledger_write(text, date, uuid) from public, anon, authenticated;
revoke all on function public.financial_enforce_ledger_origin() from public, anon, authenticated;
revoke all on function public.financial_validate_legacy_reconstruction_mutation() from public, anon, authenticated;
revoke all on function public.financial_validate_legacy_reconstruction_values(text, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, smallint, bigint, date, smallint, text, text) from public, anon, authenticated;
revoke all on function public.financial_assert_carryover_same_verified_lineage(uuid, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.financial_expected_carryover_sequence(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.financial_validate_wallet_relationship() from public, anon, authenticated;
revoke all on function public.financial_validate_carryover_verified_lineage() from public, anon, authenticated;
revoke all on function public.financial_change_request_region(text, jsonb) from public, anon, authenticated;
revoke all on function public.financial_validate_change_request_payload(text, jsonb) from public, anon, authenticated;
revoke all on function public.financial_validate_change_request_mutation() from public, anon, authenticated;
revoke all on function public.financial_validate_baseline_mutation() from public, anon, authenticated;
revoke all on function public.financial_validate_baseline_correction_mutation() from public, anon, authenticated;
revoke all on function public.financial_resolve_applied_legacy_baseline_wallet(uuid, text, uuid, integer, smallint, bigint, bigint) from public, anon, authenticated;

-- Superseded direct-confirm RPCs lose authenticated access. Their correct
-- accounting helpers remain in place; maker-checker materializers insert into
-- the same immutable Ledger tables.
revoke all on function public.create_carryover(uuid, uuid, bigint, text, date, uuid) from public, anon, authenticated;
revoke all on function public.create_carryover_reversal(uuid, bigint, text, date, uuid) from public, anon, authenticated;
revoke all on function public.create_transfer_reversal(uuid, bigint, text, date, uuid) from public, anon, authenticated;
revoke all on function public.create_execution_reversal(uuid, bigint, text, date, uuid) from public, anon, authenticated;
revoke all on function public.create_budget_adjustment(uuid, text, bigint, text, text, date, uuid) from public, anon, authenticated;
revoke all on function public.create_budget_adjustment_reversal(uuid, bigint, text, date, uuid) from public, anon, authenticated;
revoke all on function public.verify_legacy_carryover_history(uuid, smallint, text) from public, anon, authenticated;

-- Environment binding is a service-role-only action after an external TEST ref
-- comparison. No project ref or mode is changed by this migration itself.
revoke all on function public.financial_bind_test_ledger_environment(text, text) from public, anon, authenticated;
grant execute on function public.financial_bind_test_ledger_environment(text, text) to service_role;

revoke all on function public.financial_set_ledger_mode(text, text) from public, anon;
grant execute on function public.financial_set_ledger_mode(text, text) to authenticated;

revoke all on function public.financial_register_ledger_evidence(uuid, text, text, text, text, text, text, text, text, text, date, uuid, uuid, boolean) from public, anon;
grant execute on function public.financial_register_ledger_evidence(uuid, text, text, text, text, text, text, text, text, text, date, uuid, uuid, boolean) to authenticated;
revoke all on function public.financial_update_ledger_evidence_draft(uuid, text, text, text, text, text, text, text, text, text, date, uuid) from public, anon;
grant execute on function public.financial_update_ledger_evidence_draft(uuid, text, text, text, text, text, text, text, text, text, date, uuid) to authenticated;
revoke all on function public.financial_submit_ledger_evidence(uuid) from public, anon;
grant execute on function public.financial_submit_ledger_evidence(uuid) to authenticated;
revoke all on function public.financial_verify_ledger_evidence(uuid) from public, anon;
grant execute on function public.financial_verify_ledger_evidence(uuid) to authenticated;
revoke all on function public.financial_reject_ledger_evidence(uuid, text) from public, anon;
grant execute on function public.financial_reject_ledger_evidence(uuid, text) to authenticated;

revoke all on function public.financial_create_project_lineage(uuid, text, uuid[], uuid[], uuid, boolean) from public, anon;
grant execute on function public.financial_create_project_lineage(uuid, text, uuid[], uuid[], uuid, boolean) to authenticated;
revoke all on function public.financial_update_project_lineage_draft(uuid, text, uuid[], uuid[]) from public, anon;
grant execute on function public.financial_update_project_lineage_draft(uuid, text, uuid[], uuid[]) to authenticated;
revoke all on function public.financial_submit_project_lineage(uuid) from public, anon;
grant execute on function public.financial_submit_project_lineage(uuid) to authenticated;
revoke all on function public.financial_verify_project_lineage(uuid) from public, anon;
grant execute on function public.financial_verify_project_lineage(uuid) to authenticated;
revoke all on function public.financial_reject_project_lineage(uuid, text) from public, anon;
grant execute on function public.financial_reject_project_lineage(uuid, text) to authenticated;

revoke all on function public.financial_create_legacy_reconstruction_entry(text, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, smallint, bigint, date, smallint, text, text, text, text, uuid) from public, anon;
grant execute on function public.financial_create_legacy_reconstruction_entry(text, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, smallint, bigint, date, smallint, text, text, text, text, uuid) to authenticated;
revoke all on function public.financial_update_legacy_reconstruction_entry(uuid, text, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, smallint, bigint, date, smallint, text, text, text, text) from public, anon;
grant execute on function public.financial_update_legacy_reconstruction_entry(uuid, text, uuid, uuid, uuid, uuid, uuid, integer, integer, integer, smallint, bigint, date, smallint, text, text, text, text) to authenticated;
revoke all on function public.financial_submit_legacy_reconstruction(uuid) from public, anon;
grant execute on function public.financial_submit_legacy_reconstruction(uuid) to authenticated;
revoke all on function public.financial_verify_legacy_reconstruction(uuid) from public, anon;
grant execute on function public.financial_verify_legacy_reconstruction(uuid) to authenticated;
revoke all on function public.financial_reject_legacy_reconstruction(uuid, text) from public, anon;
grant execute on function public.financial_reject_legacy_reconstruction(uuid, text) to authenticated;
revoke all on function public.financial_apply_legacy_reconstruction(uuid) from public, anon;
grant execute on function public.financial_apply_legacy_reconstruction(uuid) to authenticated;

revoke all on function public.create_project_budget_cohort(uuid, integer, bigint, text, text, date, uuid) from public, anon;
grant execute on function public.create_project_budget_cohort(uuid, integer, bigint, text, text, date, uuid) to authenticated;
revoke all on function public.confirm_execution(uuid, bigint, date, text, uuid) from public, anon;
grant execute on function public.confirm_execution(uuid, bigint, date, text, uuid) to authenticated;
revoke all on function public.create_or_submit_transfer(uuid, uuid, bigint, text, text, date, uuid, boolean) from public, anon;
grant execute on function public.create_or_submit_transfer(uuid, uuid, bigint, text, text, date, uuid, boolean) to authenticated;
revoke all on function public.submit_transfer(uuid) from public, anon;
grant execute on function public.submit_transfer(uuid) to authenticated;
revoke all on function public.approve_transfer(uuid, text) from public, anon;
grant execute on function public.approve_transfer(uuid, text) to authenticated;
revoke all on function public.reject_transfer(uuid, text) from public, anon;
grant execute on function public.reject_transfer(uuid, text) to authenticated;
revoke all on function public.withdraw_transfer(uuid, text) from public, anon;
grant execute on function public.withdraw_transfer(uuid, text) to authenticated;

revoke all on function public.financial_create_ledger_change_request(text, jsonb, uuid, boolean) from public, anon;
grant execute on function public.financial_create_ledger_change_request(text, jsonb, uuid, boolean) to authenticated;
revoke all on function public.financial_submit_ledger_change_request(uuid) from public, anon;
grant execute on function public.financial_submit_ledger_change_request(uuid) to authenticated;
revoke all on function public.financial_approve_ledger_change_request(uuid) from public, anon;
grant execute on function public.financial_approve_ledger_change_request(uuid) to authenticated;
revoke all on function public.financial_reject_ledger_change_request(uuid, text) from public, anon;
grant execute on function public.financial_reject_ledger_change_request(uuid, text) to authenticated;
revoke all on function public.financial_apply_ledger_change_request(uuid) from public, anon;
grant execute on function public.financial_apply_ledger_change_request(uuid) to authenticated;

revoke all on function public.financial_create_ledger_cutover(date, text) from public, anon;
grant execute on function public.financial_create_ledger_cutover(date, text) to authenticated;
revoke all on function public.financial_prepare_legacy_baselines(uuid) from public, anon;
grant execute on function public.financial_prepare_legacy_baselines(uuid) to authenticated;
revoke all on function public.financial_review_legacy_baseline(uuid, text, text, uuid, uuid, integer, smallint) from public, anon;
grant execute on function public.financial_review_legacy_baseline(uuid, text, text, uuid, uuid, integer, smallint) to authenticated;
revoke all on function public.financial_verify_reconciled_legacy_baselines(uuid) from public, anon;
grant execute on function public.financial_verify_reconciled_legacy_baselines(uuid) to authenticated;
revoke all on function public.financial_confirm_ledger_cutover(uuid) from public, anon;
grant execute on function public.financial_confirm_ledger_cutover(uuid) to authenticated;
revoke all on function public.financial_request_baseline_correction(uuid, jsonb, text, date, date, uuid) from public, anon;
grant execute on function public.financial_request_baseline_correction(uuid, jsonb, text, date, date, uuid) to authenticated;
revoke all on function public.financial_submit_baseline_correction(uuid) from public, anon;
grant execute on function public.financial_submit_baseline_correction(uuid) to authenticated;
revoke all on function public.financial_approve_baseline_correction(uuid) from public, anon;
grant execute on function public.financial_approve_baseline_correction(uuid) to authenticated;
revoke all on function public.financial_reject_baseline_correction(uuid, text) from public, anon;
grant execute on function public.financial_reject_baseline_correction(uuid, text) to authenticated;
revoke all on function public.financial_apply_baseline_correction(uuid) from public, anon;
grant execute on function public.financial_apply_baseline_correction(uuid) to authenticated;
revoke all on function public.get_financial_funding_cohort_execution() from public, anon;
grant execute on function public.get_financial_funding_cohort_execution() to authenticated;

-- The migration must end exactly where it began operationally: no binding and
-- no mode activation. This assertion fails the transaction if that ever drifts.
do $$
begin
  if not exists (
    select 1 from public.financial_ledger_runtime
    where singleton = true and environment_kind = 'UNBOUND' and mode = 'DISABLED'
      and bound_project_ref is null and baseline_as_of = date '2026-08-31'
      and native_start_date = date '2026-09-01'
  ) then
    raise exception using errcode = '55000', message =
      'Ledger policy delta must finish UNBOUND / DISABLED.';
  end if;
  if exists (select 1 from public.project_budget_cohorts)
     or exists (select 1 from public.project_budget_years)
     or exists (select 1 from public.project_fund_transfers)
     or exists (select 1 from public.project_execution_records)
     or exists (select 1 from public.project_carryovers)
     or exists (select 1 from public.project_budget_adjustments)
     or exists (select 1 from public.financial_ledger_cutovers)
     or exists (select 1 from public.project_financial_baselines)
     or exists (select 1 from public.project_baseline_corrections)
     or exists (select 1 from public.ledger_evidence)
     or exists (select 1 from public.financial_ledger_runtime_events)
     or exists (select 1 from public.financial_ledger_change_requests)
     or exists (select 1 from public.legacy_ledger_reconstruction_entries)
     or exists (select 1 from public.financial_project_lineages) then
    raise exception using errcode = '55000', message =
      'Ledger policy delta must not auto-create transactions, Baselines, reconstruction, or lineages.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
