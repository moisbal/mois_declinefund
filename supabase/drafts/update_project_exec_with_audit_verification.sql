-- READ-ONLY VERIFICATION DRAFT.
-- These statements inspect metadata/data only. They do not invoke the mutating RPC.

-- 1. Confirm the helper function signatures and security settings.
select
  n.nspname as function_schema,
  p.proname as function_name,
  p.oid::regprocedure::text as signature,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  p.proconfig as runtime_configuration,
  pg_get_userbyid(p.proowner) as owner_name
from pg_catalog.pg_proc as p
join pg_catalog.pg_namespace as n
  on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'current_user_role',
    'current_user_region_id',
    'update_project_exec_with_audit'
  )
order by p.proname, signature;

-- 2. Confirm the project columns used by the RPC.
select
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
from information_schema.columns as c
where c.table_schema = 'public'
  and c.table_name = 'projects'
  and c.column_name in (
    'id',
    'project_code',
    'region_id',
    'alloc',
    'exec',
    'rate',
    'updated_at'
  )
order by c.ordinal_position;

-- 3. Confirm audit columns, including optional legacy/compatibility columns.
-- If user_id, old_data, or new_data exists and is NOT NULL without a default,
-- the RPC draft must be revised before it is executed.
with expected_columns(column_name) as (
  values
    ('project_id'),
    ('region_id'),
    ('changed_by'),
    ('user_id'),
    ('action'),
    ('field_name'),
    ('old_value'),
    ('new_value'),
    ('old_data'),
    ('new_data'),
    ('changed_at'),
    ('created_at'),
    ('updated_at')
)
select
  e.column_name,
  (c.column_name is not null) as column_exists,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
from expected_columns as e
left join information_schema.columns as c
  on c.table_schema = 'public'
 and c.table_name = 'audit_logs'
 and c.column_name = e.column_name
order by e.column_name;

-- 4. Confirm FK relationships used by the RPC.
select
  tbl.relname as table_name,
  con.conname as constraint_name,
  pg_get_constraintdef(con.oid, true) as constraint_definition
from pg_catalog.pg_constraint as con
join pg_catalog.pg_class as tbl
  on tbl.oid = con.conrelid
join pg_catalog.pg_namespace as ns
  on ns.oid = tbl.relnamespace
where ns.nspname = 'public'
  and tbl.relname in ('projects', 'profiles', 'audit_logs')
  and con.contype in ('p', 'f', 'u', 'c')
order by tbl.relname, con.conname;

-- 5. Select candidate rows for later approved role-based tests.
-- This does not update a project or insert an audit log.
select
  p.id,
  p.project_code,
  p.region_id,
  p.alloc,
  p.exec,
  p.rate,
  p.updated_at
from public.projects as p
where p.project_code is not null
  and p.alloc is not null
order by p.project_code
limit 20;

-- 6. Inspect the RPC execute privileges after a future approved installation.
select
  r.routine_schema,
  r.routine_name,
  r.grantee,
  r.privilege_type
from information_schema.routine_privileges as r
where r.routine_schema = 'public'
  and r.routine_name = 'update_project_exec_with_audit'
order by r.grantee, r.privilege_type;

-- Future test scenarios (not executed by this file):
-- A. anonymous call -> rejected
-- B. admin, valid real project -> update and one audit row
-- C. local_user, same region -> update and one audit row
-- D. local_user, different region -> rejected with no changes
-- E. local_user without region_id -> rejected with no changes
-- F. missing project/project_code NULL legacy row -> rejected with no changes
-- G. p_new_exec NULL, negative, or greater than alloc -> rejected
-- H. p_new_exec equal to current exec -> current row returned; no audit row
-- I. alloc = 0 and p_new_exec = 0 -> rate remains 0
-- J. forced audit insert failure -> project update rolls back

