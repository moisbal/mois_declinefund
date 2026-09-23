-- READ-ONLY PREFLIGHT — run this manually only AFTER migration 18 succeeds and
-- immediately BEFORE 20260819_19_add_legacy_baseline_cutover.sql.
--
-- This script intentionally contains no DDL or DML. SELECT statements report
-- state; anonymous DO blocks only read catalog/data metadata and raise an
-- exception for an unsafe condition. It never derives an effective date or
-- repairs existing Ledger data.

select
  clock_timestamp() as checked_at,
  current_database() as database_name,
  current_user as database_user,
  'preflight_legacy_cutover_19'::text as preflight_name;

-- Migration 19 requires the six Ledger relations created by migration 18, plus
-- the two classification relations that receive post-cutover history triggers.
with expected_relations(relation_name) as (
  values
    ('project_budget_cohorts'),
    ('project_budget_years'),
    ('project_fund_transfers'),
    ('project_execution_records'),
    ('project_carryovers'),
    ('project_budget_adjustments'),
    ('project_small_categories'),
    ('project_custom_small_categories')
)
select
  relation_name,
  case when to_regclass('public.' || relation_name) is not null then 'PASS' else 'FAIL: missing' end as status
from expected_relations
order by relation_name;

-- Exact 18-era shape required by migration 19. text_family accepts text,
-- varchar, and char; timestamp_family accepts timestamp or timestamptz.
with expected(schema_name, table_name, column_name, expected_type) as (
  values
    ('public', 'projects', 'id', 'uuid'),
    ('public', 'projects', 'project_id', 'text_family'),
    ('public', 'projects', 'project_code', 'text_family'),
    ('public', 'projects', 'region_id', 'uuid'),
    ('public', 'projects', 'year', 'integer'),
    ('public', 'projects', 'alloc', 'bigint'),
    ('public', 'projects', 'exec', 'bigint'),
    ('public', 'projects', 'rate', 'numeric'),
    ('public', 'projects', 'original_alloc', 'bigint'),
    ('public', 'projects', 'increase_amount', 'bigint'),
    ('public', 'projects', 'decrease_amount', 'bigint'),
    ('public', 'projects', 'status', 'text_family'),
    ('public', 'projects', 'large_category_id', 'uuid'),
    ('public', 'projects', 'middle_category_id', 'uuid'),
    ('public', 'projects', 'business_type', 'text_family'),
    ('public', 'projects', 'project_name', 'text_family'),
    ('public', 'projects', 'fund_project_name', 'text_family'),
    ('public', 'projects', 'detail_project_name', 'text_family'),
    ('public', 'projects', 'sido', 'text_family'),
    ('public', 'projects', 'sigungu', 'text_family'),
    ('public', 'projects', 'region_type', 'text_family'),
    ('public', 'profiles', 'id', 'uuid'),
    ('public', 'profiles', 'region_id', 'uuid'),
    ('public', 'profiles', 'role', 'text_family'),
    ('public', 'audit_logs', 'project_id', 'uuid'),
    ('public', 'audit_logs', 'region_id', 'text_family'),
    ('public', 'audit_logs', 'changed_by', 'uuid'),
    ('public', 'audit_logs', 'action', 'text_family'),
    ('public', 'audit_logs', 'field_name', 'text_family'),
    ('public', 'audit_logs', 'old_value', 'text_family'),
    ('public', 'audit_logs', 'new_value', 'text_family'),
    ('public', 'audit_logs', 'changed_at', 'timestamp_family'),
    ('public', 'audit_logs', 'created_at', 'timestamp_family'),
    ('public', 'audit_logs', 'updated_at', 'timestamp_family'),
    ('public', 'project_budget_cohorts', 'id', 'uuid'),
    ('public', 'project_budget_cohorts', 'origin_project_id', 'uuid'),
    ('public', 'project_budget_cohorts', 'origin_fiscal_year', 'integer'),
    ('public', 'project_budget_cohorts', 'initial_allocation', 'bigint'),
    ('public', 'project_budget_cohorts', 'allocation_type', 'text_family'),
    ('public', 'project_budget_years', 'id', 'uuid'),
    ('public', 'project_budget_years', 'project_id', 'uuid'),
    ('public', 'project_budget_years', 'budget_cohort_id', 'uuid'),
    ('public', 'project_budget_years', 'fiscal_year', 'integer'),
    ('public', 'project_fund_transfers', 'id', 'uuid'),
    ('public', 'project_fund_transfers', 'source_budget_year_id', 'uuid'),
    ('public', 'project_fund_transfers', 'destination_budget_year_id', 'uuid'),
    ('public', 'project_fund_transfers', 'amount', 'bigint'),
    ('public', 'project_fund_transfers', 'effective_date', 'date'),
    ('public', 'project_execution_records', 'id', 'uuid'),
    ('public', 'project_execution_records', 'budget_year_id', 'uuid'),
    ('public', 'project_execution_records', 'amount', 'bigint'),
    ('public', 'project_execution_records', 'execution_date', 'date'),
    ('public', 'project_carryovers', 'id', 'uuid'),
    ('public', 'project_carryovers', 'source_budget_year_id', 'uuid'),
    ('public', 'project_carryovers', 'destination_budget_year_id', 'uuid'),
    ('public', 'project_carryovers', 'amount', 'bigint'),
    ('public', 'project_carryovers', 'carryover_sequence', 'smallint'),
    ('public', 'project_carryovers', 'carryover_type', 'text_family'),
    ('public', 'project_carryovers', 'status', 'text_family'),
    ('public', 'project_carryovers', 'transaction_kind', 'text_family'),
    ('public', 'project_budget_adjustments', 'id', 'uuid'),
    ('public', 'project_budget_adjustments', 'budget_year_id', 'uuid'),
    ('public', 'project_budget_adjustments', 'adjustment_type', 'text_family'),
    ('public', 'project_budget_adjustments', 'amount', 'bigint'),
    ('public', 'project_budget_adjustments', 'effective_date', 'date'),
    ('public', 'project_small_categories', 'id', 'uuid'),
    ('public', 'project_small_categories', 'project_id', 'uuid'),
    ('public', 'project_small_categories', 'small_category_id', 'uuid'),
    ('public', 'project_custom_small_categories', 'id', 'uuid'),
    ('public', 'project_custom_small_categories', 'project_id', 'uuid'),
    ('public', 'project_custom_small_categories', 'input_value', 'text_family'),
    ('public', 'project_custom_small_categories', 'validation_status', 'text_family')
), actual as (
  select
    expected.*,
    format_type(attributes.atttypid, attributes.atttypmod) as actual_type,
    types.typname as actual_typname
  from expected
  left join pg_namespace as namespaces on namespaces.nspname = expected.schema_name
  left join pg_class as relations
    on relations.relnamespace = namespaces.oid
   and relations.relname = expected.table_name
   and relations.relkind in ('r', 'p')
  left join pg_attribute as attributes
    on attributes.attrelid = relations.oid
   and attributes.attname = expected.column_name
   and attributes.attnum > 0
   and not attributes.attisdropped
  left join pg_type as types on types.oid = attributes.atttypid
)
select
  schema_name || '.' || table_name || '.' || column_name as object_name,
  expected_type,
  coalesce(actual_type, '<missing>') as actual_type,
  case
    when actual_typname is null then 'FAIL: missing'
    when expected_type = 'uuid' and actual_typname = 'uuid' then 'PASS'
    when expected_type = 'integer' and actual_typname = 'int4' then 'PASS'
    when expected_type = 'smallint' and actual_typname = 'int2' then 'PASS'
    when expected_type = 'bigint' and actual_typname = 'int8' then 'PASS'
    when expected_type = 'numeric' and actual_typname = 'numeric' then 'PASS'
    when expected_type = 'date' and actual_typname = 'date' then 'PASS'
    when expected_type = 'text_family' and actual_typname in ('text', 'varchar', 'bpchar') then 'PASS'
    when expected_type = 'timestamp_family' and actual_typname in ('timestamp', 'timestamptz') then 'PASS'
    else 'FAIL: incompatible type'
  end as status
