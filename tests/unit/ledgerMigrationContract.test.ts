import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260820000100_ledger_runtime_lineage_hardening.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

test('hardening migration is transactional and is not marked as a draft', () => {
  assert.match(migration, /^begin;/mi);
  assert.match(migration, /\ncommit;\s*$/i);
  assert.doesNotMatch(migration, /DRAFT MIGRATION ONLY/i);
});

test('hardening migration fails closed on TEST runtime and fixed date', () => {
  assert.match(migration, /financial_ledger_runtime/);
  assert.match(migration, /environment_kind = 'TEST'/);
  assert.match(migration, /mode <> 'TEST'/);
  assert.match(migration, /date '2026-09-01'/);
  assert.match(migration, /project_carryovers_system_native_guard/);
});

test('hardening migration requires evidence-backed same-lineage carryover', () => {
  assert.match(migration, /financial_project_lineages/);
  assert.match(migration, /financial_project_lineage_members/);
  assert.match(migration, /financial_assert_carryover_same_lineage/);
  assert.match(migration, /project_carryovers_validate_lineage/);
  assert.match(migration, /perform public\.financial_assert_carryover_same_lineage\(/);
});
