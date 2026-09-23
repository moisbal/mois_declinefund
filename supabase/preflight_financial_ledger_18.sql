-- READ-ONLY PREFLIGHT — run this manually immediately before
-- 20260819_18_add_financial_ledger.sql.
--
-- This script intentionally contains no DDL or DML.  SELECT statements report
-- the current state; anonymous DO blocks only read catalog/data metadata and
-- raise an exception when a mandatory precondition is not satisfied.
-- It is for the current production-like database, not for bootstrapping a
-- clean database from this repository's historical migrations.

select
  clock_timestamp() as checked_at,
  current_database() as database_name,
  current_user as database_user,
  'preflight_financial_ledger_18'::text as preflight_name;

-- Type inventory for every existing column that migration 18 reads directly
-- or writes through financial_write_audit().  text_family accepts text,
-- varchar, and char; timestamp_family accepts timestamp or timestamptz.
with expected(schema_name, table_name, column_name, expected_type) as (
  values
    ('public', 'projects', 'id', 'uuid'),
    ('public', 'projects', 'region_id', 'uuid'),
    ('public', 'projects', 'year', 'integer'),
    ('public', 'projects', 'project_code', 'text_family'),
    ('public', 'projects', 'project_name', 'text_family'),
    ('public', 'projects', 'fund_project_name', 'text_family'),
    ('public', 'projects', 'detail_project_name', 'text_family'),
    ('public', 'projects', 'sido', 'text_family'),
    ('public', 'projects', 'sigungu', 'text_family'),
    ('public', 'projects', 'alloc', 'bigint'),
    ('public', 'projects', 'exec', 'bigint'),
    ('public', 'projects', 'rate', 'numeric'),
    ('public', 'projects', 'original_alloc', 'bigint'),
    ('public', 'projects', 'increase_amount', 'bigint'),
    ('public', 'projects', 'decrease_amount', 'bigint'),
    ('public', 'profiles', 'id', 'uuid'),
    ('public', 'profiles', 'region_id', 'uuid'),
    ('public', 'profiles', 'role', 'text_family'),
    ('public', 'regions', 'id', 'uuid'),
    ('public', 'audit_logs', 'project_id', 'uuid'),
    ('public', 'audit_logs', 'region_id', 'text_family'),
    ('public', 'audit_logs', 'changed_by', 'uuid'),
    ('public', 'audit_logs', 'action', 'text_family'),
    ('public', 'audit_logs', 'field_name', 'text_family'),
    ('public', 'audit_logs', 'old_value', 'text_family'),
    ('public', 'audit_logs', 'new_value', 'text_family'),
    ('public', 'audit_logs', 'changed_at', 'timestamp_family'),
    ('public', 'audit_logs', 'created_at', 'timestamp_family'),
    ('public', 'audit_logs', 'updated_at', 'timestamp_family')
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
    when expected_type = 'bigint' and actual_typname = 'int8' then 'PASS'
    when expected_type = 'numeric' and actual_typname = 'numeric' then 'PASS'
    when expected_type = 'text_family' and actual_typname in ('text', 'varchar', 'bpchar') then 'PASS'
    when expected_type = 'timestamp_family' and actual_typname in ('timestamp', 'timestamptz') then 'PASS'
    else 'FAIL: incompatible type'
  end as status
from actual
order by object_name;

-- The extension/function and Supabase auth helper are also direct dependencies.
select
  dependency,
  case when present then 'PASS' else 'FAIL: missing' end as status
from (
  values
    ('gen_random_uuid()', to_regprocedure('gen_random_uuid()') is not null),
    ('auth.uid()', to_regprocedure('auth.uid()') is not null)
) as dependencies(dependency, present)
order by dependency;

-- Stop before migration 18 if any required object is absent or incompatible.
do $$
declare
  expected record;
  actual_typname text;
  type_matches boolean;
begin
  for expected in
    select * from (values
      ('public', 'projects', 'id', 'uuid'),
      ('public', 'projects', 'region_id', 'uuid'),
      ('public', 'projects', 'year', 'integer'),
      ('public', 'projects', 'project_code', 'text_family'),
      ('public', 'projects', 'project_name', 'text_family'),
      ('public', 'projects', 'fund_project_name', 'text_family'),
      ('public', 'projects', 'detail_project_name', 'text_family'),
      ('public', 'projects', 'sido', 'text_family'),
      ('public', 'projects', 'sigungu', 'text_family'),
      ('public', 'projects', 'alloc', 'bigint'),
      ('public', 'projects', 'exec', 'bigint'),
      ('public', 'projects', 'rate', 'numeric'),
      ('public', 'projects', 'original_alloc', 'bigint'),
      ('public', 'projects', 'increase_amount', 'bigint'),
      ('public', 'projects', 'decrease_amount', 'bigint'),
      ('public', 'profiles', 'id', 'uuid'),
      ('public', 'profiles', 'region_id', 'uuid'),
      ('public', 'profiles', 'role', 'text_family'),
      ('public', 'regions', 'id', 'uuid'),
      ('public', 'audit_logs', 'project_id', 'uuid'),
      ('public', 'audit_logs', 'region_id', 'text_family'),
      ('public', 'audit_logs', 'changed_by', 'uuid'),
      ('public', 'audit_logs', 'action', 'text_family'),
      ('public', 'audit_logs', 'field_name', 'text_family'),
      ('public', 'audit_logs', 'old_value', 'text_family'),
      ('public', 'audit_logs', 'new_value', 'text_family'),
      ('public', 'audit_logs', 'changed_at', 'timestamp_family'),
      ('public', 'audit_logs', 'created_at', 'timestamp_family'),
      ('public', 'audit_logs', 'updated_at', 'timestamp_family')
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
      when 'bigint' then actual_typname = 'int8'
      when 'numeric' then actual_typname = 'numeric'
      when 'text_family' then actual_typname in ('text', 'varchar', 'bpchar')
      when 'timestamp_family' then actual_typname in ('timestamp', 'timestamptz')
      else false
    end;

    if actual_typname is null or not type_matches then
      raise exception using
        errcode = '55000',
        message = format(
          '18 preflight FAILED: %I.%I.%I must be %s (actual internal type: %s).',
          expected.schema_name, expected.table_name, expected.column_name,
          expected.expected_type, coalesce(actual_typname, '<missing>')
        );
    end if;
  end loop;

  if to_regprocedure('gen_random_uuid()') is null
     or to_regprocedure('auth.uid()') is null then
    raise exception using errcode = '55000',
      message = '18 preflight FAILED: gen_random_uuid() 또는 auth.uid() 의존 함수를 찾을 수 없습니다.';
  end if;
end;
$$;

-- Current Legacy source diagnostics. project_code is a reporting signal only;
-- this query does not define a permanent "official project" rule.
select
  count(*)::bigint as total_projects,
  count(*) filter (where project_code is not null)::bigint as project_code_present,
  count(*) filter (where alloc is null)::bigint as alloc_null,
  count(*) filter (where exec is null)::bigint as exec_null,
  count(*) filter (where original_alloc is null)::bigint as original_alloc_null,
  count(*) filter (where alloc = 0)::bigint as alloc_zero,
  count(*) filter (where exec > alloc)::bigint as exec_gt_alloc
from public.projects;

-- Migration 18 is first-apply only. create table if not exists would otherwise
-- hide a prior/partial ledger deployment, so any existing relation is a stop.
with expected_ledger_tables(table_name) as (
  values
    ('project_budget_cohorts'),
    ('project_budget_years'),
    ('project_fund_transfers'),
    ('project_execution_records'),
    ('project_carryovers'),
    ('project_budget_adjustments')
)
select
  table_name,
  case
    when to_regclass('public.' || table_name) is null then 'PASS: absent as expected for first apply'
    else 'FAIL: unexpected existing relation — do not run migration 18'
  end as status
from expected_ledger_tables
order by table_name;

do $$
declare
  existing_relations text[];
begin
  select array_agg(relations.relname order by relations.relname)
    into existing_relations
  from pg_class as relations
  join pg_namespace as namespaces on namespaces.oid = relations.relnamespace
  where namespaces.nspname = 'public'
    and relations.relkind in ('r', 'p', 'v', 'm', 'f')
    and relations.relname in (
      'project_budget_cohorts',
      'project_budget_years',
      'project_fund_transfers',
      'project_execution_records',
      'project_carryovers',
      'project_budget_adjustments'
    );

  if existing_relations is not null then
    raise exception using
      errcode = '55000',
      message = format(
        '18 preflight STOP: Ledger first-apply 환경이 아닙니다. 기존 객체: %s',
        array_to_string(existing_relations, ', ')
      );
  end if;
end;
$$;

select 'PASS: migration 18 preflight completed; do not treat this as migration execution.'::text as result;