from actual
order by object_name;

-- These signatures identify the 18 implementation that 19 replaces or calls.
with required_functions(function_identity) as (
  values
    ('public.financial_require_actor()'),
    ('public.financial_validate_budget_year_location()'),
    ('public.financial_validate_wallet_relationship()'),
    ('public.financial_prevent_confirmed_mutation()'),
    ('public.financial_prevent_location_mutation()'),
    ('public.financial_prevent_legacy_budget_mutation()'),
    ('public.financial_get_or_create_budget_year(uuid,uuid,integer,uuid)'),
    ('public.financial_write_audit(uuid,uuid,text,text,uuid,uuid,jsonb)'),
    ('public.financial_get_budget_year_balance(uuid)'),
    ('public.financial_require_available_amount(uuid,bigint,text)'),
    ('public.create_execution_reversal(uuid,bigint,text,uuid)'),
    ('public.create_budget_adjustment_reversal(uuid,bigint,text,uuid)'),
    ('public.create_carryover(uuid,uuid,bigint,text,uuid)'),
    ('public.create_carryover_reversal(uuid,bigint,text,uuid)')
)
select
  function_identity,
  case when to_regprocedure(function_identity) is not null then 'PASS' else 'FAIL: missing signature' end as status
from required_functions
order by function_identity;

