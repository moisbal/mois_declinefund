#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';

function fail(message) { throw new Error(message); }
function refFromUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; } catch { return null; }
}
function refFromDatabase(value) {
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
async function snapshot(client) {
  return (await client.query(`select
    (select count(*)::text from public.projects) project_count,
    (select count(*)::text from public.financial_new_project_requests) request_count,
    (select count(*)::text from public.audit_logs) audit_count,
    (select coalesce(sum(coalesce(alloc,0)),0)::text from public.projects) allocation,
    (select coalesce(sum(coalesce(exec,0)),0)::text from public.projects) execution`)).rows[0];
}

async function expectRpcError(client, savepoint, expectedMessage, params) {
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(`select * from public.financial_save_new_project_request_draft_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )`, params);
    fail(`Expected validation error: ${expectedMessage}`);
  } catch (error) {
    if (error.message !== expectedMessage) throw error;
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

async function main() {
  const envPath = path.resolve(process.cwd(), '.env.ledger-test.local');
  const credentialsPath = path.resolve(process.cwd(), '.env.ledger-uat-credentials.local');
  if (!fs.existsSync(envPath) || !fs.existsSync(credentialsPath)) fail('TEST environment files are missing.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const credentials = dotenv.parse(fs.readFileSync(credentialsPath));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || !env.PROD_PROJECT_REF
      || env.PROD_PROJECT_REF === TEST_REF
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === env.PROD_PROJECT_REF) {
    fail('Fail-closed target gate rejected configuration.');
  }

  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    application_name: 'execution-status-reason-uat-rollback',
  });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    const actor = (await client.query(`select profiles.id, profiles.region_id
      from public.profiles
      join auth.users on auth.users.id = profiles.id
      where lower(auth.users.email) = lower($1) and profiles.role = 'local_user'
      limit 1`, [credentials.UAT_LOCAL_B_EMAIL])).rows[0];
    const reviewer = (await client.query(`select profiles.id
      from public.profiles where profiles.role = 'admin' and profiles.id <> $1 limit 1`, [actor?.id])).rows[0];
    if (!actor?.id || !actor?.region_id || !reviewer?.id) fail('TEST UAT actor or reviewer was not found.');

    await client.query('begin');
    transaction = true;
    await client.query("set local statement_timeout='60s'");
    await client.query(`select
      set_config('request.jwt.claim.sub', $1, true),
      set_config('request.jwt.claim.role', 'authenticated', true),
      set_config('request.jwt.claims', $2, true)`, [
      actor.id,
      JSON.stringify({ sub: actor.id, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');

    const fiscalYear = new Date().getFullYear() + 1;
    const idempotencyKey = crypto.randomUUID();
    const base = [
      null, actor.region_id, fiscalYear, '집행상태 사유 롤백 검증 사업',
      '집행상태 사유 롤백 검증 사업', '집행상태 사유 롤백 검증 사업',
      `${fiscalYear}.01~${fiscalYear}.12`, fiscalYear, fiscalYear,
      '지연', 'HW', null, null, null, '0', idempotencyKey, null,
    ];
    await expectRpcError(client, 'missing_delay_reason', '지연 사유를 입력해 주세요.', base);
    await expectRpcError(client, 'missing_difficulty_reason', '추진곤란 사유를 입력해 주세요.', [
      ...base.slice(0, 9), '추진곤란', ...base.slice(10, 16), null,
    ]);

    const delayedReason = '인허가 협의 지연 및 다음 달 보완 제출 예정';
    const created = (await client.query(`select * from public.financial_save_new_project_request_draft_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )`, [...base.slice(0, 16), delayedReason])).rows[0];
    if (!created?.request_id || created.status !== 'DRAFT') fail('Delayed draft was not saved.');
    let stored = (await client.query(`select project_status, execution_status_reason
      from public.get_financial_new_project_requests(null) where id = $1`, [created.request_id])).rows[0];
    if (stored?.project_status !== '지연' || stored?.execution_status_reason !== delayedReason) {
      fail('Delayed reason did not survive re-query.');
    }

    const normalParams = [created.request_id, ...base.slice(1, 9), '완료', ...base.slice(10, 16), delayedReason];
    await client.query(`select * from public.financial_save_new_project_request_draft_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )`, normalParams);
    stored = (await client.query(`select project_status, execution_status_reason
      from public.get_financial_new_project_requests(null) where id = $1`, [created.request_id])).rows[0];
    if (stored?.project_status !== '완료' || stored?.execution_status_reason !== null) {
      fail('Hidden reason was not cleared for 완료.');
    }

    const difficultyReason = '부지 확보가 곤란하여 대체 후보지 협의 예정';
    const difficultyParams = [created.request_id, ...base.slice(1, 9), '추진곤란', ...base.slice(10, 16), difficultyReason];
    await client.query(`select * from public.financial_save_new_project_request_draft_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
    )`, difficultyParams);
    stored = (await client.query(`select project_status, execution_status_reason
      from public.get_financial_new_project_requests(null) where id = $1`, [created.request_id])).rows[0];
    if (stored?.project_status !== '추진곤란' || stored?.execution_status_reason !== difficultyReason) {
      fail('Difficulty reason did not survive edit and re-query.');
    }

    await client.query('reset role');
    const testLot = (await client.query(`select lots.id, lots.region_id, lots.fiscal_year
      from public.financial_unallocated_fund_lots as lots
      where not exists (
        select 1 from public.financial_new_project_requests as requests
        where requests.source_lot_id = lots.id and requests.status in ('DRAFT','SUBMITTED','APPROVED')
      ) order by lots.created_at limit 1`)).rows[0];
    if (!testLot?.id) fail('A rollback-only TEST source lot was not available.');
    const officialCode = `${testLot.fiscal_year}-99-999-${crypto.randomUUID().slice(0, 8)}`;
    await client.query(`insert into public.financial_new_project_requests (
      region_id, fiscal_year, project_name, project_start_year, project_end_year,
      project_status, execution_status_reason, business_type, source_lot_id,
      requested_amount, status, official_project_code, idempotency_key,
      request_fingerprint, requested_by, approved_by, approved_at
    ) values ($1,$2,$3,$2,$2,'추진곤란',$4,'HW',$5,1,'APPROVED',$6,$7,$8,$9,$10,clock_timestamp())`, [
      testLot.region_id, testLot.fiscal_year, '집행상태 사유 물질화 롤백 검증 사업', difficultyReason,
      testLot.id, officialCode, crypto.randomUUID(), crypto.createHash('sha256').update(officialCode).digest('hex'),
      actor.id, reviewer.id,
    ]);
    const materialized = (await client.query(`insert into public.projects (
      project_id, project_code, region_id, year, project_name, status
    ) values ($1::text,$1::text,$2,$3,$4,'추진곤란') returning execution_status_reason`, [
      officialCode, testLot.region_id, testLot.fiscal_year, '집행상태 사유 물질화 롤백 검증 사업',
    ])).rows[0];
    if (materialized?.execution_status_reason !== difficultyReason) {
      fail('Approved draft reason was not copied to the materialized project.');
    }

    await client.query('rollback');
    transaction = false;
    const after = await snapshot(client);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('Rollback UAT changed TEST business rows or money.');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      target: 'TEST',
      production_touched: false,
      transaction: 'ROLLED_BACK',
      validated: [
        '지연 사유 필수 메시지',
        '추진곤란 사유 필수 메시지',
        '신규사업 초안 저장·재조회',
        '완료 변경 시 숨은 사유 null 처리',
        '추진곤란 수정·재조회',
        '승인 신규사업 생성 시 사유 승계',
      ],
      business_rows_unchanged: true,
    }, null, 2)}\n`);
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
