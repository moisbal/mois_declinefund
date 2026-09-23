'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const INTERNAL_PATTERN = '(AUTO-INT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT|(^|[^A-Za-z])UAT([^A-Za-z]|$)|(^|[^A-Za-z])TEST([^A-Za-z]|$)|RAW|GOLDEN|REJECTED|CONCURRENT_DRAFT|DRAFT_EXISTING|DRAFT_NEW|INCREASE_TARGET|REJECTION_UAT)';
const FIELDS = {
  projects: ['project_name', 'fund_project_name', 'detail_project_name', 'category'],
  large_categories: ['name'],
  middle_categories: ['name'],
  small_categories: ['name'],
  project_change_events: ['old_name', 'new_name', 'change_basis_label', 'change_reason_labels', 'other_basis', 'other_reason', 'detail'],
  financial_new_project_requests: ['project_name', 'rejection_reason'],
  financial_budget_change_requests: ['reason', 'rejection_reason'],
  financial_budget_change_request_lines: ['planned_project_name', 'note'],
  financial_pending_new_project_funds: ['planned_project_name'],
  project_small_category_proposals: ['proposed_name', 'proposal_reason', 'rejection_reason'],
  project_review_requests: ['rejection_reason'],
};

function fail(message) { throw new Error(message); }
function quoted(identifier) { return `"${identifier.replaceAll('"', '""')}"`; }
function projectRef(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
      ?? null;
  } catch { return null; }
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

async function main() {
  const includeFullSamples = process.argv.includes('--full');
  const envPath = path.resolve(process.cwd(), process.argv[2] ?? '');
  if (!process.argv[2] || !fs.existsSync(envPath)) fail('명시적인 TEST 환경 파일이 필요합니다.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF !== PROD_REF || projectRef(databaseUrl) !== TEST_REF
      || projectRef(databaseUrl) === PROD_REF) fail('TEST 대상 안전검사에 실패했습니다.');

  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'audit-test-visible-english',
  });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout='45s'");
    const runtime = (await client.query('select environment_kind, bound_project_ref from public.financial_ledger_runtime where singleton=true')).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) fail('TEST 런타임 결합값이 일치하지 않습니다.');

    const available = (await client.query(`select table_name,column_name from information_schema.columns
      where table_schema='public' and table_name=any($1::text[])`, [Object.keys(FIELDS)])).rows;
    const columns = new Set(available.map((row) => `${row.table_name}.${row.column_name}`));
    const findings = [];
    const tokenCounts = new Map();
    for (const [table, fields] of Object.entries(FIELDS)) {
      for (const field of fields) {
        if (!columns.has(`${table}.${field}`)) continue;
        const expression = `${quoted(field)}::text`;
        const count = Number((await client.query(`select count(*)::integer value from ${quoted('public')}.${quoted(table)} where ${expression} ~ '[A-Za-z]'`)).rows[0]?.value ?? 0);
        if (count === 0) continue;
        const internalCount = Number((await client.query(`select count(*)::integer value from ${quoted('public')}.${quoted(table)} where ${expression} ~* $1`, [INTERNAL_PATTERN])).rows[0]?.value ?? 0);
        const internalSamples = (await client.query(`select distinct ${expression} value from ${quoted('public')}.${quoted(table)} where ${expression} ~* $1 order by value limit 200`, [INTERNAL_PATTERN])).rows.map((row) => row.value);
        const samples = includeFullSamples
          ? (await client.query(`select distinct ${expression} value from ${quoted('public')}.${quoted(table)} where ${expression} ~ '[A-Za-z]' order by value limit 200`)).rows.map((row) => row.value)
          : internalSamples;
        for (const sample of internalSamples) {
          for (const token of String(sample).match(/[A-Za-z]+(?:[A-Za-z0-9_-]*[A-Za-z0-9])?/g) ?? []) {
            const normalized = token.toUpperCase();
            tokenCounts.set(normalized, (tokenCounts.get(normalized) ?? 0) + 1);
          }
        }
        findings.push({
          table,
          field,
          latin_row_count: count,
          internal_candidate_count: internalCount,
          official_or_named_latin_count: Math.max(0, count - internalCount),
          internal_samples: internalSamples,
          ...(includeFullSamples ? { distinct_samples: samples } : {}),
        });
      }
    }
    await client.query('commit');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      database_writes: 0, fields_with_latin: findings.length, findings,
      token_counts: Object.fromEntries([...tokenCounts.entries()].sort((a, b) => b[1] - a[1])),
    }, null, 2)}\n`);
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`TEST 영문 노출 전수조사 실패: ${error.message}\n`);
  process.exitCode = 1;
});