-- None of these 19 artifacts may pre-exist. Their presence means a partial or
-- prior 19 deployment; do not replay this migration over that state.
with artifacts(object_name, present) as (
  values
    ('public.financial_ledger_cutovers', to_regclass('public.financial_ledger_cutovers') is not null),
    ('public.project_financial_baselines', to_regclass('public.project_financial_baselines') is not null),
    ('public.project_baseline_corrections', to_regclass('public.project_baseline_corrections') is not null),
    ('public.project_metadata_history', to_regclass('public.project_metadata_history') is not null),
    ('public.project_budget_cohorts.source_type', exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_budget_cohorts' and column_name = 'source_type'
    )),
    ('public.project_budget_cohorts.legacy_carryover_status', exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_budget_cohorts' and column_name = 'legacy_carryover_status'
    )),
    ('public.project_budget_years.legacy_baseline_id', exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_budget_years' and column_name = 'legacy_baseline_id'
    )),
    ('public.project_carryovers.effective_date', exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_carryovers' and column_name = 'effective_date'
    ))
)
select
  object_name,
  case when present then 'FAIL: unexpected 19 artifact' else 'PASS: absent before first 19 apply' end as status
from artifacts
order by object_name;

-- Stop when the expected 18 schema/functions are incomplete or incompatible.
do $$
declare
  expected record;
  actual_typname text;
  type_matches boolean;
  function_identity text;
begin
  for expected in
    select * from (values
      ('public', 'projects', 'id', 'uuid'),
      ('public', 'projects', 'project_id', 'text_family'),
      ('public', 'projects', 'project_code', 'text_family'),
      ('public', 'projects', 'region_id', 'uuid'),
      ('public', 'projects', 'year', 'integer'),
      ('public', 'projects', 'alloc', 'bigint'),
      ('public', 'projects', 'exec', 'bigint'),
      ('public', 'projects', 'rate', 'numeric'),
      ('public', 'projects', 'original_alloc', 'bigint'),
      ('public', 'projects', 'increase_amount', 'bigint'),
      ('public', 'projects', 'decrease_amount', 'bigint'),
      ('public', 'projects', 'status', 'text_family'),
      ('public', 'projects', 'large_category_id', 'uuid'),
      ('public', 'projects', 'middle_category_id', 'uuid'),
      ('public', 'projects', 'business_type', 'text_family'),
      ('public', 'projects', 'project_name', 'text_family'),
      ('public', 'projects', 'fund_project_name', 'text_family'),
      ('public', 'projects', 'detail_project_name', 'text_family'),
      ('public', 'projects', 'sido', 'text_family'),
      ('public', 'projects', 'sigungu', 'text_family'),
      ('public', 'projects', 'region_type', 'text_family'),
      ('public', 'profiles', 'id', 'uuid'),
      ('public', 'profiles', 'region_id', 'uuid'),
      ('public', 'profiles', 'role', 'text_family'),
      ('public', 'audit_logs', 'project_id', 'uuid'),
      ('public', 'audit_logs', 'region_id', 'text_family'),
      ('public', 'audit_logs', 'changed_by', 'uuid'),
      ('public', 'audit_logs', 'action', 'text_family'),
      ('public', 'audit_logs', 'field_name', 'text_family'),
      ('public', 'audit_logs', 'old_value', 'text_family'),
      ('public', 'audit_logs', 'new_value', 'text_family'),
      ('public', 'audit_logs', 'changed_at', 'timestamp_family'),
      ('public', 'audit_logs', 'created_at', 'timestamp_family'),
      ('public', 'audit_logs', 'updated_at', 'timestamp_family'),
      ('public', 'project_budget_cohorts', 'id', 'uuid'),
      ('public', 'project_budget_cohorts', 'origin_project_id', 'uuid'),
      ('public', 'project_budget_cohorts', 'origin_fiscal_year', 'integer'),
      ('public', 'project_budget_cohorts', 'initial_allocation', 'bigint'),
      ('public', 'project_budget_cohorts', 'allocation_type', 'text_family'),
      ('public', 'project_budget_years', 'id', 'uuid'),
      ('public', 'project_budget_years', 'project_id', 'uuid'),
      ('public', 'project_budget_years', 'budget_cohort_id', 'uuid'),
      ('public', 'project_budget_years', 'fiscal_year', 'integer'),
      ('public', 'project_fund_transfers', 'id', 'uuid'),
      ('public', 'project_fund_transfers', 'source_budget_year_id', 'uuid'),
      ('public', 'project_fund_transfers', 'destination_budget_year_id', 'uuid'),
      ('public', 'project_fund_transfers', 'amount', 'bigint'),
      ('public', 'project_fund_transfers', 'effective_date', 'date'),
      ('public', 'project_execution_records', 'id', 'uuid'),
      ('public', 'project_execution_records', 'budget_year_id', 'uuid'),
      ('public', 'project_execution_records', 'amount', 'bigint'),
      ('public', 'project_execution_records', 'execution_date', 'date'),
      ('public', 'project_carryovers', 'id', 'uuid'),
      ('public', 'project_carryovers', 'source_budget_year_id', 'uuid'),
      ('public', 'project_carryovers', 'destination_budget_year_id', 'uuid'),
      ('public', 'project_carryovers', 'amount', 'bigint'),
      ('public', 'project_carryovers', 'carryover_sequence', 'smallint'),
      ('public', 'project_carryovers', 'carryover_type', 'text_family'),
      ('public', 'project_carryovers', 'status', 'text_family'),
      ('public', 'project_carryovers', 'transaction_kind', 'text_family'),
      ('public', 'project_budget_adjustments', 'id', 'uuid'),
      ('public', 'project_budget_adjustments', 'budget_year_id', 'uuid'),
      ('public', 'project_budget_adjustments', 'adjustment_type', 'text_family'),
      ('public', 'project_budget_adjustments', 'amount', 'bigint'),
      ('public', 'project_budget_adjustments', 'effective_date', 'date'),
      ('public', 'project_small_categories', 'id', 'uuid'),
      ('public', 'project_small_categories', 'project_id', 'uuid'),
      ('public', 'project_small_categories', 'small_category_id', 'uuid'),
      ('public', 'project_custom_small_categories', 'id', 'uuid'),
      ('public', 'project_custom_small_categories', 'project_id', 'uuid'),
      ('public', 'project_custom_small_categories', 'input_value', 'text_family'),
      ('public', 'project_custom_small_categories', 'validation_status', 'text_family')
    ) as requirements(schema_name, table_name, column_name, expected_type)
  loop
    select types.typname into actual_typname
    from pg_namespace as namespaces
    join pg_class as relations
      on relations.relnamespace = namespaces.oid
     and relations.relname = expected.table_name
     and relations.relkind in ('r', 'p')
    join pg_attribute as attributes
      on attributes.attrelid = relations.oid
     and attributes.attname = expected.column_name
     and attributes.attnum > 0
     and not attributes.attisdropped
    join pg_type as types on types.oid = attributes.atttypid
    where namespaces.nspname = expected.schema_name;

    type_matches := case expected.expected_type
      when 'uuid' then actual_typname = 'uuid'
      when 'integer' then actual_typname = 'int4'
      when 'smallint' then actual_typname = 'int2'
      when 'bigint' then actual_typname = 'int8'
      when 'numeric' then actual_typname = 'numeric'
      when 'date' then actual_typname = 'date'
      when 'text_family' then actual_typname in ('text', 'varchar', 'bpchar')
      when 'timestamp_family' then actual_typname in ('timestamp', 'timestamptz')
      else false
    end;

    if actual_typname is null or not type_matches then
      raise exception using
        errcode = '55000',
        message = format(
          '19 preflight FAILED: %I.%I.%I must be %s (actual internal type: %s).',
          expected.schema_name, expected.table_name, expected.column_name,
          expected.expected_type, coalesce(actual_typname, '<missing>')
        );
    end if;
  end loop;

  foreach function_identity in array array[
    'public.financial_require_actor()',
    'public.financial_validate_budget_year_location()',
    'public.financial_validate_wallet_relationship()',
    'public.financial_prevent_confirmed_mutation()',
    'public.financial_prevent_location_mutation()',
    'public.financial_prevent_legacy_budget_mutation()',
    'public.financial_get_or_create_budget_year(uuid,uuid,integer,uuid)',
    'public.financial_write_audit(uuid,uuid,text,text,uuid,uuid,jsonb)',
    'public.financial_get_budget_year_balance(uuid)',
    'public.financial_require_available_amount(uuid,bigint,text)',
    'public.create_execution_reversal(uuid,bigint,text,uuid)',
    'public.create_budget_adjustment_reversal(uuid,bigint,text,uuid)',
    'public.create_carryover(uuid,uuid,bigint,text,uuid)',
    'public.create_carryover_reversal(uuid,bigint,text,uuid)'
  ] loop
    if to_regprocedure(function_identity) is null then
      raise exception using errcode = '55000',
        message = format('19 preflight FAILED: migration 18 function signature is missing: %s', function_identity);
    end if;
  end loop;
end;
$$;

-- Existing Ledger rows are operational evidence. No date is inferred here.
select 'project_budget_cohorts'::text as ledger_table, count(*)::bigint as row_count from public.project_budget_cohorts
union all select 'project_budget_years', count(*)::bigint from public.project_budget_years
union all select 'project_fund_transfers', count(*)::bigint from public.project_fund_transfers
union all select 'project_execution_records', count(*)::bigint from public.project_execution_records
union all select 'project_carryovers', count(*)::bigint from public.project_carryovers
union all select 'project_budget_adjustments', count(*)::bigint from public.project_budget_adjustments
order by ledger_table;

-- The expected 18-era carryover table has no effective_date. Its early presence
-- indicates a partial/prior 19 deployment and is therefore a stop condition.
select
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_carryovers' and column_name = 'effective_date'
  ) then 'FAIL: effective_date already exists; investigate partial/prior migration 19 state'
  else 'PASS: effective_date is absent and can be introduced by migration 19'
  end as project_carryovers_effective_date_status;

-- Migration 19 must not be replayed over a partially created 19 state. A
-- pre-existing carryover also stops execution because no effective date may be
-- guessed. Other Ledger row counts produce a warning rather than a mutation.
do $$
declare
  partial_artifacts text[];
  carryover_count bigint;
  transfer_count bigint;
  execution_count bigint;
  adjustment_count bigint;
begin
  select array_agg(object_name order by object_name) into partial_artifacts
  from (
    select 'public.financial_ledger_cutovers'::text as object_name where to_regclass('public.financial_ledger_cutovers') is not null
    union all select 'public.project_financial_baselines' where to_regclass('public.project_financial_baselines') is not null
    union all select 'public.project_baseline_corrections' where to_regclass('public.project_baseline_corrections') is not null
    union all select 'public.project_metadata_history' where to_regclass('public.project_metadata_history') is not null
    union all select 'public.project_budget_cohorts.source_type' where exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_budget_cohorts' and column_name = 'source_type'
    )
    union all select 'public.project_budget_cohorts.legacy_carryover_status' where exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_budget_cohorts' and column_name = 'legacy_carryover_status'
    )
    union all select 'public.project_budget_years.legacy_baseline_id' where exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_budget_years' and column_name = 'legacy_baseline_id'
    )
    union all select 'public.project_carryovers.effective_date' where exists (
      select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_carryovers' and column_name = 'effective_date'
    )
  ) as artifacts;
  if partial_artifacts is not null then
    raise exception using errcode = '55000', message = format(
      '19 preflight STOP: partial/prior migration 19 artifacts exist: %s',
      array_to_string(partial_artifacts, ', ')
    );
  end if;

  select count(*) into carryover_count from public.project_carryovers;
  if carryover_count > 0 then
    raise exception using errcode = '55000', message = format(
      '19 preflight STOP: project_carryovers has %s row(s). Do not infer effective_date; review and resolve the historical rows before migration 19.',
      carryover_count
    );
  end if;

  select count(*) into transfer_count from public.project_fund_transfers;
  select count(*) into execution_count from public.project_execution_records;
  select count(*) into adjustment_count from public.project_budget_adjustments;
  if transfer_count > 0 or execution_count > 0 or adjustment_count > 0 then
    raise warning using message = format(
      '19 preflight WARNING: Ledger activity exists before cutover (transfers=%s, executions=%s, adjustments=%s, carryovers=%s). Confirm this is intentional before applying migration 19.',
      transfer_count, execution_count, adjustment_count, carryover_count
    );
  end if;
end;
$$;

select 'PASS: migration 19 preflight completed; do not treat this as migration execution.'::text as result;
