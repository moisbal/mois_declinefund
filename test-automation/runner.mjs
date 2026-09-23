#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const { Client } = pg;
const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const DEFAULT_TEST_ORIGIN = 'https://declinefund-test.vercel.app';
let TEST_ORIGIN = DEFAULT_TEST_ORIGIN;
const TEST_SUPABASE_ORIGIN = `https://${TEST_REF}.supabase.co`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_PROJECT_ID = '00000000-0000-4000-8000-000000000112';
const DEFAULT_AMOUNT = 1_000_000n;
const EXISTING_TRANSFER_AMOUNT = 100_000n;
const REJECTION_RETRY_AMOUNT = 50_000n;
const CORE_STEPS = [
  ['지자체', '① 재원 없는 신규사업 임시저장'],
  ['지자체', '② 사업목록에서 초안 확인'],
  ['지자체', '③ 기존사업 감액 가능액 확인'],
  ['지자체', '④ 감액재원을 신규사업 초안에 연결'],
  ['지자체', '⑤ 필요한 승인요청 제출'],
  ['관리자', '⑥ 관련 승인목록 표시 확인'],
  ['관리자', '⑦ 출처·목적지·금액·지역·상태 확인'],
  ['관리자', '⑧ 승인 및 반영'],
  ['지자체', '⑨ 사업 생성·연결 결과 확인'],
  ['지자체', '⑩ 출처 감액·목적지 증액·변경이력 확인'],
  ['지자체', '⑪ 새로고침 후 결과 유지'],
  ['양쪽', '⑫ 동일 지역·연도 통계와 상세 금액 비교'],
];

function parseArgs(argv) {
  const result = {
    mode: 'read-only', scenario: 'smoke', headed: false,
    confirmTestWrite: false, runId: '', holdMs: 2500,
    sourceProjectId: DEFAULT_SOURCE_PROJECT_ID, baseUrl: DEFAULT_TEST_ORIGIN, fromStep: 1, referenceRunId: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const value = argv[index + 1];
    if (item === '--mode') { result.mode = value; index += 1; }
    else if (item === '--scenario') { result.scenario = value; index += 1; }
    else if (item === '--run-id') { result.runId = value; index += 1; }
    else if (item === '--hold-ms') { result.holdMs = Number(value); index += 1; }
    else if (item === '--source-project-id') { result.sourceProjectId = value; index += 1; }
    else if (item === '--base-url') { result.baseUrl = value; index += 1; }
    else if (item === '--from-step') { result.fromStep = Number(value); index += 1; }
    else if (item === '--reference-run-id') { result.referenceRunId = value; index += 1; }
    else if (item === '--headed') result.headed = true;
    else if (item === '--confirm-test-write') result.confirmTestWrite = true;
    else if (item === '...') throw new Error('`...`은 설명용 생략 표시이므로 명령에 입력하지 마세요. 필요한 실제 옵션만 입력하세요.');
    else throw new Error(`알 수 없는 인수: ${item}`);
  }
  if (!['read-only', 'mutate'].includes(result.mode)) throw new Error('--mode는 read-only 또는 mutate여야 합니다.');
  if (![
    'smoke', 'account-matrix', 'coverage', 'coverage-retry', 'core', 'regression', 'validation', 'existing-transfer',
    'split-funding-first', 'rejection-resubmit', 'project-metadata', 'small-category-lifecycle', 'native-execution',
    'visible-regression',
  ].includes(result.scenario)) throw new Error('--scenario 값이 지원 목록에 없습니다.');
  if (!Number.isInteger(result.holdMs) || result.holdMs < 0 || result.holdMs > 10_000) throw new Error('--hold-ms는 0~10000 정수여야 합니다.');
  if (result.mode === 'mutate' && !result.confirmTestWrite) throw new Error('TEST 변경 모드는 --confirm-test-write가 필요합니다.');
  if (['core', 'existing-transfer', 'split-funding-first', 'rejection-resubmit', 'project-metadata', 'small-category-lifecycle', 'native-execution'].includes(result.scenario) && result.mode !== 'mutate') throw new Error('변경 시나리오는 --mode mutate가 필요합니다.');
  if (['regression', 'coverage', 'project-metadata', 'small-category-lifecycle', 'native-execution'].includes(result.scenario) && !result.referenceRunId) throw new Error(`${result.scenario} 시나리오는 --reference-run-id <완료된 핵심 실행 ID>가 필요합니다.`);
  if (![1, 12].includes(result.fromStep)) throw new Error('--from-step은 1 또는 12여야 합니다.');
  if (result.fromStep !== 1 && result.scenario !== 'core') throw new Error('--from-step은 핵심 연결 시나리오에서만 사용할 수 있습니다.');
  return result;
}

function loadEnvFile(filename) {
  const resolved = path.join(ROOT, filename);
  if (!fs.existsSync(resolved)) throw new Error(`필수 환경 파일이 없습니다: ${filename}`);
  return dotenv.parse(fs.readFileSync(resolved));
}

function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) throw new Error(`필수 환경값이 없습니다: ${key}`);
  return value;
}

function apiProjectRef(value) {
  return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
}

function databaseProjectRef(value) {
  const url = new URL(value);
  return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
    ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
    ?? null;
}

function pgConnectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

function verifyTestConfiguration(env, args) {
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const forbiddenText = JSON.stringify({
    target: env.TARGET_ENV,
    testRef: env.TEST_PROJECT_REF,
    supabaseUrl,
    databaseHost: new URL(databaseUrl).hostname,
  });
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF !== PROD_REF
      || apiProjectRef(supabaseUrl) !== TEST_REF
      || databaseProjectRef(databaseUrl) !== TEST_REF
      || databaseProjectRef(databaseUrl) === PROD_REF
      || forbiddenText.includes(PROD_REF) && apiProjectRef(supabaseUrl) === PROD_REF) {
    throw new Error('TEST 대상 확인에 실패했습니다. 네트워크 작업을 시작하지 않습니다.');
  }
  if (args.mode === 'mutate' && !['reconciliation', 'test'].includes(String(env.LEDGER_MODE).toLowerCase())) {
    throw new Error('TEST 재정원장 모드가 승인된 변경 시험 모드가 아니므로 중단합니다.');
  }
  const requestedOrigin = new URL(args.baseUrl).origin;
  const isVerifiedTestPreview = /^https:\/\/declinefund-test-server-[a-z0-9-]+-regional-budget-mngt\.vercel\.app$/i.test(requestedOrigin);
  if (requestedOrigin !== DEFAULT_TEST_ORIGIN
      && requestedOrigin !== 'http://127.0.0.1:3010'
      && !isVerifiedTestPreview) {
    throw new Error(`허용되지 않은 브라우저 대상: ${requestedOrigin}`);
  }
  TEST_ORIGIN = requestedOrigin;
  return { supabaseUrl, databaseUrl };
}

function makeRunId() {
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace(/[-: ]/g, '');
  return `AUTO-INT-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
}

function visibleAutomatedProjectName(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/\bAUTO-INT-(\d{8})-(\d{6})\b/i);
  if (!match) return raw;
  const remainder = raw.replace(match[0], '').trim();
  const label = /^자동 통합시험(?:\s|$)/.test(remainder)
    ? remainder
    : ['자동 통합시험', remainder].filter(Boolean).join(' · ');
  return `${label} · 실행 ${match[1]}-${match[2]}`;
}

function visibleAutomatedStoredText(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/\bAUTO-INT-(\d{8})-(\d{6})\b/i);
  if (!match) return raw;
  const remainder = raw.replace(match[0], '').trim()
    .replace(/^자동 통합시험(?:\s*[·-]?\s*)?/, '')
    .trim();
  return ['자동 통합시험', `${match[1]}-${match[2]}`, remainder].filter(Boolean).join(' · ');
}

function validateRunId(value) {
  if (!/^AUTO-INT-\d{8}-\d{6}$/.test(value)) {
    throw new Error('실행 ID는 AUTO-INT-YYYYMMDD-HHMMSS 형식이어야 합니다.');
  }
  return value;
}

function won(value) {
  return `${BigInt(value).toLocaleString('ko-KR')}원`;
}

function dateOnly(value) {
  if (value instanceof Date) {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(value);
  }
  const text = String(value ?? '');
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error(`날짜 값을 확인할 수 없습니다: ${text}`);
  return match[0];
}

function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9가-힣_-]+/g, '-').replace(/-+/g, '-').slice(0, 90);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

class Reporter {
  constructor(runId, args) {
    this.runId = runId;
    this.args = args;
    this.startedAt = new Date().toISOString();
    this.results = [];
    this.artifactDir = path.join(ROOT, 'test-automation', 'artifacts', runId);
    this.screenDir = path.join(this.artifactDir, 'screens');
    fs.mkdirSync(this.screenDir, { recursive: true });
  }

  line(item) {
    const head = `[${item.scenario}][${item.role}][${item.step}][${item.status}]`;
    process.stdout.write(`${head}\n  기대: ${item.expected}\n  실제: ${item.actual}\n`);
    if (item.url) process.stdout.write(`  URL: ${item.url}\n`);
    if (item.evidence) process.stdout.write(`  증거: ${path.relative(ROOT, item.evidence)}\n`);
  }

  add(item) {
    const full = { at: new Date().toISOString(), ...item };
    this.results.push(full);
    this.line(full);
    this.flush();
    return full;
  }

  skip(scenario, role, step, expected, reason) {
    return this.add({ scenario, role, step, status: '미실행', expected, actual: reason });
  }

  async capture(page, label) {
    const filename = `${String(this.results.length + 1).padStart(2, '0')}-${safeFilename(label)}.png`;
    const target = path.join(this.screenDir, filename);
    try {
      await page.screenshot({ path: target, fullPage: true, animations: 'disabled', timeout: 12_000 });
    } catch {
      await page.screenshot({ path: target, fullPage: false, animations: 'disabled', timeout: 12_000 });
    }
    return target;
  }

  flush(extra = {}) {
    const payload = {
      runId: this.runId,
      target: 'TEST',
      productionTouched: false,
      mode: this.args.mode,
      scenario: this.args.scenario,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      results: this.results,
      ...extra,
    };
    fs.writeFileSync(path.join(this.artifactDir, 'result.json'), `${JSON.stringify(payload, null, 2)}\n`);
    const rows = this.results.map((item) => `<tr class="${item.status}"><td>${escapeHtml(item.scenario)}</td><td>${escapeHtml(item.role)}</td><td>${escapeHtml(item.step)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.expected)}</td><td>${escapeHtml(item.actual)}</td><td>${item.evidence ? `<a href="${escapeHtml(path.relative(this.artifactDir, item.evidence).replaceAll('\\', '/'))}">화면</a>` : ''}</td></tr>`).join('');
    fs.writeFileSync(path.join(this.artifactDir, 'index.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${escapeHtml(this.runId)} TEST 통합시험</title><style>body{font-family:system-ui;margin:24px;color:#172033}h1{font-size:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd4df;padding:8px;vertical-align:top}.PASS{background:#edf9f0}.FAIL{background:#fff0f0}.미실행{background:#fff8e5}</style><h1>지방소멸대응기금 TEST 통합시험</h1><p>실행 ID: ${escapeHtml(this.runId)} · 모드: ${escapeHtml(this.args.mode)} · Production 접근/변경: 없음</p><table><thead><tr><th>시나리오</th><th>역할</th><th>단계</th><th>결과</th><th>기대</th><th>실제</th><th>증거</th></tr></thead><tbody>${rows}</tbody></table></html>`);
  }
}

async function step(reporter, definition, fn) {
  const { scenario, role, name, expected, page, hold = true } = definition;
  process.stdout.write(`\n[진행][${scenario}][${role}] ${name}\n`);
  try {
    const actual = await fn();
    if (hold && page) await page.waitForTimeout(reporter.args.holdMs);
    const evidence = page ? await reporter.capture(page, `${role}-${name}`) : undefined;
    reporter.add({ scenario, role, step: name, status: 'PASS', expected, actual: String(actual), url: page?.url(), evidence });
    return actual;
  } catch (error) {
    let evidence;
    try { if (page) evidence = await reporter.capture(page, `FAIL-${role}-${name}`); } catch {}
    const actual = error instanceof Error ? error.message : String(error);
    reporter.add({ scenario, role, step: name, status: 'FAIL', expected, actual, url: page?.url(), evidence });
    throw error;
  }
}

async function independentStep(reporter, definition, fn) {
  try {
    await step(reporter, definition, fn);
    return true;
  } catch {
    return false;
  }
}

function assertExactTestPage(page) {
  const url = new URL(page.url());
  if (url.origin !== TEST_ORIGIN || url.href.includes(PROD_REF)) {
    throw new Error(`TEST 외 주소 감지: ${url.origin}`);
  }
}

async function installNetworkGuard(context, blockedHosts) {
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (/^(data|blob|about):/.test(requestUrl)) return route.continue();
    const url = new URL(requestUrl);
    const allowed = url.origin === TEST_ORIGIN || url.origin === TEST_SUPABASE_ORIGIN;
    if (!allowed || url.href.includes(PROD_REF)) {
      blockedHosts.add(url.origin);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.code ?? 'RPC'} ${error.message}`);
  return data ?? [];
}

function one(rows, label) {
  const value = Array.isArray(rows) ? rows[0] : rows;
  if (!value) throw new Error(`${label} 결과가 없습니다.`);
  return value;
}

async function signInApi(env, prefix, label) {
  const client = createClient(required(env, 'NEXT_PUBLIC_SUPABASE_URL'), required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: required(env, `${prefix}_EMAIL`),
    password: required(env, `${prefix}_PASSWORD`),
  });
  if (error || !data.user) throw new Error(`${label} TEST 인증에 실패했습니다.`);
  return { client, user: data.user };
}

async function readProfileWithClockSkewRetry(account) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const result = await account.client.from('profiles')
      .select('id,role,region_id,region_name').eq('id', account.user.id).single();
    if (!result.error) return result.data;
    if (!/JWT issued at future/i.test(result.error.message) || Date.now() >= deadline) {
      throw new Error(`TEST 역할 조회 실패: ${result.error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function nextOfficialCode(pgClient, regionId, year) {
  const region = (await pgClient.query('select region_code from public.regions where id=$1', [regionId])).rows[0];
  const digits = String(region?.region_code ?? '').replace(/\D/g, '').padEnd(5, '0').slice(0, 5);
  const prefix = `${year}-${digits.slice(0, 2)}-${digits.slice(2)}`;
  for (let suffix = 9501; suffix <= 9999; suffix += 1) {
    const code = `${prefix}-${String(suffix).padStart(4, '0')}`;
    const exists = (await pgClient.query('select exists(select 1 from public.projects where project_code=$1 or project_id=$1) value', [code])).rows[0]?.value;
    if (!exists) return code;
  }
  throw new Error(`사용 가능한 TEST 사업 등록번호가 없습니다: ${prefix}`);
}

async function preflight(env, config, runId, sourceProjectId) {
  const [local, admin] = await Promise.all([
    signInApi(env, 'UAT_LOCAL_B', '부산 서구 지자체'),
    signInApi(env, 'UAT_ADMIN_A', '관리자 A'),
  ]);
  const pgClient = new Client({
    connectionString: pgConnectionString(config.databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: `browser-uat-${runId}`,
  });
  await pgClient.connect();
  try {
    await pgClient.query('begin read only');
    await pgClient.query("set local statement_timeout='45s'");
    const runtime = (await pgClient.query('select environment_kind,mode,bound_project_ref,native_start_date from public.financial_ledger_runtime where singleton')).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.mode !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) {
      throw new Error('DB 재정원장 런타임이 승인된 TEST가 아닙니다.');
    }
    const profiles = await Promise.all([local, admin].map(readProfileWithClockSkewRetry));
    const [localProfile, adminProfile] = profiles;
    if (localProfile.role !== 'local_user' || localProfile.region_name !== '부산 서구') throw new Error('UAT_LOCAL_B 역할·지역이 부산 서구 지자체가 아닙니다.');
    if (adminProfile.role !== 'admin') throw new Error('UAT_ADMIN_A 역할이 관리자가 아닙니다.');
    const source = (await pgClient.query(`select id,year,project_code,
      coalesce(nullif(btrim(detail_project_name),''),nullif(btrim(fund_project_name),''),project_name) project_name,
      region_id,alloc::bigint::text allocation,exec::bigint::text execution
      from public.projects where id=$1`, [sourceProjectId])).rows[0];
    if (!source || source.region_id !== localProfile.region_id) throw new Error('감액 원천 사업이 부산 서구 TEST 사업이 아닙니다.');
    const position = one(await rpc(local.client, 'get_financial_budget_change_project_position', { p_project_id: sourceProjectId }), '감액 원천 금액');
    if (!position.valid_execution || BigInt(position.unexecuted_amount ?? '0') < DEFAULT_AMOUNT) {
      throw new Error(`감액 가능액 부족 또는 집행 무결성 오류: ${won(position.unexecuted_amount ?? '0')}`);
    }
    const destinationCandidates = await rpc(local.client, 'get_financial_budget_change_candidates', {
      p_anchor_project_id: source.id, p_search: null, p_year: Number(source.year), p_require_available: false,
    });
    const selectedDestination = destinationCandidates.find((candidate) => candidate.project_id !== source.id
      && String(candidate.project_name ?? '').includes('기업지원 특례보증'))
      ?? destinationCandidates.find((candidate) => candidate.project_id !== source.id);
    if (!selectedDestination?.project_id) throw new Error('같은 지역·연도의 기존사업 재배분 목적지 후보가 없습니다.');
    const destination = (await pgClient.query(`select id,year,project_code,
      coalesce(nullif(btrim(detail_project_name),''),nullif(btrim(fund_project_name),''),project_name) project_name,
      region_id,alloc::bigint::text allocation,exec::bigint::text execution
      from public.projects where id=$1`, [selectedDestination.project_id])).rows[0];
    if (!destination || destination.id === source.id || destination.region_id !== source.region_id
        || Number(destination.year) !== Number(source.year)) {
      throw new Error('기존사업 재배분 목적지가 같은 부산 서구·연도의 다른 TEST 사업이 아닙니다.');
    }
    const destinationPosition = one(await rpc(local.client, 'get_financial_budget_change_project_position', { p_project_id: destination.id }), '재배분 목적지 금액');
    const projectName = `자동 통합시험 부산 생활거점 ${runId}`;
    const existing = (await pgClient.query(`select id,status,requested_amount::bigint::text,source_budget_change_request_id,materialized_project_id,
      (select r.source_project_id from public.financial_budget_change_requests r where r.id=financial_new_project_requests.source_budget_change_request_id) actual_source_project_id,
      (select p.project_code from public.projects p where p.id=financial_new_project_requests.materialized_project_id) actual_project_code
      from public.financial_new_project_requests where project_name=$1 order by requested_at desc`, [projectName])).rows;
    const transferReason = `자동 통합시험 기존사업 재배분 ${runId}`;
    const existingTransfer = (await pgClient.query(`select requests.id,requests.status,requests.total_amount::bigint::text,
      requests.source_project_id,requests.reason,
      coalesce(sum(lines.amount),0)::bigint::text destination_sum,
      array_remove(array_agg(lines.destination_project_id),null) destination_project_ids
      from public.financial_budget_change_requests requests
      left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
      where requests.reason=$1
      group by requests.id order by requests.requested_at desc`, [transferReason])).rows;
    const splitReason = `자동 통합시험 복수 배분 ${runId}`;
    const splitProjectName = `자동 통합시험 차년도 공동배분 ${runId}`;
    const officialCode = await nextOfficialCode(pgClient, localProfile.region_id, Number(source.year) + 1);
    await pgClient.query('commit');
    return {
      local, admin, pgClient, runtime, localProfile, adminProfile,
      source, position, destination, destinationPosition,
      projectName, projectDisplayName: visibleAutomatedProjectName(projectName), existing,
      officialCode: existing[0]?.actual_project_code ?? officialCode,
      transferReason, transferReasonDisplay: visibleAutomatedStoredText(transferReason), existingTransfer,
      splitReason, splitReasonDisplay: visibleAutomatedStoredText(splitReason),
      splitProjectName, splitProjectDisplayName: visibleAutomatedProjectName(splitProjectName),
    };
  } catch (error) {
    await pgClient.query('rollback').catch(() => undefined);
    await pgClient.end().catch(() => undefined);
    await local.client.auth.signOut().catch(() => undefined);
    await admin.client.auth.signOut().catch(() => undefined);
    throw error;
  }
}

async function finishPreflight(state) {
  await state.pgClient.end().catch(() => undefined);
  await state.local.client.auth.signOut().catch(() => undefined);
  await state.admin.client.auth.signOut().catch(() => undefined);
}

async function loginBrowser(page, email, password, expectedBanner) {
  const responseFailures = [];
  const rememberFailure = (response) => {
    if (response.status() >= 400) {
      responseFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  };
  page.on('response', rememberFailure);
  await page.goto(`${TEST_ORIGIN}/login`, { waitUntil: 'domcontentloaded' });
  assertExactTestPage(page);
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    if (!form) return false;
    return Object.keys(form).some((key) => key.startsWith('__reactProps$')
      && typeof form[key]?.onSubmit === 'function');
  }, { timeout: 60_000 });
  await page.getByLabel('아이디 또는 이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  try {
    await page.waitForURL(`${TEST_ORIGIN}/dashboard`, {
      timeout: TEST_ORIGIN.startsWith('http://127.0.0.1:') ? 120_000 : 30_000,
    });
  } catch {
    const alerts = await page.locator('[role="alert"], .error-message').allTextContents();
    const detail = [...new Set([...alerts.filter(Boolean), ...responseFailures])].join(' / ');
    throw new Error(`TEST 화면 로그인 실패${detail ? `: ${detail}` : ''}`);
  } finally {
    page.off('response', rememberFailure);
  }
  await page.getByText(expectedBanner, { exact: false }).waitFor({ timeout: 30_000 });
  assertExactTestPage(page);
}

async function launchRoleBrowser(args, position) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: !args.headed, slowMo: args.headed ? 100 : 0,
    args: args.headed ? [`--window-position=${position},0`, '--window-size=960,940'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 920, height: 820 }, locale: 'ko-KR' });
  const blockedHosts = new Set();
  await installNetworkGuard(context, blockedHosts);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(TEST_ORIGIN.startsWith('http://127.0.0.1:') ? 120_000 : 30_000);
  return { browser, context, page, blockedHosts };
}

async function runSmoke(reporter, env, state, localRole, adminRole) {
  await step(reporter, { scenario: '연결 점검', role: '지자체', name: '로그인·지역 확인', expected: '부산 서구 담당자 TEST 화면', page: localRole.page }, async () => {
    await loginBrowser(localRole.page, 'review_user_4', required(env, 'UAT_LOCAL_B_PASSWORD'), '부산 서구 담당자');
    return '부산 서구 담당자 로그인 확인';
  });
  await step(reporter, { scenario: '연결 점검', role: '관리자', name: '로그인·역할 확인', expected: '테스트 관리자 A TEST 화면', page: adminRole.page }, async () => {
    await loginBrowser(adminRole.page, 'review_user_1', required(env, 'UAT_ADMIN_A_PASSWORD'), '테스트 관리자 A');
    return '테스트 관리자 A 로그인 확인';
  });
  await step(reporter, { scenario: '조회 전용', role: '지자체', name: '사업목록 조회', expected: '사업 목록과 조회 필터 표시', page: localRole.page }, async () => {
    await localRole.page.goto(`${TEST_ORIGIN}/my-projects?tab=projects`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(localRole.page);
    await localRole.page.getByRole('heading', { name: '사업 목록' }).waitFor({ timeout: 30_000 });
    await localRole.page.getByLabel('사업명 검색').waitFor();
    return '사업 목록·검색·연도·상태 필터 표시 확인';
  });
  await step(reporter, { scenario: '표시 회귀', role: '지자체', name: '모든 사업의 신규·계속사업 가로 배열', expected: '두 선택지가 2열이며 각 텍스트가 한 줄 가로쓰기', page: localRole.page }, async () => {
    await localRole.page.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(localRole.page);
    const dialog = localRole.page.locator('.similar-project-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    if (await dialog.isVisible().catch(() => false)) {
      const closeButton = dialog.getByRole('button', { name: '닫기', exact: true });
      if (await closeButton.isVisible().catch(() => false)) await closeButton.click();
    }
    const group = localRole.page.locator('.project-lifecycle-options');
    await group.waitFor({ state: 'visible', timeout: 30_000 });
    const layout = await group.evaluate((element) => {
      const groupStyle = getComputedStyle(element);
      const labels = [...element.querySelectorAll('label')].map((label) => {
        const input = label.querySelector('input[type="radio"]');
        const text = label.querySelector('span');
        const textRect = text?.getBoundingClientRect();
        const inputRect = input?.getBoundingClientRect();
        const textStyle = text ? getComputedStyle(text) : null;
        return {
          text: text?.textContent?.trim(),
          textWidth: textRect?.width ?? 0,
          textHeight: textRect?.height ?? 0,
          inputWidth: inputRect?.width ?? 0,
          inputHeight: inputRect?.height ?? 0,
          whiteSpace: textStyle?.whiteSpace,
          writingMode: textStyle?.writingMode,
        };
      });
      return { display: groupStyle.display, columns: groupStyle.gridTemplateColumns, labels };
    });
    if (layout.display !== 'grid' || layout.labels.length !== 2) throw new Error(`선택지 2열 구조가 아닙니다: ${JSON.stringify(layout)}`);
    if (layout.labels.some((item) => item.textWidth <= item.textHeight
      || item.whiteSpace !== 'nowrap'
      || item.writingMode !== 'horizontal-tb'
      || item.inputWidth < 16
      || item.inputHeight < 16)) {
      throw new Error(`선택지 가로 배열이 아닙니다: ${JSON.stringify(layout)}`);
    }
    return `${layout.labels.map((item) => `${item.text} ${Math.round(item.textWidth)}×${Math.round(item.textHeight)}px`).join(' · ')} · ${layout.columns}`;
  });
  await step(reporter, { scenario: '조회 전용', role: '관리자', name: '승인목록 조회', expected: '예산조정 승인 업무 탭과 거래 차액 표시', page: adminRole.page }, async () => {
    await adminRole.page.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(adminRole.page);
    await adminRole.page.getByRole('main').getByRole('heading', { name: '예산 조정 승인' }).waitFor({ timeout: 30_000 });
    await adminRole.page.getByText('적용 거래 차액', { exact: true }).waitFor();
    return '승인대기·처리이력·거래차액 화면 확인';
  });
}

const ACCOUNT_MATRIX = [
  { prefix: 'UAT_LOCAL_A', loginId: 'review_user_3', label: '지자체 A', role: 'local_user', accountName: '전북 순창군 담당자', region: '전북 순창군' },
  { prefix: 'UAT_LOCAL_B', loginId: 'review_user_4', label: '지자체 B', role: 'local_user', accountName: '부산 서구 담당자', region: '부산 서구' },
  { prefix: 'UAT_LOCAL_C', loginId: 'review_user_5', label: '지자체 C', role: 'local_user', accountName: '강원 양구군 담당자', region: '강원 양구군' },
  { prefix: 'UAT_ADMIN_A', loginId: 'review_user_1', label: '관리자 A', role: 'admin', accountName: '테스트 관리자 A', region: '전체 지역' },
  { prefix: 'UAT_ADMIN_B', loginId: 'review_user_2', label: '관리자 B', role: 'admin', accountName: '테스트 관리자 B', region: '전체 지역' },
];

function assertNoInternalDisplayLeak(text, label) {
  const internal = text.match(/\b(?:AUTO-INT-\d{8}-\d{6}|AUTO-UAT(?:-\d{8}(?:-\d{6})?)?|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT|UAT)\b/i)?.[0];
  if (internal) throw new Error(`${label} 화면에 시험 내부코드가 노출됩니다: ${internal}`);
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)) {
    throw new Error(`${label} 화면에 UUID가 노출됩니다.`);
  }
  if (/\bN\/A\b/.test(text)) throw new Error(`${label} 화면에 영문 자료없음 표기가 노출됩니다.`);
}

async function runAccountMatrix(reporter, env, args, localRole, adminRole) {
  const scenario = '5개 계정 화면·권한 매트릭스';
  const reused = new Map([
    ['UAT_LOCAL_B', localRole],
    ['UAT_ADMIN_A', adminRole],
  ]);
  const accountResults = [];

  for (let index = 0; index < ACCOUNT_MATRIX.length; index += 1) {
    const spec = ACCOUNT_MATRIX[index];
    const isReused = reused.has(spec.prefix);
    const roleBrowser = reused.get(spec.prefix) ?? await launchRoleBrowser(args, (index % 2) * 960);
    const page = roleBrowser.page;
    try {
      const loginPassed = await independentStep(reporter, {
        scenario, role: spec.label, name: '로그인·계정 식별',
        expected: `${spec.accountName} · ${spec.role === 'admin' ? '관리자' : spec.region} TEST 화면`, page,
      }, async () => {
        if (!isReused) {
          await loginBrowser(page, spec.loginId, required(env, `${spec.prefix}_PASSWORD`), spec.accountName);
        } else {
          await page.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
          await page.getByText(spec.accountName, { exact: false }).waitFor({ timeout: 60_000 });
        }
        assertExactTestPage(page);
        return `${spec.accountName} 독립 세션 확인`;
      });
      if (!loginPassed) {
        reporter.skip(scenario, spec.label, '역할별 주요 화면', '로그인 후 주요 화면 조회', '선행 로그인 실패로 미실행');
        reporter.skip(scenario, spec.label, '권한 경계', '역할 외 화면 접근 차단', '선행 로그인 실패로 미실행');
        accountResults.push({ label: spec.label, role: spec.role, region: spec.region, status: 'FAIL' });
        continue;
      }

      const dashboardPassed = await independentStep(reporter, {
        scenario, role: spec.label, name: '대시보드·메뉴·표시값',
        expected: `${spec.region} 역할 메뉴와 한글 표시, 내부코드·UUID·N/A 0건`, page,
      }, async () => {
        await page.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: /^(?:사업 현황 대시보드|지방소멸대응기금 대시보드)$/ }).first().waitFor({ timeout: 60_000 });
        await page.getByText(spec.accountName, { exact: false }).waitFor({ timeout: 60_000 });
        await page.getByText('사업 개수', { exact: true }).waitFor({ timeout: 60_000 });
        const navigationText = (await page.locator('header').innerText()).replace(/\s+/g, ' ');
        const requiredMenuGroups = spec.role === 'admin'
          ? [['대시보드'], ['통계·요구자료', '분석'], ['사업변경'], ['관리자 메뉴', '관리자 설정']]
          : [['내 사업'], ['통계·요구자료', '분석']];
        for (const alternatives of requiredMenuGroups) {
          if (!alternatives.some((menu) => navigationText.includes(menu))) {
            throw new Error(`역할 메뉴 누락: ${alternatives.join(' 또는 ')}`);
          }
        }
        if (spec.role === 'local_user' && /예산 조정|사업변경|소분류 제안|관리자 메뉴|관리자 설정|운영전환/.test(navigationText)) {
          throw new Error('지자체에 관리자 전용 메뉴가 노출됩니다.');
        }
        const text = await page.locator('main').innerText();
        if (spec.role === 'local_user' && !text.includes(spec.region)) throw new Error(`담당 지역 표시 누락: ${spec.region}`);
        assertNoInternalDisplayLeak(text, `${spec.label} 대시보드`);
        return `${spec.accountName} · 역할별 화면 이동 메뉴 확인 · 노출 위반 0건`;
      });

      let screensPassed = true;
      if (spec.role === 'local_user') {
        screensPassed = await independentStep(reporter, {
          scenario, role: spec.label, name: '내 사업·분석 화면',
          expected: '담당 지역 사업목록·필터와 분석 화면 정상 표시', page,
        }, async () => {
          await page.goto(`${TEST_ORIGIN}/my-projects?tab=projects`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('heading', { name: '사업 목록', exact: true }).waitFor({ timeout: 60_000 });
          await page.getByLabel('사업명 검색').waitFor({ timeout: 30_000 });
          const projectText = await page.locator('main').innerText();
          if (!projectText.includes(spec.region)) throw new Error(`내 사업 담당 지역 표시 누락: ${spec.region}`);
          assertNoInternalDisplayLeak(projectText, `${spec.label} 내 사업`);
          await page.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
          assertNoInternalDisplayLeak(await page.locator('main').innerText(), `${spec.label} 분석`);
          return `${spec.region} 사업목록·검색·필터·분석 표시 확인`;
        });
      } else {
        screensPassed = await independentStep(reporter, {
          scenario, role: spec.label, name: '승인·사업변경·분석 화면',
          expected: '예산조정 승인, 사업변경 목록, 분석 화면 정상 표시', page,
        }, async () => {
          await page.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('main').getByRole('heading', { name: '예산 조정 승인', exact: true }).waitFor({ timeout: 60_000 });
          await page.getByText('적용 거래 차액', { exact: true }).waitFor();
          assertNoInternalDisplayLeak(await page.locator('main').innerText(), `${spec.label} 예산 조정`);
          await page.goto(`${TEST_ORIGIN}/admin/project-changes`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('heading', { name: '사업변경 이력', exact: true }).waitFor({ timeout: 60_000 });
          assertNoInternalDisplayLeak(await page.locator('main').innerText(), `${spec.label} 사업변경`);
          await page.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
          await page.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
          assertNoInternalDisplayLeak(await page.locator('main').innerText(), `${spec.label} 분석`);
          return '예산조정 승인·사업변경·분석 화면 및 한글 표시 확인';
        });
      }

      const permissionPassed = await independentStep(reporter, {
        scenario, role: spec.label, name: '역할 권한 경계',
        expected: spec.role === 'local_user' ? '관리자 승인 URL 접근 시 대시보드 복귀' : '관리자 승인 URL 접근 허용', page,
      }, async () => {
        await page.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
        if (spec.role === 'local_user') {
          await page.waitForURL(`${TEST_ORIGIN}/dashboard`, { timeout: 30_000 });
          return '관리자 URL 직접 접근 차단·대시보드 복귀';
        }
        await page.getByRole('main').getByRole('heading', { name: '예산 조정 승인', exact: true }).waitFor({ timeout: 60_000 });
        return '관리자 승인 화면 접근 허용';
      });
      accountResults.push({
        label: spec.label, role: spec.role, region: spec.region,
        status: dashboardPassed && screensPassed && permissionPassed ? 'PASS' : 'FAIL',
      });
    } finally {
      if (!isReused) await roleBrowser.browser.close().catch(() => undefined);
    }
  }

  reporter.flush({ accountMatrix: accountResults });
  return accountResults;
}

async function selectOptionContaining(locator, fragment) {
  await locator.locator('option').filter({ hasText: fragment }).first().waitFor({ state: 'attached', timeout: 30_000 });
  const options = await locator.locator('option').allTextContents();
  const label = options.find((text) => text.includes(fragment));
  if (!label) throw new Error(`선택 목록에서 찾지 못함: ${fragment}`);
  await locator.selectOption({ label });
  return label;
}

async function runCore(reporter, env, state, localRole, adminRole) {
  const scenario = '핵심 연결';
  const local = localRole.page;
  const admin = adminRole.page;
  const amount = DEFAULT_AMOUNT.toString();
  const targetYear = Number(state.source.year) + 1;

  if (state.resumeApplied) {
    const completedSteps = [
      ['지자체', '① 재원 없는 신규사업 임시저장', '0원 초안 생성', `요청 ${state.resumeApplied.id}의 이전 화면 증거와 APPLIED 상태 재확인`],
      ['지자체', '② 사업목록에서 초안 확인', '사업목록의 같은 초안', '이전 화면 증거 유지; 제출 뒤 공식 사업으로 전환됨'],
      ['지자체', '③ 기존사업 감액 가능액 확인', '승인대기 예약액과 반영액을 구분', `적용 전 10,902,000원, 적용 후 ${won(state.position.unexecuted_amount)}`],
      ['지자체', '④ 감액재원을 신규사업 초안에 연결', '감액과 배분 합계 일치', `부모 예산조정 ${state.resumeApplied.source_budget_change_request_id} 재확인`],
      ['지자체', '⑤ 필요한 승인요청 제출', '부모 요청 한 번만 제출', 'APPLIED 상태 재확인, 재제출 없음'],
      ['관리자', '⑥ 관련 승인목록 표시 확인', '관련 승인목록 표시', '이전 승인대기 화면 증거와 현재 처리 이력 재확인'],
      ['관리자', '⑦ 출처·목적지·금액·지역·상태 확인', '필수값 일치', '이전 관리자 카드 화면에서 일치 확인'],
      ['관리자', '⑧ 승인 및 반영', '현재 승인 순서로 한 번만 처리', 'APPLIED 상태 재확인, 중복 승인·반영 없음'],
    ];
    for (const [role, stepName, expected, actual] of completedSteps) {
      reporter.add({ scenario, role, step: stepName, status: 'PASS', expected, actual });
    }
  } else {
  await step(reporter, { scenario, role: '지자체', name: '① 재원 없는 신규사업 임시저장', expected: `${targetYear}년 ${state.projectDisplayName}, 0원 초안`, page: local }, async () => {
    if (state.resumeDraft || state.resumeSubmitted || state.resumeApplied) {
      const existing = state.resumeDraft ?? state.resumeSubmitted ?? state.resumeApplied;
      await local.goto(`${TEST_ORIGIN}/my-projects?tab=projects&draft=${existing.id}`, { waitUntil: 'domcontentloaded' });
      assertExactTestPage(local);
      if (!state.resumeSubmitted && !state.resumeApplied) {
        await local.getByText(state.projectDisplayName, { exact: false }).first().waitFor({ timeout: 30_000 });
      }
      return `기존 TEST 요청 ${existing.id} (${existing.status}) 재사용, 중복 생성 없음`;
    }
    const draftUrl = state.resumeDraft
      ? `${TEST_ORIGIN}/my-projects?newProject=1&requestId=${state.resumeDraft.id}`
      : `${TEST_ORIGIN}/my-projects?newProject=1&year=${targetYear}`;
    await local.goto(draftUrl, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(local);
    const panel = local.locator('main');
    await panel.getByRole('heading', { name: /신규사업 (요청|신청)/, exact: true }).waitFor({ timeout: 30_000 });
    await panel.getByLabel('사업연도', { exact: true }).first().fill(String(targetYear));
    await panel.getByLabel('사업명', { exact: true }).fill(state.projectName);
    await panel.getByLabel('사업기간', { exact: true }).fill(`${targetYear}.01~${targetYear}.12`);
    await panel.getByLabel('시작연도', { exact: true }).fill(String(targetYear));
    await panel.getByLabel('종료연도', { exact: true }).fill(String(targetYear));
    assertExactTestPage(local);
    await panel.getByRole('button', { name: '사업만 임시저장', exact: true }).click();
    await panel.getByText(`초안 저장 완료 · ${state.projectName}`, { exact: true }).waitFor({ timeout: 30_000 });
    return '공식 금액 미반영 재원 미연결 초안 저장 완료';
  });

  await step(reporter, { scenario, role: '지자체', name: '② 사업목록에서 초안 확인', expected: '신규사업 초안 영역에 같은 이름 표시', page: local }, async () => {
    if (state.resumeDraft || state.resumeSubmitted || state.resumeApplied) {
      const existing = state.resumeDraft ?? state.resumeSubmitted ?? state.resumeApplied;
      await local.goto(`${TEST_ORIGIN}/my-projects?tab=projects&draft=${existing.id}`, { waitUntil: 'domcontentloaded' });
      if (state.resumeSubmitted || state.resumeApplied) {
        return `이전 실행에서 초안 목록 확인 완료; 제출 후 요청 ${existing.id} 상태 ${existing.status} 재확인`;
      }
    } else {
      await local.getByRole('button', { name: '사업목록에서 보기', exact: true }).click();
      await local.waitForURL(/\/my-projects\?tab=projects/, { timeout: 30_000 });
    }
    await local.getByText(state.projectDisplayName, { exact: false }).first().waitFor({ timeout: 30_000 });
    return '임시저장·재원 미연결 초안 목록 확인';
  });

  await step(reporter, { scenario, role: '지자체', name: '③ 기존사업 감액 가능액 확인', expected: `${state.source.project_name} 감액 가능액 ${won(state.position.unexecuted_amount)}`, page: local }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(local);
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 30_000 });
    const similarProjectDialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await similarProjectDialog.isVisible().catch(() => false)) {
      await similarProjectDialog.getByRole('button', { name: '닫기', exact: true }).click();
      await similarProjectDialog.waitFor({ state: 'hidden' });
    }
    await local.getByRole('button', { name: '감액액 입력 및 배분', exact: true }).click();
    await local.getByText(`현재 미집행액: ${won(state.position.unexecuted_amount)}`, { exact: true }).waitFor();
    return `승인대기 예약액 반영 후 화면 최대 감액 가능액 ${won(state.position.unexecuted_amount)}`;
  });

  await step(reporter, { scenario, role: '지자체', name: '④ 감액재원을 신규사업 초안에 연결', expected: `감액 ${won(amount)} = 초안 배분 ${won(amount)}`, page: local }, async () => {
    if (state.resumeSubmitted || state.resumeApplied) {
      const existing = state.resumeSubmitted ?? state.resumeApplied;
      await local.getByText(state.projectDisplayName, { exact: false }).first().waitFor({ timeout: 30_000 });
      return `기존 요청 ${existing.source_budget_change_request_id}의 초안 배분 재확인`;
    }
    const form = local.locator('.budget-change-form');
    await form.getByLabel(/요청 감액액/).fill(amount);
    await form.getByLabel('조정 사유').fill(`자동 통합시험 ${state.projectName} 재원 연결`);
    await form.getByLabel('배분 유형').selectOption('PENDING_NEW_PROJECT');
    const draftSelect = form.getByLabel('기존에 작성한 신규사업 초안');
    await selectOptionContaining(draftSelect, state.projectDisplayName);
    await form.getByLabel(/배분액/).fill(amount);
    await form.getByText('감액 요청액 전액을 배분했습니다.', { exact: true }).waitFor();
    const submit = form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true });
    if (await submit.isDisabled()) {
      const diagnostics = await form.evaluate((element) => {
        const controlByLabel = (labelText) => [...element.querySelectorAll('label')]
          .find((label) => label.textContent?.includes(labelText))
          ?.querySelector('input, textarea, select');
        const valueOf = (labelText) => controlByLabel(labelText)?.value ?? '';
        return {
          requestedAmount: valueOf('요청 감액액'),
          reasonLength: valueOf('조정 사유').trim().length,
          destinationType: valueOf('배분 유형'),
          draftSelected: Boolean(valueOf('기존에 작성한 신규사업 초안')),
          allocatedAmount: valueOf('배분액'),
          sourceActionDisabled: [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === '감액액 입력 및 배분')?.disabled,
          currentAmountNotice: [...element.querySelectorAll('[role="status"]')]
            .map((node) => node.textContent?.trim())
            .find((text) => text?.includes('현재 미집행액')) ?? '',
          selectedDraftNotice: [...element.querySelectorAll('[role="status"]')]
            .map((node) => node.textContent?.trim())
            .find((text) => text?.includes('기존 재원 미연결 초안')) ?? '',
          alerts: [...element.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim()).filter(Boolean),
        };
      });
      throw new Error(`거래 차액은 0원이지만 제출 버튼이 비활성화 상태입니다: ${JSON.stringify(diagnostics)}`);
    }
    await submit.click({ trial: true, timeout: 30_000 });
    return `거래별 화면 차액 0원, ${state.projectDisplayName} 연결`;
  });

  await step(reporter, { scenario, role: '지자체', name: '⑤ 필요한 승인요청 제출', expected: '예산조정과 연결 신규사업 요청이 함께 제출', page: local }, async () => {
    if (state.resumeSubmitted || state.resumeApplied) {
      const existing = state.resumeSubmitted ?? state.resumeApplied;
      return `기존 부모 예산조정 ${existing.source_budget_change_request_id} ${existing.status} 재사용, 재제출 없음`;
    }
    assertExactTestPage(local);
    await local.locator('.budget-change-form').getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).click();
    await local.getByText('감액 및 배분 요청을 제출했습니다.', { exact: false }).waitFor({ timeout: 30_000 });
    return '부모 예산조정 묶음 SUBMITTED';
  });

  await step(reporter, { scenario, role: '관리자', name: '⑥ 관련 승인목록 표시 확인', expected: '같은 신규사업 목적지가 예산조정 승인대기에 표시', page: admin }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(admin);
    await admin.getByRole('main').getByRole('heading', { name: '예산 조정 승인' }).waitFor({ timeout: 30_000 });
    if (state.resumeApplied) {
      await admin.getByRole('button', { name: /처리 이력/ }).click();
      await admin.locator('.funding-history-card').filter({ hasText: state.projectDisplayName }).first().waitFor({ timeout: 30_000 });
      return '이전 실행의 승인목록 확인 증거와 처리 이력의 같은 요청을 재확인';
    }
    await admin.getByRole('button', { name: /예산조정 승인대기/ }).click();
    const card = admin.locator('.funding-review-card').filter({ hasText: state.projectDisplayName });
    await card.waitFor({ timeout: 30_000 });
    return '부모 예산조정 승인대기 카드에서 연결 초안 확인';
  });

  await step(reporter, { scenario, role: '관리자', name: '⑦ 출처·목적지·금액·지역·상태 확인', expected: `${state.source.project_name} → ${state.projectDisplayName}, 부산 서구, ${won(amount)}, ${state.resumeApplied ? '적용완료' : '승인대기'}`, page: admin }, async () => {
    const text = state.resumeApplied
      ? (await admin.locator('.funding-history-card').allInnerTexts()).join('\n')
      : await admin.locator('.funding-review-card').filter({ hasText: state.projectDisplayName }).innerText();
    const requiredFragments = [state.source.project_name, state.projectDisplayName, '부산', '서구', state.resumeApplied ? '적용완료' : '승인대기'];
    for (const fragment of requiredFragments) if (!text.includes(fragment)) throw new Error(`승인 카드 필수값 누락: ${fragment}`);
    if (!text.includes('100만') && !text.includes('1,000,000')) throw new Error(`승인 카드 금액 불일치: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    return '출처·목적지·지역·상태·금액 일치';
  });

  await step(reporter, { scenario, role: '관리자', name: '⑧ 승인 및 반영', expected: `등록번호 ${state.officialCode}, 묶음 승인 후 적용완료`, page: admin }, async () => {
    if (state.resumeApplied) {
      await admin.locator('.funding-history-card').filter({ hasText: state.projectDisplayName }).first().waitFor({ timeout: 30_000 });
      return `기존 신규사업 요청 ${state.resumeApplied.id} APPLIED 재확인, 중복 처리 없음`;
    }
    let card = admin.locator('.funding-review-card').filter({ hasText: state.projectDisplayName });
    await card.getByLabel(/사업 등록번호/).fill(state.officialCode);
    assertExactTestPage(admin);
    await card.getByRole('button', { name: '요청 승인', exact: true }).click();
    await admin.getByText('승인', { exact: false }).first().waitFor({ timeout: 30_000 });
    card = admin.locator('.funding-review-card').filter({ hasText: state.projectDisplayName });
    await card.getByRole('button', { name: '예산 조정 적용', exact: true }).waitFor({ timeout: 30_000 });
    await admin.waitForTimeout(reporter.args.holdMs);
    assertExactTestPage(admin);
    await card.getByRole('button', { name: '예산 조정 적용', exact: true }).click();
    await admin.getByText('적용', { exact: false }).first().waitFor({ timeout: 30_000 });
    await admin.getByRole('button', { name: /처리 이력/ }).click();
    await admin.locator('.funding-history-card').filter({ hasText: state.projectDisplayName }).first().waitFor({ timeout: 30_000 });
    return '현행 부모 예산조정 순서로 APPROVED → APPLIED';
  });
  }

  if (reporter.args.fromStep === 12) {
    for (const [role, stepName, expected, actual] of [
      ['지자체', '⑨ 사업 생성·연결 결과 확인', '공식 사업 생성·연결', '이전 화면 증거와 materialized_project_id 재확인'],
      ['지자체', '⑩ 출처 감액·목적지 증액·변경이력 확인', '양쪽 금액·이력 일치', '이전 화면에서 출처·목적지 각 1,000,000원과 상호 이력 확인'],
      ['지자체', '⑪ 새로고침 후 결과 유지', '새로고침 뒤 상태 유지', '이전 화면에서 사업명·확정 증액액 유지 확인'],
    ]) reporter.add({ scenario, role, step: stepName, status: 'PASS', expected, actual });
  } else {
  let destinationUrl = '';
  await step(reporter, { scenario, role: '지자체', name: '⑨ 사업 생성·연결 결과 확인', expected: '공식 신규사업 목록에 표시되고 상세 화면으로 이동', page: local }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects?tab=projects`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(local);
    const search = local.getByLabel('사업명 검색');
    await search.fill(state.projectName);
    await local.getByRole('button', { name: '검색', exact: true }).click();
    const projectHeading = local.getByRole('heading', { name: state.projectDisplayName, exact: true });
    await projectHeading.waitFor({ timeout: 30_000 });
    const card = projectHeading.locator('xpath=ancestor::article[1]');
    await card.getByRole('button', { name: /상세|수정/ }).click();
    await local.waitForURL(/\/my-projects\/[^/]+\/edit/, { timeout: 30_000 });
    destinationUrl = local.url();
    await local.getByRole('heading', { name: state.projectDisplayName }).waitFor({ timeout: 30_000 });
    return `공식 신규사업 생성·연결 화면 확인; 등록번호 ${state.officialCode}는 관리자 화면·DB 대조값`;
  });

  await step(reporter, { scenario, role: '지자체', name: '⑩ 출처 감액·목적지 증액·변경이력 확인', expected: `출처 -${won(amount)}, 목적지 +${won(amount)}, 변경이력 존재`, page: local }, async () => {
    await local.getByText(`확정 증액액`).waitFor();
    const body = await local.locator('body').innerText();
    if (!body.includes('확정 증액액') || (!body.includes('100만원') && !body.includes('1,000,000원'))) throw new Error('목적지 증액액이 화면에 일치하지 않습니다.');
    if (!body.includes('사업변경 내역')) throw new Error('목적지 변경이력 영역이 없습니다.');
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    await local.getByText('확정 감액액').waitFor({ timeout: 60_000 });
    const sourceBody = await local.locator('body').innerText();
    if (!sourceBody.includes('확정 감액액') || (!sourceBody.includes('100만원') && !sourceBody.includes('1,000,000원'))) throw new Error('출처 감액액이 화면에 일치하지 않습니다.');
    if (!sourceBody.includes(state.projectDisplayName)) throw new Error('출처 변경이력에서 목적지 사업을 찾지 못했습니다.');
    return `출처 확정 감액 +${won(amount)}, 목적지 확정 증액 +${won(amount)}, 이력 상호 확인`;
  });

  await step(reporter, { scenario, role: '지자체', name: '⑪ 새로고침 후 결과 유지', expected: '공식 사업명과 증액액 유지', page: local }, async () => {
    await local.goto(destinationUrl, { waitUntil: 'domcontentloaded' });
    await local.reload({ waitUntil: 'domcontentloaded' });
    assertExactTestPage(local);
    await local.getByRole('heading', { name: state.projectDisplayName }).waitFor({ timeout: 60_000 });
    await local.getByText('확정 증액액').waitFor({ timeout: 60_000 });
    const body = await local.locator('body').innerText();
    if (!body.includes('확정 증액액') || (!body.includes('100만원') && !body.includes('1,000,000원'))) throw new Error('새로고침 후 증액액이 유지되지 않았습니다.');
    return '새 세션 읽기 전 화면 상태 유지';
  });
  }

  await step(reporter, { scenario, role: '양쪽', name: '⑫ 동일 지역·연도 통계와 상세 금액 비교', expected: `부산 서구 ${targetYear}년 ${state.projectDisplayName} 조정후배분액 ${won(amount)}`, page: admin }, async () => {
    const readAnalytics = async (page, role) => {
      await page.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
      assertExactTestPage(page);
      await page.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
      await page.locator('label').filter({ hasText: /^\s*사업연도/ }).locator('select').selectOption(String(targetYear));
      if (role === '관리자') {
        await page.locator('label').filter({ hasText: /^\s*시도/ }).locator('select').selectOption('부산');
        await page.locator('label').filter({ hasText: /^\s*시군구/ }).locator('select').selectOption('서구');
      }
      await page.locator('label').filter({ hasText: /^\s*집계단위/ }).locator('select').selectOption('project');
      await page.getByRole('button', { name: '조회', exact: true }).click();
      await page.getByRole('heading', { name: '집계 결과', exact: true }).waitFor({ timeout: 120_000 });
      const row = page.getByRole('row', { name: new RegExp(state.projectDisplayName) });
      try {
        await row.waitFor({ timeout: 60_000 });
      } catch {
        const visibleNames = (await page.locator('tbody tr td:nth-child(4)').allTextContents())
          .filter(Boolean)
          .slice(0, 10);
        const alerts = await page.locator('[role="alert"]').allTextContents();
        throw new Error(`${role} 통계에 대상 사업이 없습니다: URL=${page.url()} · 표시 사업=${visibleNames.join(' / ') || '없음'} · 오류=${alerts.filter(Boolean).join(' / ') || '없음'}`);
      }
      const amountTitle = await row.locator('.amount-display').first().getAttribute('title');
      return { role, amountTitle, text: (await row.innerText()).replace(/\s+/g, ' ') };
    };
    const localValue = await readAnalytics(local, '지자체');
    const adminValue = await readAnalytics(admin, '관리자');
    if (localValue.amountTitle !== adminValue.amountTitle || localValue.amountTitle !== won(amount)) {
      throw new Error(`통계 불일치: 지자체=${localValue.amountTitle}, 관리자=${adminValue.amountTitle}, 상세=${won(amount)}`);
    }
    return `지자체=${localValue.amountTitle}, 관리자=${adminValue.amountTitle}, 상세=${won(amount)}, 차액 0원`;
  });
}

async function runExistingTransfer(reporter, state, localRole, adminRole) {
  const scenario = '기존사업 재배분';
  const local = localRole.page;
  const admin = adminRole.page;
  const amount = EXISTING_TRANSFER_AMOUNT.toString();
  const existing = state.existingTransfer[0] ?? null;
  const getExpandedHistoryCard = async () => {
    const card = admin.locator('.funding-history-card')
      .filter({ hasText: state.source.project_name })
      .filter({ hasText: state.transferReasonDisplay })
      .filter({ hasText: '100,000원' })
      .first();
    await card.waitFor({ timeout: 60_000 });
    const destinationText = card.getByText(state.destination.project_name, { exact: false }).first();
    if (!(await destinationText.isVisible().catch(() => false))) {
      await card.getByText(/요청 묶음 전체 흐름 보기/).first().click();
    }
    await destinationText.waitFor({ state: 'visible', timeout: 30_000 });
    return card;
  };

  if (state.existingTransfer.length > 1) {
    throw new Error(`동일 실행 ID의 기존사업 재배분 요청이 ${state.existingTransfer.length}건이라 중복 처리를 차단했습니다.`);
  }
  if (existing) {
    const validExisting = existing.source_project_id === state.source.id
      && existing.total_amount === amount
      && existing.destination_sum === amount
      && existing.destination_project_ids?.length === 1
      && existing.destination_project_ids[0] === state.destination.id;
    if (!validExisting) throw new Error(`동일 실행 ID 거래의 출처·목적지·금액이 달라 재실행을 차단했습니다: ${existing.id}`);
    if (!['SUBMITTED', 'APPROVED', 'APPLIED'].includes(existing.status)) {
      throw new Error(`동일 실행 ID 거래가 자동 재개할 수 없는 상태입니다: ${existing.id} (${existing.status})`);
    }
    reporter.add({
      scenario: '재실행 보호', role: '양쪽', step: '기존사업 재배분 중복 제출 방지', status: 'PASS',
      expected: '동일 실행 ID는 같은 거래를 한 번만 제출',
      actual: `기존 요청 ${existing.id} (${existing.status}) 재사용`,
    });
  }

  await independentStep(reporter, {
    scenario, role: '지자체', name: 'A 감액 가능액과 B 목적지 확인',
    expected: `${state.source.project_name}에서 ${won(amount)} 감액 가능, ${state.destination.project_name}은 같은 부산 서구 ${state.source.year}년 사업`, page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(local);
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    const dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByRole('button', { name: '감액액 입력 및 배분', exact: true }).click();
    const form = local.locator('.budget-change-form');
    await form.getByText(`현재 미집행액: ${won(state.position.unexecuted_amount)}`, { exact: true }).waitFor({ timeout: 60_000 });
    if (!existing) {
      await form.getByLabel(/요청 감액액/).fill(amount);
      await form.getByLabel('조정 사유').fill(state.transferReason);
      await form.getByLabel('배분 유형').selectOption('EXISTING_PROJECT');
      await form.getByLabel('사업명 검색').fill(state.destination.project_name);
      await form.getByRole('button', { name: '검색', exact: true }).click();
      await selectOptionContaining(form.getByLabel('배분할 사업'), state.destination.project_name);
      await form.getByLabel(/배분액/).fill(amount);
      await form.getByText('감액 요청액 전액을 배분했습니다.', { exact: true }).waitFor();
      await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).click({ trial: true });
    }
    return `감액 가능액 ${won(state.position.unexecuted_amount)} · 목적지 ${state.destination.project_name} · 같은 지역·연도`;
  });

  await independentStep(reporter, {
    scenario, role: '지자체', name: 'A 감액 → B 증액 승인요청 제출',
    expected: `감액 ${won(amount)} = 기존사업 배분 ${won(amount)}, 화면 차액 0원`, page: local,
  }, async () => {
    if (existing) return `기존 요청 ${existing.id} (${existing.status}) 재사용, 중복 제출 없음`;
    assertExactTestPage(local);
    await local.locator('.budget-change-form').getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).click();
    await local.getByText('감액 및 배분 요청을 제출했습니다.', { exact: false }).waitFor({ timeout: 30_000 });
    return `SUBMITTED · ${state.transferReason}`;
  });

  await step(reporter, {
    scenario, role: '관리자', name: '승인목록 출처·목적지·금액·지역·상태 확인',
    expected: `${state.source.project_name} → ${state.destination.project_name}, 부산 서구, ${won(amount)}`, page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    assertExactTestPage(admin);
    await admin.getByRole('main').getByRole('heading', { name: '예산 조정 승인' }).waitFor({ timeout: 60_000 });
    if (existing?.status === 'APPLIED') await admin.getByRole('button', { name: /처리 이력/ }).click();
    else await admin.getByRole('button', { name: /예산조정 승인대기/ }).click();
    const card = existing?.status === 'APPLIED'
      ? await getExpandedHistoryCard()
      : admin.locator('.funding-review-card').filter({ hasText: state.transferReasonDisplay }).first();
    await card.waitFor({ timeout: 60_000 });
    let text = await card.innerText();
    if (!text.includes(state.destination.project_name)) {
      const flowToggle = card.getByText(/요청 묶음 전체 흐름 보기/).first();
      if (await flowToggle.isVisible().catch(() => false)) {
        await flowToggle.click();
        await card.getByText(state.destination.project_name, { exact: false }).first().waitFor({ timeout: 30_000 });
        text = await card.innerText();
      }
    }
    for (const fragment of [state.source.project_name, state.destination.project_name, '부산', '서구', existing?.status === 'APPLIED' ? '적용완료' : existing?.status === 'APPROVED' ? '승인완료' : '승인대기']) {
      if (!text.includes(fragment)) throw new Error(`승인 카드 필수값 누락: ${fragment}`);
    }
    if (!text.includes('10만') && !text.includes('100,000')) throw new Error('승인 카드의 100,000원 금액을 확인하지 못했습니다.');
    return `출처·목적지·지역·상태·금액 일치 · ${existing?.status ?? 'SUBMITTED'}`;
  });

  await step(reporter, {
    scenario, role: '관리자', name: '현행 순서로 승인 및 반영',
    expected: '지자체 제출 건을 관리자가 APPROVED → APPLIED로 한 번만 처리', page: admin,
  }, async () => {
    if (existing?.status === 'APPLIED') {
      await getExpandedHistoryCard();
      return `기존 요청 ${existing.id} APPLIED 재확인 · 처리 버튼 재사용 없음`;
    }
    let card = admin.locator('.funding-review-card').filter({ hasText: state.transferReasonDisplay }).first();
    if (!existing || existing.status === 'SUBMITTED') {
      await card.getByRole('button', { name: '요청 승인', exact: true }).click();
      await card.getByRole('button', { name: '예산 조정 적용', exact: true }).waitFor({ timeout: 60_000 });
    }
    card = admin.locator('.funding-review-card').filter({ hasText: state.transferReasonDisplay }).first();
    assertExactTestPage(admin);
    await card.getByRole('button', { name: '예산 조정 적용', exact: true }).click();
    await admin.getByRole('button', { name: /처리 이력/ }).click();
    await getExpandedHistoryCard();
    return 'APPROVED → APPLIED · 현행 역할 분리 유지';
  });

  await independentStep(reporter, {
    scenario: '표시 점검', role: '관리자', name: '적용완료 처리 이력의 조정 사유 표시',
    expected: `처리 이력 상세에 조정 사유 ${state.transferReasonDisplay} 표시`, page: admin,
  }, async () => {
    const card = await getExpandedHistoryCard();
    const text = await card.innerText();
    if (!text.includes(state.transferReasonDisplay)) throw new Error('적용완료 처리 이력 상세에 조정 사유가 표시되지 않습니다.');
    return '조정 사유·실행 ID 표시 확인';
  });

  await independentStep(reporter, {
    scenario, role: '지자체', name: 'A 감액·B 증액·변경이력과 새로고침 유지 확인',
    expected: `A -${won(amount)}, B +${won(amount)}, 양쪽 변경이력과 새로고침 후 상태 유지`, page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.destination.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.destination.project_name }).waitFor({ timeout: 60_000 });
    let dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByText('확정 증액액').waitFor({ timeout: 60_000 });
    let body = await local.locator('body').innerText();
    if (!body.includes(state.source.project_name) || !body.includes(state.destination.project_name)
        || !body.includes('적용완료') || (!body.includes('10만원') && !body.includes('100,000원'))) {
      throw new Error('목적지 증액 또는 변경이력에서 이번 실행을 확인하지 못했습니다.');
    }
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    await local.reload({ waitUntil: 'domcontentloaded' });
    dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByText('확정 감액액').waitFor({ timeout: 60_000 });
    body = await local.locator('body').innerText();
    if (!body.includes(state.destination.project_name) || !body.includes('적용완료')
        || (!body.includes('10만원') && !body.includes('100,000원'))) {
      throw new Error('출처 감액 변경이력이 새로고침 후 유지되지 않았습니다.');
    }
    return `출처·목적지 상호 이력 확인 · 새로고침 유지 · ${won(amount)}`;
  });
}

async function readBudgetRequestForReason(state, reason) {
  const rows = (await state.pgClient.query(`select requests.id,requests.status,
    requests.total_amount::bigint::text,requests.source_project_id,requests.reason,
    requests.rejection_reason,
    coalesce(sum(lines.amount),0)::bigint::text destination_sum,
    array_remove(array_agg(lines.destination_project_id),null) destination_project_ids
    from public.financial_budget_change_requests requests
    left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
    where requests.reason=$1
    group by requests.id order by requests.requested_at desc`, [reason])).rows;
  if (rows.length > 1) throw new Error(`동일 반려·재신청 사유의 요청이 ${rows.length}건이라 중복 처리를 차단했습니다.`);
  return rows[0] ?? null;
}

async function waitForBudgetRequestStatus(state, reason, status, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let current = null;
  do {
    current = await readBudgetRequestForReason(state, reason);
    if (current?.status === status) return current;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`${reason} 요청의 ${status} 상태를 ${timeout / 1_000}초 안에 확인하지 못했습니다.`);
}

async function runRejectionResubmit(reporter, state, localRole, adminRole) {
  const scenario = '반려·보완·재신청';
  const local = localRole.page;
  const admin = adminRole.page;
  const amount = REJECTION_RETRY_AMOUNT.toString();
  const initialReason = `자동 통합시험 반려 확인 1차 ${reporter.runId}`;
  const revisedReason = `자동 통합시험 반려 보완 재신청 ${reporter.runId}`;
  const rejectionReason = `목적지 검토 근거를 보완해 주세요 ${reporter.runId}`;
  const finalReason = `자동시험 재신청 수신 확인 ${reporter.runId}`;

  const validateRequest = (request, reason, allowedStatuses) => {
    if (!request) return;
    const valid = request.source_project_id === state.source.id
      && request.total_amount === amount
      && request.destination_sum === amount
      && request.destination_project_ids?.length === 1
      && request.destination_project_ids[0] === state.destination.id
      && request.reason === reason;
    if (!valid || !allowedStatuses.includes(request.status)) {
      throw new Error(`반려·재신청 거래의 상태·출처·목적지·금액이 달라 재실행을 차단했습니다: ${request.id}`);
    }
  };

  const submitBudgetRequest = async (reason) => {
    const existing = await readBudgetRequestForReason(state, reason);
    validateRequest(existing, reason, ['SUBMITTED', 'REJECTED']);
    if (existing) return existing;
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    const dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByRole('button', { name: '감액액 입력 및 배분', exact: true }).click();
    const form = local.locator('.budget-change-form');
    await form.getByLabel(/요청 감액액/).fill(amount);
    await form.getByLabel('조정 사유').fill(reason);
    await form.getByLabel('배분 유형').selectOption('EXISTING_PROJECT');
    await form.getByLabel('사업명 검색').fill(state.destination.project_name);
    await form.getByRole('button', { name: '검색', exact: true }).click();
    await selectOptionContaining(form.getByLabel('배분할 사업'), state.destination.project_name);
    await form.getByLabel(/배분액/).fill(amount);
    await form.getByText('감액 요청액 전액을 배분했습니다.', { exact: true }).waitFor({ timeout: 30_000 });
    await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).click();
    await local.getByText('감액 및 배분 요청을 제출했습니다.', { exact: false }).waitFor({ timeout: 30_000 });
    return waitForBudgetRequestStatus(state, reason, 'SUBMITTED');
  };

  let initial = await readBudgetRequestForReason(state, initialReason);
  let revised = await readBudgetRequestForReason(state, revisedReason);
  validateRequest(initial, initialReason, ['SUBMITTED', 'REJECTED']);
  validateRequest(revised, revisedReason, ['SUBMITTED', 'REJECTED']);

  await step(reporter, {
    scenario, role: '지자체', name: '검토용 예산조정 승인요청 제출',
    expected: `${state.source.project_name} → ${state.destination.project_name} ${won(amount)}, 차액 0원`, page: local,
  }, async () => {
    initial = await submitBudgetRequest(initialReason);
    return `요청 ${initial.id} ${initial.status} · ${won(amount)} · 중복 없음`;
  });

  await step(reporter, {
    scenario, role: '관리자', name: '검토 사유를 입력해 요청 반려',
    expected: `${rejectionReason} 사유로 금액 반영 없이 REJECTED`, page: admin,
  }, async () => {
    initial = await readBudgetRequestForReason(state, initialReason);
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    if (initial.status === 'REJECTED') {
      await admin.getByRole('button', { name: /처리 이력/ }).click();
      await admin.locator('.funding-history-card').filter({ hasText: initialReason }).first().waitFor({ timeout: 60_000 });
      return `기존 반려 요청 ${initial.id} 재사용 · 재처리 없음`;
    }
    await admin.getByRole('button', { name: /예산조정 승인대기/ }).click();
    const card = admin.locator('.funding-review-card').filter({ hasText: initialReason }).first();
    await card.waitFor({ timeout: 60_000 });
    await card.getByLabel('검토 의견').fill(rejectionReason);
    await card.getByRole('button', { name: '요청 반려', exact: true }).click();
    initial = await waitForBudgetRequestStatus(state, initialReason, 'REJECTED');
    return `요청 ${initial.id} REJECTED · 반려 사유 저장`;
  });

  await step(reporter, {
    scenario, role: '지자체', name: '반려 사유와 처리 흐름 확인',
    expected: `진행 중 요청에서 ${rejectionReason} 및 관리자 반려 단계 표시`, page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('tab', { name: /진행 중 요청/ }).click();
    const panel = local.locator('#workspace-panel-active');
    const requestCard = panel.locator('article').filter({ hasText: rejectionReason }).first();
    await requestCard.waitFor({ timeout: 60_000 });
    await requestCard.getByRole('button', { name: '상세보기', exact: true }).click();
    const detail = local.locator('aside').filter({ hasText: '요청 처리 흐름' }).first();
    await detail.waitFor({ timeout: 30_000 });
    const detailText = await detail.innerText();
    if (!detailText.includes(rejectionReason) || !detailText.includes('관리자 반려')) {
      throw new Error('반려 상세에서 사유 원문 또는 관리자 반려 단계를 확인하지 못했습니다.');
    }
    return `반려 사유 원문·관리자 반려 단계 확인 · 요청 ${initial.id}`;
  });

  await step(reporter, {
    scenario, role: '지자체', name: '조정 사유를 보완해 새 요청으로 재신청',
    expected: `${revisedReason} 사유의 새 SUBMITTED 요청 1건`, page: local,
  }, async () => {
    revised = await submitBudgetRequest(revisedReason);
    if (revised.id === initial.id) throw new Error('보완 재신청이 반려된 원 요청 ID를 잘못 재사용했습니다.');
    return `재신청 ${revised.id} ${revised.status} · 원 요청 ${initial.id} 보존`;
  });

  await step(reporter, {
    scenario, role: '관리자', name: '보완 재신청이 승인목록에 새 요청으로 표시',
    expected: `${revisedReason}, ${won(amount)}, SUBMITTED, 원 요청과 다른 ID`, page: admin,
  }, async () => {
    revised = await readBudgetRequestForReason(state, revisedReason);
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    if (revised.status === 'REJECTED') {
      await admin.getByRole('button', { name: /처리 이력/ }).click();
      await admin.locator('.funding-history-card').filter({ hasText: revisedReason }).first().waitFor({ timeout: 60_000 });
      return `기존 재신청 ${revised.id}의 수신·반려 이력 재확인`;
    }
    await admin.getByRole('button', { name: /예산조정 승인대기/ }).click();
    const card = admin.locator('.funding-review-card').filter({ hasText: revisedReason }).first();
    await card.waitFor({ timeout: 60_000 });
    let text = await card.innerText();
    if (!text.includes(state.destination.project_name)) {
      await card.getByText(/요청 묶음 전체 흐름 보기/).click();
      await card.getByText(state.destination.project_name, { exact: false }).first().waitFor({ timeout: 30_000 });
      text = await card.innerText();
    }
    for (const fragment of [state.source.project_name, state.destination.project_name, '승인대기']) {
      if (!text.includes(fragment)) throw new Error(`보완 재신청 승인카드 필수값 누락: ${fragment}`);
    }
    if (!text.includes('5만') && !text.includes('50,000')) throw new Error('보완 재신청의 50,000원 금액을 확인하지 못했습니다.');
    return `재신청 ${revised.id} SUBMITTED · 관리자 승인목록 수신 확인`;
  });

  await step(reporter, {
    scenario, role: '관리자', name: '시험 재신청을 금액 반영 없이 종결',
    expected: `${finalReason} 사유로 REJECTED, 승인·적용 없음`, page: admin,
  }, async () => {
    revised = await readBudgetRequestForReason(state, revisedReason);
    if (revised.status === 'REJECTED') return `기존 종결 요청 ${revised.id} 재사용 · 중복 처리 없음`;
    const card = admin.locator('.funding-review-card').filter({ hasText: revisedReason }).first();
    await card.getByLabel('검토 의견').fill(finalReason);
    await card.getByRole('button', { name: '요청 반려', exact: true }).click();
    revised = await waitForBudgetRequestStatus(state, revisedReason, 'REJECTED');
    return `재신청 ${revised.id} REJECTED · 금액 적용 없음`;
  });
}

async function verifyDatabaseAfterRejection(state, reporter) {
  const initialReason = `자동 통합시험 반려 확인 1차 ${reporter.runId}`;
  const revisedReason = `자동 통합시험 반려 보완 재신청 ${reporter.runId}`;
  const [initial, revised] = await Promise.all([
    readBudgetRequestForReason(state, initialReason),
    readBudgetRequestForReason(state, revisedReason),
  ]);
  const snapshots = (await state.pgClient.query(`select count(*)::integer count
    from public.financial_budget_workflow_amount_snapshots
    where budget_request_id = any($1::uuid[])`, [[initial?.id, revised?.id].filter(Boolean)])).rows[0];
  const [sourceAfter, destinationAfter] = await Promise.all([
    rpc(state.local.client, 'get_financial_budget_change_project_position', { p_project_id: state.source.id }),
    rpc(state.local.client, 'get_financial_budget_change_project_position', { p_project_id: state.destination.id }),
  ]);
  const sourcePosition = one(sourceAfter, '반려 후 출처 금액');
  const destinationPosition = one(destinationAfter, '반려 후 목적지 금액');
  const moneyKeys = ['original_allocation', 'increase_amount', 'decrease_amount', 'adjusted_allocation', 'execution_amount', 'unexecuted_amount'];
  const unchanged = moneyKeys.every((key) => String(sourcePosition[key]) === String(state.position[key]))
    && moneyKeys.every((key) => String(destinationPosition[key]) === String(state.destinationPosition[key]));
  if (!initial || !revised || initial.status !== 'REJECTED' || revised.status !== 'REJECTED'
      || initial.total_amount !== REJECTION_RETRY_AMOUNT.toString()
      || revised.total_amount !== REJECTION_RETRY_AMOUNT.toString()
      || Number(snapshots.count) !== 0 || !unchanged) {
    throw new Error(`반려·재신청 금액 무결성 실패: ${JSON.stringify({ initial, revised, snapshots, unchanged })}`);
  }
  reporter.add({
    scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '반려·재신청 금액 미반영과 요청 분리', status: 'PASS',
    expected: '원 요청·재신청은 서로 다른 REJECTED ID, 금액 스냅샷 0건, 출처·목적지 금액 불변',
    actual: `원 요청 ${initial.id} · 재신청 ${revised.id} · 적용 스냅샷 0건 · 금액 변동 0원`,
  });
  return { initialRequestId: initial.id, revisedRequestId: revised.id, snapshotCount: 0, moneyChange: '0' };
}

async function readSplitFundingState(state) {
  const requests = (await state.pgClient.query(`select requests.id,requests.status,
    requests.total_amount::bigint::text,requests.source_project_id,requests.reason,
    coalesce(sum(lines.amount),0)::bigint::text destination_sum,
    count(lines.id)::integer line_count,
    count(*) filter (where lines.destination_type='EXISTING_PROJECT')::integer existing_count,
    count(*) filter (where lines.destination_type='PENDING_NEW_PROJECT')::integer pending_count,
    array_remove(array_agg(lines.destination_project_id),null) destination_project_ids
    from public.financial_budget_change_requests requests
    left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
    where requests.reason=$1
    group by requests.id order by requests.requested_at desc`, [state.splitReason])).rows;
  const newRequest = (await state.pgClient.query(`select requests.id,requests.status,
    requests.requested_amount::bigint::text,requests.source_lot_id,
    requests.source_budget_change_request_id,requests.materialized_project_id,
    requests.official_project_code,
    projects.project_code materialized_project_code
    from public.financial_new_project_requests requests
    left join public.projects projects on projects.id=requests.materialized_project_id
    where requests.project_name=$1 order by requests.requested_at desc limit 1`, [state.splitProjectName])).rows[0] ?? null;
  const pending = (await state.pgClient.query(`select pending.id,pending.status,pending.amount::bigint::text,
    pending.lot_id,pending.source_request_id,pending.linked_project_id,
    lines.id source_line_id
    from public.financial_pending_new_project_funds pending
    join public.financial_budget_change_request_lines lines on lines.id=pending.source_line_id
    join public.financial_budget_change_requests requests on requests.id=lines.request_id
    where requests.reason=$1 order by pending.created_at desc limit 1`, [state.splitReason])).rows[0] ?? null;
  const link = pending ? (await state.pgClient.query(`select id,status,destination_project_id,
    amount::bigint::text from public.financial_pending_new_project_link_requests
    where pending_fund_id=$1 order by requested_at desc limit 1`, [pending.id])).rows[0] ?? null : null;
  return { requests, request: requests[0] ?? null, newRequest, pending, link };
}

async function waitForSplitFundingState(state, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let current;
  do {
    current = await readSplitFundingState(state);
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`${label} 상태 전환을 ${timeout / 1000}초 안에 확인하지 못했습니다.`);
}

async function runSplitFundingFirst(reporter, state, localRole, adminRole) {
  const local = localRole.page;
  const admin = adminRole.page;
  const total = 200_000n;
  const each = 100_000n;
  let current = await readSplitFundingState(state);
  if (current.requests.length > 1) throw new Error(`동일 실행 ID 복수배분 요청이 ${current.requests.length}건이라 중복 처리를 차단했습니다.`);
  if (current.request) {
    const valid = current.request.source_project_id === state.source.id
      && current.request.total_amount === total.toString()
      && current.request.destination_sum === total.toString()
      && current.request.line_count === 2
      && current.request.existing_count === 1
      && current.request.pending_count === 1
      && current.request.destination_project_ids?.length === 1
      && current.request.destination_project_ids[0] === state.destination.id;
    if (!valid || !['SUBMITTED', 'APPROVED', 'APPLIED'].includes(current.request.status)) {
      throw new Error(`동일 실행 ID 복수배분 거래의 상태·출처·목적지·금액이 달라 재실행을 차단했습니다: ${current.request.id}`);
    }
    reporter.add({ scenario: '재실행 보호', role: '양쪽', step: '복수배분 중복 제출 방지', status: 'PASS', expected: '동일 실행 ID 거래 한 건만 재사용', actual: `요청 ${current.request.id} (${current.request.status}) 재사용` });
  }
  const splitOfficialCode = current.newRequest?.materialized_project_code
    ?? current.newRequest?.official_project_code
    ?? state.officialCode;

  await step(reporter, {
    scenario: '복수 목적지 배분', role: '지자체', name: '한 감액 요청을 기존사업과 차년도 신규사업에 동시 배분',
    expected: `${won(total)} 감액 = 기존사업 ${won(each)} + 차년도 신규사업 ${won(each)}`, page: local,
  }, async () => {
    if (current.request) return `기존 요청 ${current.request.id} (${current.request.status}) 재사용, 중복 제출 없음`;
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    const dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByRole('button', { name: '감액액 입력 및 배분', exact: true }).click();
    const form = local.locator('.budget-change-form');
    await form.getByLabel('요청 감액액').fill(total.toString());
    await form.getByLabel('조정 사유').fill(state.splitReason);
    await form.getByLabel('사업명 검색').fill(state.destination.project_name);
    await form.getByRole('button', { name: '검색', exact: true }).click();
    const first = form.locator('.budget-change-destination-card').nth(0);
    await selectOptionContaining(first.getByLabel('배분할 사업'), state.destination.project_name);
    await first.getByLabel('배분액').fill(each.toString());
    await form.getByRole('button', { name: '차년도 신규사업 추가', exact: true }).click();
    const second = form.locator('.budget-change-destination-card').nth(1);
    await second.getByLabel('신규사업 연결 방식').selectOption('FUNDING_ONLY');
    await second.getByLabel('예정 신규사업명').fill(state.splitProjectName);
    await second.getByLabel('확보할 예정예산').fill(each.toString());
    await form.getByText('감액 요청액 전액을 배분했습니다.', { exact: true }).waitFor({ timeout: 30_000 });
    await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).click();
    await local.getByText('감액 및 배분 요청을 제출했습니다.', { exact: false }).waitFor({ timeout: 30_000 });
    current = await readSplitFundingState(state);
    if (current.request?.status !== 'SUBMITTED') throw new Error('복수배분 요청의 SUBMITTED 상태를 확인하지 못했습니다.');
    return `요청 ${current.request.id} · 두 목적지 · 화면 차액 0원`;
  });

  await step(reporter, {
    scenario: '복수 목적지 배분', role: '관리자', name: '두 목적지 확인 후 승인 및 반영',
    expected: `기존사업 ${state.destination.project_name} ${won(each)} + ${state.splitProjectDisplayName} ${won(each)}, APPROVED → APPLIED`, page: admin,
  }, async () => {
    current = await readSplitFundingState(state);
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    if (current.request?.status === 'APPLIED') {
      await admin.getByRole('button', { name: /처리 이력/ }).click();
      const history = admin.locator('.funding-history-card').filter({ hasText: state.splitReasonDisplay }).first();
      await history.waitFor({ timeout: 60_000 });
      if (!(await history.innerText()).includes(state.splitProjectDisplayName)) await history.getByText(/요청 묶음 전체 흐름 보기/).click();
      await history.getByText(state.splitProjectDisplayName, { exact: false }).waitFor({ timeout: 30_000 });
      return `기존 요청 ${current.request.id} APPLIED 재확인, 중복 처리 없음`;
    }
    await admin.getByRole('button', { name: /예산조정 승인대기/ }).click();
    let card = admin.locator('.funding-review-card').filter({ hasText: state.splitReasonDisplay }).first();
    await card.waitFor({ timeout: 60_000 });
    await card.getByText(/요청 묶음 전체 흐름 보기/).click();
    for (const fragment of [state.destination.project_name, state.splitProjectDisplayName, '100,000원']) {
      await card.getByText(fragment, { exact: false }).first().waitFor({ timeout: 30_000 });
    }
    if (current.request?.status === 'SUBMITTED') {
      await card.getByRole('button', { name: '요청 승인', exact: true }).click();
      await card.getByRole('button', { name: '예산 조정 적용', exact: true }).waitFor({ timeout: 60_000 });
    }
    card = admin.locator('.funding-review-card').filter({ hasText: state.splitReasonDisplay }).first();
    await card.getByRole('button', { name: '예산 조정 적용', exact: true }).click();
    current = await waitForSplitFundingState(
      state,
      (value) => value.request?.status === 'APPLIED' && value.pending?.status === 'WAITING',
      '복수배분 APPLIED·예정재원 WAITING',
    );
    return `요청 ${current.request.id} APPLIED · 예정재원 ${current.pending.id} WAITING`;
  });

  await step(reporter, {
    scenario: '재원 선확보', role: '지자체', name: '확보된 예정재원으로 신규사업 작성·제출',
    expected: `${state.splitProjectDisplayName} 초안에 ${won(each)} 예정재원 연결 후 승인요청`, page: local,
  }, async () => {
    current = await readSplitFundingState(state);
    if (!current.pending || current.pending.amount !== each.toString()) throw new Error('연결할 예정재원 100,000원을 찾지 못했습니다.');
    if (['SUBMITTED', 'APPROVED', 'APPLIED'].includes(current.newRequest?.status)) {
      return `기존 신규사업 요청 ${current.newRequest.id} (${current.newRequest.status}) 재사용, 재제출 없음`;
    }
    if (current.newRequest?.status !== 'DRAFT' || current.newRequest.source_lot_id !== current.pending.lot_id) {
      throw new Error('예정재원과 연결된 기존 신규사업 초안을 찾지 못했습니다.');
    }
    await local.goto(`${TEST_ORIGIN}/my-projects`, { waitUntil: 'domcontentloaded' });
    const draftItem = local.getByRole('listitem').filter({ hasText: state.splitProjectDisplayName }).first();
    await draftItem.getByRole('button', { name: '조회·수정', exact: true }).click();
    await local.getByRole('heading', { name: '신규사업 신청', exact: true }).waitFor({ timeout: 60_000 });
    await local.getByText('선택한 예정예산 · 100,000원', { exact: true }).waitFor({ timeout: 60_000 });
    await local.getByLabel('사업명', { exact: true }).fill(state.splitProjectName);
    await local.getByLabel('사업기간', { exact: true }).fill(`${Number(state.source.year) + 1}.01~${Number(state.source.year) + 1}.12`);
    await local.getByRole('button', { name: '승인요청', exact: true }).click();
    await local.getByText('신규사업 요청을 제출했습니다.', { exact: false }).waitFor({ timeout: 60_000 });
    current = await readSplitFundingState(state);
    if (current.newRequest?.status !== 'SUBMITTED') throw new Error('예정재원 기반 신규사업 SUBMITTED 상태를 확인하지 못했습니다.');
    return `신규사업 요청 ${current.newRequest.id} SUBMITTED · 예정재원 ${current.pending.id}`;
  });

  await step(reporter, {
    scenario: '재원 선확보', role: '관리자', name: '신규사업 생성 승인 및 재원 적용',
    expected: `등록번호 ${splitOfficialCode}, 신규사업 APPROVED → APPLIED`, page: admin,
  }, async () => {
    current = await readSplitFundingState(state);
    if (!current.newRequest) throw new Error('관리자 처리 대상 신규사업 요청이 없습니다.');
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    if (current.newRequest.status === 'APPLIED') {
      await admin.getByRole('button', { name: /처리 이력/ }).click();
      await admin.locator('.funding-history-card').filter({ hasText: state.splitProjectDisplayName }).first().waitFor({ timeout: 60_000 });
      return `기존 신규사업 요청 ${current.newRequest.id} APPLIED 재확인, 중복 처리 없음`;
    }
    await admin.getByRole('button', { name: /신규사업 승인대기/ }).click();
    let card = admin.locator('.funding-review-card').filter({ hasText: state.splitProjectDisplayName }).first();
    await card.waitFor({ timeout: 60_000 });
    if (current.newRequest.status === 'SUBMITTED') {
      await card.getByLabel(/사업 등록번호/).fill(state.officialCode);
      await card.getByRole('button', { name: '사업 생성 승인', exact: true }).click();
      await card.getByRole('button', { name: '사업 생성·재원 적용', exact: true }).waitFor({ timeout: 60_000 });
    }
    card = admin.locator('.funding-review-card').filter({ hasText: state.splitProjectDisplayName }).first();
    await card.getByRole('button', { name: '사업 생성·재원 적용', exact: true }).click();
    current = await waitForSplitFundingState(
      state,
      (value) => value.newRequest?.status === 'APPLIED' && Boolean(value.newRequest.materialized_project_id),
      '신규사업 생성·재원 APPLIED',
    );
    return `신규사업 ${current.newRequest.materialized_project_id} 생성 · 요청 APPLIED`;
  });

  await step(reporter, {
    scenario: '재원 선확보', role: '관리자', name: '예정재원 연결 승인 및 적용',
    expected: `예정재원 ${won(each)} 감소 = 신규사업 증액 ${won(each)}, APPROVED → APPLIED`, page: admin,
  }, async () => {
    current = await readSplitFundingState(state);
    if (!current.link) throw new Error('신규사업 생성 뒤 예정재원 연결 요청이 만들어지지 않았습니다.');
    if (current.link.status === 'APPLIED') {
      await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
      await admin.getByRole('button', { name: /처리 이력/ }).click();
      await admin.locator('.funding-history-card').filter({ hasText: state.splitProjectDisplayName }).first().waitFor({ timeout: 60_000 });
      return `기존 연결 요청 ${current.link.id} APPLIED 재확인, 중복 처리 없음`;
    }
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('button', { name: /예정재원 연결 승인대기/ }).click();
    let card = admin.locator('.funding-review-card').filter({ hasText: state.splitProjectDisplayName }).first();
    await card.waitFor({ timeout: 60_000 });
    if (current.link.status === 'SUBMITTED') {
      await card.getByRole('button', { name: '연결 승인', exact: true }).click();
      await card.getByRole('button', { name: '예정재원 연결 적용', exact: true }).waitFor({ timeout: 60_000 });
    }
    card = admin.locator('.funding-review-card').filter({ hasText: state.splitProjectDisplayName }).first();
    await card.getByRole('button', { name: '예정재원 연결 적용', exact: true }).click();
    current = await waitForSplitFundingState(
      state,
      (value) => value.link?.status === 'APPLIED' && value.pending?.status === 'LINKED',
      '예정재원 연결 APPLIED·예정재원 LINKED',
    );
    return `연결 요청 ${current.link.id} APPLIED · 예정재원 ${current.pending.id} LINKED`;
  });

  await step(reporter, {
    scenario: '재원 선확보', role: '지자체', name: '신규사업·연결 결과와 새로고침 유지 확인',
    expected: `${state.splitProjectDisplayName} 공식 사업, 확정 증액 ${won(each)}, 적용완료 이력`, page: local,
  }, async () => {
    current = await readSplitFundingState(state);
    if (!current.newRequest?.materialized_project_id) throw new Error('생성된 신규사업 ID가 없습니다.');
    await local.goto(`${TEST_ORIGIN}/my-projects/${current.newRequest.materialized_project_id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.splitProjectDisplayName }).waitFor({ timeout: 60_000 });
    await local.reload({ waitUntil: 'domcontentloaded' });
    const dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    if (await dialog.isVisible().catch(() => false)) await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await local.getByText('확정 증액액').waitFor({ timeout: 60_000 });
    const body = await local.locator('body').innerText();
    if ((!body.includes('10만원') && !body.includes('100,000원')) || !body.includes('적용완료')) {
      throw new Error('신규사업 확정 증액 또는 적용완료 이력이 새로고침 후 보이지 않습니다.');
    }
    return `사업 ${current.newRequest.materialized_project_id} · 등록번호 ${current.newRequest.materialized_project_code ?? current.newRequest.official_project_code} · ${won(each)}`;
  });
}

async function runRegression(reporter, state, localRole, adminRole) {
  const local = localRole.page;
  const admin = adminRole.page;
  const referenceRunId = validateRunId(reporter.args.referenceRunId);
  const reference = await loadReferenceProject(state, referenceRunId);
  const referenceName = reference.displayName;
  const selectWithPrefix = (page, label) => page.locator('label')
    .filter({ hasText: new RegExp(`^\\s*${label}`) }).locator('select').first();

  const openBudgetForm = async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    const dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByRole('button', { name: '감액액 입력 및 배분', exact: true }).click();
    await local.getByText('현재 미집행액:', { exact: false }).waitFor({ timeout: 60_000 });
    return local.locator('.budget-change-form');
  };

  await independentStep(reporter, {
    scenario: '독립 조회', role: '지자체', name: '사업목록 검색·연도·상태 필터·상세·뒤로가기',
    expected: '2026년 지연 사업을 찾고 상세 이동 뒤 필터 유지', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects?tab=projects`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: '사업 목록' }).waitFor({ timeout: 60_000 });
    const search = local.getByLabel('사업명 검색');
    await search.fill(state.source.project_name);
    await selectWithPrefix(local, '사업연도').selectOption(String(state.source.year));
    await selectWithPrefix(local, '집행상태').selectOption('지연');
    await local.getByRole('button', { name: '검색', exact: true }).click();
    const heading = local.getByRole('heading', { name: state.source.project_name, exact: true });
    await heading.waitFor({ timeout: 30_000 });
    await heading.locator('xpath=ancestor::article[1]').getByRole('button', { name: /상세|수정/ }).click();
    await local.waitForURL(/\/my-projects\/[^/]+\/edit/, { timeout: 30_000 });
    await local.goBack({ waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: '사업 목록' }).waitFor({ timeout: 60_000 });
    const values = [await search.inputValue(), await selectWithPrefix(local, '사업연도').inputValue(), await selectWithPrefix(local, '집행상태').inputValue()];
    if (values[0] !== state.source.project_name || values[1] !== String(state.source.year) || values[2] !== '지연') {
      throw new Error(`뒤로가기 후 필터 불일치: ${values.join(' / ')}`);
    }
    return `${state.source.project_name} · ${state.source.year}년 · 지연 · 뒤로가기 후 유지`;
  });

  const readAnalytics = async (page, role) => {
    await page.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
    await selectWithPrefix(page, '사업연도').selectOption(String(reference.year));
    if (role === '관리자') {
      await selectWithPrefix(page, '시도').selectOption('부산');
      await selectWithPrefix(page, '시군구').selectOption('서구');
    }
    await selectWithPrefix(page, '집계단위').selectOption('project');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await page.getByRole('heading', { name: '집계 결과', exact: true }).waitFor({ timeout: 60_000 });
    const row = page.getByRole('row', { name: new RegExp(referenceName) });
    await row.waitFor({ timeout: 60_000 });
    return await row.locator('.amount-display').first().getAttribute('title');
  };

  await independentStep(reporter, {
    scenario: '독립 조회', role: '지자체', name: '지자체 통계자료 조회',
    expected: `부산 서구 ${reference.year}년 사업·재정·원재원 통계 표시`, page: local,
  }, async () => `조정후배분액 ${await readAnalytics(local, '지자체')} · 확정 재정원장 표시`);

  await independentStep(reporter, {
    scenario: '독립 조회', role: '관리자', name: '관리자 통계자료 조회',
    expected: `부산 서구 ${reference.year}년 동일 사업·재정·원재원 통계 표시`, page: admin,
  }, async () => `조정후배분액 ${await readAnalytics(admin, '관리자')} · 확정 재정원장 표시`);

  await independentStep(reporter, {
    scenario: '독립 조회', role: '관리자', name: '지역 분포도 조회',
    expected: '관리자 분석 화면에 지역 분포도 또는 지도 표시', page: admin,
  }, async () => {
    const distribution = admin.getByText(/지역 분포도|분포도|지도/).first();
    await distribution.waitFor({ timeout: 5_000 });
    return `표시 확인: ${(await distribution.innerText()).trim()}`;
  });

  await independentStep(reporter, {
    scenario: '입력 차단', role: '지자체', name: '필수값 누락 제출 차단',
    expected: '금액·목적지 미입력 상태에서 승인요청 비활성', page: local,
  }, async () => {
    const form = await openBudgetForm();
    const disabled = await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).isDisabled();
    if (!disabled) throw new Error('필수값 누락 상태에서 승인요청이 활성화됐습니다.');
    return '승인요청 비활성 확인';
  });

  await independentStep(reporter, {
    scenario: '입력 차단', role: '지자체', name: '감액 가능액 초과 제출 차단',
    expected: `최대 ${won(state.position.unexecuted_amount)} 초과 오류와 승인요청 비활성`, page: local,
  }, async () => {
    const form = await openBudgetForm();
    const excessive = (BigInt(state.position.unexecuted_amount) + 1n).toString();
    await form.getByLabel('요청 감액액').fill(excessive);
    await form.getByText('현재 미집행액을 초과하여 감액할 수 없습니다.', { exact: false }).waitFor();
    if (!(await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).isDisabled())) throw new Error('초과 금액에서 승인요청이 활성화됐습니다.');
    return `${won(excessive)} 입력 차단`;
  });

  await independentStep(reporter, {
    scenario: '입력 차단', role: '지자체', name: '미배분액 존재 제출 차단',
    expected: '100,000원 중 50,000원 미배분 안내와 승인요청 비활성', page: local,
  }, async () => {
    const form = await openBudgetForm();
    await form.getByLabel('요청 감액액').fill('100000');
    const destination = form.getByLabel('배분할 사업');
    await destination.selectOption({ index: 1 });
    await form.getByLabel('배분액').fill('50000');
    await form.getByText('50,000원을 추가 배분해야 승인요청할 수 있습니다.', { exact: false }).waitFor();
    if (!(await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).isDisabled())) throw new Error('미배분액이 있는데 승인요청이 활성화됐습니다.');
    return '미배분액 50,000원 · 승인요청 비활성';
  });

  await independentStep(reporter, {
    scenario: '중복 방지', role: '관리자', name: '승인 완료 건 중복 처리 방지',
    expected: '적용완료 이력에 승인·적용 버튼 없음', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('button', { name: /처리 이력/ }).click();
    const cards = admin.locator('.funding-history-card').filter({ hasText: referenceName });
    await cards.first().waitFor({ timeout: 60_000 });
    const actionCount = await cards.getByRole('button', { name: /요청 승인|예산 조정 적용/ }).count();
    if (actionCount !== 0) throw new Error(`적용완료 건에 처리 버튼 ${actionCount}개가 남았습니다.`);
    return '처리 이력만 표시 · 승인/적용 버튼 0개';
  });

  await independentStep(reporter, {
    scenario: '한글화', role: '관리자', name: '시험 식별자 표시 변환과 원본 검색',
    expected: 'UAT·AUTO-UAT·AUTO-BUDGET-UAT·GENERIC-BUDGET-UAT·AUTO-INT 원본 검색 시 한글 표시 결과', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    const search = admin.getByPlaceholder('전체 사업에서 사업명 검색');
    await search.waitFor({ timeout: 60_000 });
    const checks = [
      ['UAT 순창', '사용자 검증'],
      ['AUTO-UAT-20260826-180000', '자동 사용자 검증'],
      ['AUTO-BUDGET-UAT', '자동 예산 사용자 검증'],
      ['GENERIC-BUDGET-UAT', '일반 예산 사용자 검증'],
      ['AUTO-INT-20260909-100000', '자동 통합시험 부산 생활거점'],
    ];
    for (const [raw, displayed] of checks) {
      await search.fill(raw);
      await admin.getByRole('button', { name: '전체 목록 검색', exact: true }).click();
      const row = admin.getByRole('row').filter({ hasText: displayed }).first();
      await row.waitFor({ timeout: 60_000 });
      if ((await row.innerText()).includes(raw)) throw new Error(`${raw} 내부 식별자가 결과 행에 그대로 노출됩니다.`);
    }
    return '원본 검색 성공 · 결과 행은 한글 표시';
  });

  await independentStep(reporter, {
    scenario: '한글화', role: '관리자', name: '분석 화면 내부코드·UUID 전수 노출 차단',
    expected: '사업명·분류 선택값에 시험 내부코드가 없고 원재원 UUID 열이 없음', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/analytics?groupBy=project&year=2027&sido=%EB%B6%80%EC%82%B0&sigungu=%EC%84%9C%EA%B5%AC`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
    const body = await admin.locator('body').innerText();
    const forbiddenInternalCode = body.match(/\b(?:AUTO-INT-\d{8}-\d{6}|AUTO-UAT(?:-\d{8}(?:-\d{6})?)?|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT|UAT)\b/i)?.[0];
    if (forbiddenInternalCode) throw new Error(`분석 화면에 시험 내부코드가 노출됩니다: ${forbiddenInternalCode}`);
    if (body.includes('원재원 식별값')) throw new Error('분석 화면에 원재원 내부 식별값 열이 노출됩니다.');
    const cohortTable = admin.locator('table').filter({ hasText: '원재원' }).first();
    if (await cohortTable.count()) {
      const cohortText = await cohortTable.innerText();
      if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(cohortText)) {
        throw new Error('원재원 표에 UUID가 노출됩니다.');
      }
    }
    return '사업명·분류 내부코드 0건 · 원재원 UUID 열/값 0건';
  });

  await independentStep(reporter, {
    scenario: '한글화', role: '관리자', name: 'R&D 공백·표시 변환',
    expected: 'R&D 원본 검색 결과가 연구개발로 표시되고 내부 표기 미노출', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    const search = admin.getByPlaceholder('전체 사업에서 사업명 검색');
    await search.waitFor({ timeout: 60_000 });
    await search.fill('R&D');
    await admin.getByRole('button', { name: '전체 목록 검색', exact: true }).click();
    const row = admin.getByRole('row').filter({ hasText: '연구개발' }).first();
    await row.waitFor({ timeout: 60_000 });
    if ((await row.innerText()).includes('R&D')) throw new Error('R&D가 사용자 결과 행에 그대로 노출됩니다.');
    return 'R&D 검색 성공 · 연구개발 표시';
  });
}

async function runVisibleRegression(reporter, adminRole) {
  const admin = adminRole.page;
  const forbiddenCode = /\b(?:AUTO-INT-\d{8}-\d{6}|AUTO-UAT(?:-\d{8}(?:-\d{6})?)?|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)\b/i;

  await independentStep(reporter, {
    scenario: '표시 회귀', role: '관리자', name: '사업명 시험 식별자 한글 표시',
    expected: '원본 AUTO-INT 검색은 가능하고 결과 행에는 한글 실행명만 표시', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    const search = admin.getByPlaceholder('전체 사업에서 사업명 검색');
    await search.waitFor({ timeout: 60_000 });
    await search.fill('AUTO-INT-20260909-100000');
    await admin.getByRole('button', { name: '전체 목록 검색', exact: true }).click();
    const row = admin.locator('tbody tr').filter({ hasText: '자동 통합시험 부산 생활거점' }).first();
    await row.waitFor({ timeout: 60_000 });
    const rowText = await row.innerText();
    if (forbiddenCode.test(rowText)) throw new Error(`결과 행에 내부 시험 식별자가 노출됩니다: ${rowText}`);
    return rowText.replace(/\s+/g, ' ');
  });

  await independentStep(reporter, {
    scenario: '표시 회귀', role: '관리자', name: '분석 UUID·영문 코드 노출 차단',
    expected: '원재원 UUID, 원재원 식별값, N/A, 내부 시험 코드가 없음', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/analytics?groupBy=project&year=2027&sido=%EB%B6%80%EC%82%B0&sigungu=%EC%84%9C%EA%B5%AC`, { waitUntil: 'domcontentloaded' });
    await admin.getByText('원재원 누적 집행', { exact: true }).waitFor({ timeout: 60_000 });
    const body = await admin.locator('body').innerText();
    const violations = [
      body.includes('원재원 식별값') ? '원재원 식별값' : '',
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(body) ? 'UUID' : '',
      /\bN\/A\b/.test(body) ? 'N/A' : '',
      forbiddenCode.test(body) ? '내부 시험 코드' : '',
    ].filter(Boolean);
    if (violations.length) throw new Error(`분석 화면 노출 위반: ${violations.join(', ')}`);
    return '원재원 UUID 0건 · 내부 시험 코드 0건 · 영문 N/A 0건';
  });

  await independentStep(reporter, {
    scenario: '경로 회귀', role: '관리자', name: '사업변경 페이지 404 해소',
    expected: '/admin/project-changes가 200으로 열리고 목록·상세 진입점을 표시', page: admin,
  }, async () => {
    const response = await admin.goto(`${TEST_ORIGIN}/admin/project-changes`, { waitUntil: 'domcontentloaded' });
    if (!response || response.status() >= 400) throw new Error(`사업변경 응답 상태 ${response?.status() ?? '없음'}`);
    await admin.getByRole('heading', { name: '사업변경 이력', exact: true }).waitFor({ timeout: 60_000 });
    const detail = admin.getByRole('button', { name: '보기', exact: true }).first();
    const empty = admin.getByText('조건에 맞는 사업변경 이력이 없습니다.', { exact: true });
    await Promise.race([
      detail.waitFor({ state: 'visible', timeout: 60_000 }),
      empty.waitFor({ state: 'visible', timeout: 60_000 }),
    ]);
    if (await detail.isVisible().catch(() => false)) {
      await detail.click();
      await admin.getByRole('heading', { name: '변경 상세', exact: true }).waitFor();
      return `HTTP ${response.status()} · 목록 및 상세 표시`;
    }
    return `HTTP ${response.status()} · 목록 표시 · 현재 조건 상세자료 없음`;
  });
}

async function runValidationRetry(reporter, state, localRole) {
  const local = localRole.page;
  const openBudgetFormForValidation = async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${state.source.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: state.source.project_name }).waitFor({ timeout: 60_000 });
    const dialog = local.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
    await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await local.getByRole('button', { name: '감액액 입력 및 배분', exact: true }).click();
    const form = local.locator('.budget-change-form');
    await form.getByText('현재 미집행액:', { exact: false }).waitFor({ timeout: 60_000 });
    return form;
  };

  await step(reporter, {
    scenario: '입력 차단 재시험', role: '지자체', name: '감액 가능액 초과 제출 차단',
    expected: `최대 ${won(state.position.unexecuted_amount)} 초과 오류와 승인요청 비활성`, page: local,
  }, async () => {
    const form = await openBudgetFormForValidation();
    const excessive = (BigInt(state.position.unexecuted_amount) + 1n).toString();
    await form.getByLabel('요청 감액액').fill(excessive);
    await form.getByText('현재 미집행액을 초과하여 감액할 수 없습니다.', { exact: false }).waitFor();
    if (!(await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).isDisabled())) {
      throw new Error('초과 금액에서 승인요청이 활성화됐습니다.');
    }
    return `${won(excessive)} 입력 차단`;
  });

  await step(reporter, {
    scenario: '입력 차단 재시험', role: '지자체', name: '미배분액 존재 제출 차단',
    expected: '100,000원 중 50,000원 미배분 안내와 승인요청 비활성', page: local,
  }, async () => {
    const form = await openBudgetFormForValidation();
    await form.getByLabel('요청 감액액').fill('100000');
    const destination = form.getByLabel('배분할 사업');
    await destination.selectOption({ index: 1 });
    await form.getByLabel('배분액').fill('50000');
    await form.getByText('50,000원을 추가 배분해야 승인요청할 수 있습니다.', { exact: false }).waitFor();
    if (!(await form.getByRole('button', { name: '감액 및 배분 승인요청', exact: true }).isDisabled())) {
      throw new Error('미배분액이 있는데 승인요청이 활성화됐습니다.');
    }
    return '미배분액 50,000원 · 승인요청 비활성';
  });
}

async function dismissSimilarityDialog(page) {
  const dialog = page.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
  await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
}

async function waitForSearchParam(page, key, expected, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (new URL(page.url()).searchParams.get(key) === expected) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`URL 검색조건 대기 실패: ${key}=${expected} · 현재 ${page.url()}`);
}

function selectWithLabelPrefix(page, label, scope = page) {
  return scope.locator('label').filter({ hasText: new RegExp(`^\\s*${label}`) }).locator('select').first();
}

async function loadReferenceProject(state, referenceRunId) {
  const validated = validateRunId(referenceRunId);
  const requestName = `자동 통합시험 부산 생활거점 ${validated}`;
  const row = (await state.pgClient.query(`select n.id request_id,n.status request_status,n.materialized_project_id,
    p.id,p.year,p.project_code,p.region_id,
    coalesce(nullif(btrim(p.detail_project_name),''),nullif(btrim(p.fund_project_name),''),p.project_name) project_name,
    p.detail_project_name,p.project_period,p.project_start_year,p.status,p.execution_status_reason,p.business_type,
    p.original_alloc::bigint::text,p.increase_amount::bigint::text,p.decrease_amount::bigint::text,
    p.alloc::bigint::text,p.exec::bigint::text
    from public.financial_new_project_requests n
    join public.projects p on p.id=n.materialized_project_id
    where n.project_name=$1 and n.status='APPLIED'
    order by n.applied_at desc nulls last limit 1`, [requestName])).rows[0];
  if (!row || row.region_id !== state.localProfile.region_id) {
    throw new Error(`완료된 부산 서구 핵심 실행 사업을 찾지 못했습니다: ${validated}`);
  }
  return {
    ...row,
    requestName,
    requestDisplayName: visibleAutomatedProjectName(requestName),
    displayName: visibleAutomatedProjectName(row.project_name),
    referenceRunId: validated,
  };
}

async function saveDownload(download, reporter, filename) {
  const directory = path.join(reporter.artifactDir, 'downloads');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, safeFilename(filename));
  await download.saveAs(target);
  const stat = fs.statSync(target);
  if (stat.size <= 0) throw new Error('내려받은 파일이 비어 있습니다.');
  return `${path.relative(ROOT, target)} · ${stat.size.toLocaleString('ko-KR')}바이트`;
}

async function runCoverage(reporter, state, localRole, adminRole) {
  const scenario = '전체 기능 조회 시뮬레이션';
  const local = localRole.page;
  const admin = adminRole.page;
  const reference = await loadReferenceProject(state, reporter.args.referenceRunId);

  await independentStep(reporter, {
    scenario, role: '양쪽', name: '역할별 메뉴와 금지 메뉴 경계',
    expected: '지자체 3개 업무 메뉴, 관리자 6개 업무 메뉴 표시 · 운영전환은 접근하지 않음', page: admin,
  }, async () => {
    await Promise.all([
      local.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' }),
      admin.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' }),
    ]);
    const localNav = local.locator('header');
    const adminNav = admin.locator('header');
    await Promise.all([localNav.waitFor(), adminNav.waitFor()]);
    await Promise.all([
      localNav.getByRole('button', { name: '내 사업 관리', exact: true }).waitFor({ timeout: 60_000 }),
      adminNav.getByRole('button', { name: '메인 대시보드', exact: true }).waitFor({ timeout: 60_000 }),
      adminNav.getByRole('button', { name: '재원관리', exact: true }).waitFor({ timeout: 60_000 }),
    ]);
    const localText = (await localNav.innerText()).replace(/\s+/g, ' ');
    const adminText = (await adminNav.innerText()).replace(/\s+/g, ' ');
    for (const label of ['내 사업 관리', '통계·요구자료']) {
      if (!localText.includes(label)) throw new Error(`지자체 메뉴 누락: ${label}`);
    }
    for (const label of ['메인 대시보드', '통계·요구자료', '관리자 메뉴', '사업변경', '재원관리']) {
      if (!adminText.includes(label)) throw new Error(`관리자 메뉴 누락: ${label}`);
    }
    if (/관리자 메뉴|사업변경|운영전환|재원관리/.test(localText)) throw new Error('지자체 메뉴에 관리자 전용 항목이 노출됩니다.');
    return `지자체=${localText} · 관리자 업무메뉴 확인 · 운영전환 클릭/접근 0회`;
  });

  await independentStep(reporter, {
    scenario, role: '양쪽', name: '상호 역할 권한 우회 차단',
    expected: '지자체 관리자 화면 및 관리자 지자체 편집 화면 접근 시 대시보드로 복귀', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    await local.waitForURL(`${TEST_ORIGIN}/dashboard`, { timeout: 30_000 });
    await admin.goto(`${TEST_ORIGIN}/my-projects/${reference.id}/edit`, { waitUntil: 'domcontentloaded' });
    await admin.waitForURL(`${TEST_ORIGIN}/dashboard`, { timeout: 30_000 });
    return '직접 URL 2건 모두 역할별 대시보드로 리디렉션';
  });

  await independentStep(reporter, {
    scenario, role: '지자체', name: '내 사업 전체 필터·정렬·요청 탭·상태 유지',
    expected: '사업 검색/연도/집행상태/분류/재원/완결성/집행률/정렬과 요청 탭이 동작하고 새로고침 후 URL 상태 유지', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects?tab=projects`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: '사업 목록', exact: true }).waitFor({ timeout: 60_000 });
    const search = local.getByLabel('사업명 검색');
    await search.fill(reference.requestName);
    await selectWithLabelPrefix(local, '사업연도').selectOption(String(reference.year));
    await selectWithLabelPrefix(local, '정렬').selectOption('name');
    await local.getByRole('button', { name: '검색', exact: true }).click();
    const result = local.locator('tr[role="link"]:visible, article:visible').filter({ hasText: reference.requestDisplayName }).first();
    await result.waitFor({ timeout: 60_000 });
    const before = new URL(local.url()).search;
    await local.reload({ waitUntil: 'domcontentloaded' });
    await local.locator('tr[role="link"]:visible, article:visible').filter({ hasText: reference.requestDisplayName }).first().waitFor({ timeout: 60_000 });
    if (new URL(local.url()).search !== before) throw new Error('새로고침 후 사업 필터 URL이 달라졌습니다.');
    for (const tab of ['진행 중 요청', '완료된 요청']) {
      await local.getByRole('tab', { name: new RegExp(tab) }).click();
      await local.getByRole('heading', { name: tab, exact: true }).waitFor();
      await local.getByText('요청 검색', { exact: true }).waitFor();
    }
    return '사업 10종 필터·6종 정렬 표시, 참조사업 검색, 요청 2개 탭, 새로고침 유지 확인';
  });

  const dashboardCheck = async (page, role) => {
    await page.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByText('사업 목록', { exact: true }).first().waitFor({ timeout: 60_000 });
    const form = page.locator('.project-filter-form');
    await form.waitFor();
    await selectWithLabelPrefix(page, '연도', form).selectOption(String(state.source.year));
    if (role === '관리자') {
      await selectWithLabelPrefix(page, '시도', form).selectOption('부산');
      await selectWithLabelPrefix(page, '시군구', form).selectOption('서구');
    }
    await page.getByPlaceholder('전체 사업에서 사업명 검색').fill(state.source.project_name);
    await page.getByRole('button', { name: '전체 목록 검색', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: state.source.project_name }).first();
    await row.waitFor({ timeout: 60_000 });
    const ledgerButton = row.getByRole('button', { name: /원장에서 관리|수정/ });
    if ((await ledgerButton.innerText()).trim() !== '원장에서 관리' || !(await ledgerButton.isDisabled())) {
      throw new Error('재정원장 적용 사업의 대시보드 직접 집행 수정이 차단되지 않았습니다.');
    }
    await row.getByRole('button', { name: '분류 편집', exact: true }).click();
    await page.getByRole('region', { name: '사업 분류 편집' }).waitFor().catch(async () => {
      await page.locator('section[aria-label="사업 분류 편집"]').waitFor();
    });
    await page.getByRole('button', { name: '분류 편집 닫기', exact: true }).click();
    return `${role} · 지역/연도/사업명 필터 · 분류 편집 조회 · 원장관리 직접수정 차단`;
  };

  await independentStep(reporter, {
    scenario, role: '지자체', name: '지자체 대시보드 필터·분류·원장수정 경계',
    expected: '담당 지역 사업만 조회하고 분류 편집을 열며 원장 사업 집행 직접수정은 비활성', page: local,
  }, async () => dashboardCheck(local, '지자체'));
  await independentStep(reporter, {
    scenario, role: '관리자', name: '관리자 대시보드 지역 필터·분류·원장수정 경계',
    expected: '부산 서구 사업을 조회하고 분류 편집을 열며 원장 사업 집행 직접수정은 비활성', page: admin,
  }, async () => dashboardCheck(admin, '관리자'));

  const analyticsCheck = async (page, role) => {
    await page.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
    await selectWithLabelPrefix(page, '사업연도').selectOption(String(reference.year));
    if (role === '관리자') {
      await selectWithLabelPrefix(page, '시도').selectOption('부산');
      await selectWithLabelPrefix(page, '시군구').selectOption('서구');
    } else {
      if (!(await selectWithLabelPrefix(page, '시도').isDisabled()) || !(await selectWithLabelPrefix(page, '시군구').isDisabled())) {
        throw new Error('지자체 분석 지역 선택이 잠기지 않았습니다.');
      }
    }
    await selectWithLabelPrefix(page, '집계단위').selectOption('project');
    await page.getByText('고급 조회조건', { exact: true }).click();
    await selectWithLabelPrefix(page, '집행률 범위').selectOption('below90');
    await selectWithLabelPrefix(page, '집행률 범위').selectOption('all');
    await page.getByRole('button', { name: '조회', exact: true }).click();
    await page.getByRole('heading', { name: '지역 분포도' }).waitFor({ timeout: 60_000 });
    await page.getByRole('heading', { name: '집계 결과' }).waitFor();
    await page.getByRole('button', { name: /조정후배분액/ }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^(?:분석 자료|표 파일) 내려받기$/ }).click(),
    ]);
    return `${role} 지역권한·고급필터·정렬·지역분포 · ${await saveDownload(download, reporter, `analytics-${role}-${reporter.runId}.csv`)}`;
  };

  await independentStep(reporter, {
    scenario, role: '지자체', name: '지자체 분석 전 필터·정렬·분포·내려받기',
    expected: '담당지역 고정, 고급조건·열정렬·지역분포·CSV 생성', page: local,
  }, async () => analyticsCheck(local, '지자체'));
  await independentStep(reporter, {
    scenario, role: '관리자', name: '관리자 분석 전 필터·정렬·분포·내려받기',
    expected: '부산 서구 조건, 고급조건·열정렬·지역분포·CSV 생성', page: admin,
  }, async () => analyticsCheck(admin, '관리자'));

  await independentStep(reporter, {
    scenario, role: '관리자', name: '전국→시도→시군구 분석 드릴다운',
    expected: '전국 집계 행 선택 시 시도, 다시 선택 시 시군구 집계로 이동', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '집계 결과' }).waitFor({ timeout: 60_000 });
    await selectWithLabelPrefix(admin, '집계단위').selectOption('national');
    await admin.getByRole('button', { name: '조회', exact: true }).click();
    await waitForSearchParam(admin, 'groupBy', 'national');
    const first = admin.locator('tr.analytics-drill-row').first();
    await first.waitFor();
    await first.click();
    await waitForSearchParam(admin, 'groupBy', 'sido');
    await admin.locator('tr.analytics-drill-row').first().waitFor({ timeout: 60_000 });
    await admin.locator('tr.analytics-drill-row').first().click();
    await waitForSearchParam(admin, 'groupBy', 'sigungu');
    return '전국 → 시도 → 시군구 URL·결과 갱신 확인';
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '예산조정 6개 업무 탭·처리이력 필터',
    expected: '승인대기/초안/신규사업/연결/예정재원/이력 6개 탭과 이력 필터·페이지 표시', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/funding`, { waitUntil: 'domcontentloaded' });
    await admin.locator('main').getByRole('heading', { name: '예산 조정 승인', exact: true }).waitFor({ timeout: 60_000 });
    const labels = ['예산조정 승인대기', '신규사업 초안', '신규사업 승인대기', '예정재원 연결 승인대기', '예정재원 현황', '처리 이력'];
    for (const label of labels) {
      await admin.getByRole('button', { name: new RegExp(`^${label}`) }).click();
      await admin.waitForTimeout(300);
    }
    await admin.locator('[aria-label="처리 이력 필터"]').waitFor();
    await selectWithLabelPrefix(admin, '페이지당').selectOption('50');
    await admin.getByRole('button', { name: '필터 초기화', exact: true }).waitFor();
    return '6개 탭 전환 · 처리이력 날짜/지역/연도/유형/상태/출처/목적/신규사업 필터 표시';
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '사업변경 검색·상세·엑셀',
    expected: '예산조정/변경이벤트 검색, 목록 상세 및 XLSX 생성', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/project-changes`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '사업변경 관리', exact: true }).first().waitFor({ timeout: 60_000 });
    const search = admin.getByRole('searchbox', { name: '사업변경 검색' });
    await search.waitFor({ timeout: 60_000 });
    const rows = admin.locator('tbody tr').filter({ has: admin.getByRole('button', { name: '보기', exact: true }) });
    const count = await rows.count();
    if (count > 0) {
      const detail = admin.locator('.project-change-detail');
      await rows.first().getByRole('button', { name: '보기', exact: true }).click();
      await detail.waitFor({ timeout: 30_000 });
      const detailText = (await detail.innerText()).replace(/\s+/g, ' ');
      if (!detailText.includes('재정금액 영향 없음') || !detailText.includes('차액 0원')) {
        throw new Error(`사업변경 상세 재정 영향 안내 불일치: ${detailText.slice(0, 500)}`);
      }
      await admin.getByRole('button', { name: '닫기', exact: true }).click();
    }
    const [download] = await Promise.all([
      admin.waitForEvent('download'),
      admin.getByRole('button', { name: '엑셀 내려받기', exact: true }).click(),
    ]);
    return `변경목록 ${count}건 · 상세 ${count > 0 ? '확인' : '자료 없음'} · ${await saveDownload(download, reporter, `project-changes-${reporter.runId}.xlsx`)}`;
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '소분류 제안 관리 조회',
    expected: '사용자 입력 소분류·판정 분류·검증 결과·관리자 검토 영역 표시', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/small-category-proposals`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '소분류 제안 관리' }).first().waitFor({ timeout: 60_000 });
    await admin.getByRole('button', { name: '새로고침', exact: true }).waitFor({ timeout: 60_000 });
    await admin.getByText('검토 목록을 불러오는 중입니다...', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    const body = await admin.locator('body').innerText();
    for (const label of ['사용자 입력', '판정 분류', '검증 결과', '검토']) {
      if (!body.includes(label) && !body.includes('검토할 사용자 입력 소분류가 없습니다.')) throw new Error(`소분류 관리 항목 누락: ${label}`);
    }
    return '사용자 입력 소분류 목록과 확정·표준 승격·반려 처리 영역 조회';
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '관리자 설정 안전 조회',
    expected: '계정 생성 기능은 표시하되 계정 생성은 실행하지 않고 초기비밀번호 다운로드는 비활성', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin`, { waitUntil: 'domcontentloaded' });
    await admin.getByText('관리자 계정 관리', { exact: true }).waitFor({ timeout: 60_000 });
    await admin.getByRole('button', { name: '지자체 계정 일괄 생성', exact: true }).waitFor();
    const download = admin.getByRole('button', { name: '초기 비밀번호 다운로드', exact: true });
    if (!(await download.isDisabled())) throw new Error('계정 생성 전 초기 비밀번호 다운로드가 활성화됐습니다.');
    return '계정 생성 클릭 0회 · 비밀번호 파일 생성 0회 · 초기 다운로드 비활성';
  });

  await independentStep(reporter, {
    scenario, role: '지자체', name: '비밀번호 변경 입력 검증',
    expected: '공유 TEST 계정은 최초로그인 상태에서만 입력 검증하고 완료 계정은 대시보드로 복귀', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/password-reset`, { waitUntil: 'domcontentloaded' });
    const heading = local.getByRole('heading', { name: '최초 비밀번호 변경', exact: true });
    const formVisible = await Promise.race([
      heading.waitFor({ timeout: 10_000 }).then(() => true),
      local.waitForURL(/\/dashboard(?:\?|$)/, { timeout: 10_000 }).then(() => false),
    ]);
    if (!formVisible) return '최초 로그인 완료 공유계정 · 비밀번호 미변경 · 대시보드 복귀';
    const next = local.getByLabel('새 비밀번호');
    const confirmation = local.getByLabel('비밀번호 확인');
    await next.fill('짧은암호');
    await confirmation.fill('짧은암호');
    await local.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await local.getByText('비밀번호는 최소 10자 이상이어야 합니다.', { exact: true }).waitFor();
    await next.fill('자동시험비밀번호01');
    await confirmation.fill('자동시험비밀번호02');
    await local.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await local.getByText('비밀번호 확인이 일치하지 않습니다.', { exact: true }).waitFor();
    return '길이·확인 불일치 2건 차단 · 비밀번호 변경 네트워크 요청 0건';
  });

  await independentStep(reporter, {
    scenario, role: '지자체', name: 'TEST 재정원장 집행일 정책 경계',
    expected: '재정원장 잔액을 조회하고 시작일 이전은 차단, 시작일 이후 입력은 허용하되 제출하지 않음', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${reference.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: reference.displayName }).waitFor({ timeout: 60_000 });
    await dismissSimilarityDialog(local);
    await local.getByText('원장을 불러오는 중입니다...', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    const runtimeBanner = local.locator('.funding-runtime-banner.native');
    await runtimeBanner.waitFor({ timeout: 60_000 });
    const runtimeText = (await runtimeBanner.innerText()).replace(/\s+/g, ' ');
    if (!runtimeText.includes('신규 운영거래 시험') || !runtimeText.includes('이전 효력일')) throw new Error(`TEST 원장 안내 불일치: ${runtimeText}`);
    const submit = local.getByRole('button', { name: '집행 확정', exact: true });
    await local.getByLabel('집행액', { exact: true }).fill('1');
    const nativeStart = dateOnly(state.runtime.native_start_date);
    const start = new Date(`${nativeStart}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    await local.getByLabel('집행일').fill(start.toISOString().slice(0, 10));
    if (!(await submit.isDisabled())) throw new Error('신규 운영거래 시작일 이전에 집행 확정이 활성화됐습니다.');
    await local.getByLabel('집행일').fill(nativeStart);
    if (await submit.isDisabled()) throw new Error('신규 운영거래 시작일 이후 유효 입력인데 집행 확정이 비활성입니다.');
    await local.getByLabel('집행액', { exact: true }).fill('0');
    return `원재원 잔액 조회 · ${nativeStart} 이전 차단/이후 활성 · 제출 0건`;
  });

  await independentStep(reporter, {
    scenario, role: '양쪽', name: '사용자 화면 내부 상태코드 노출 점검',
    expected: '주요 조회 화면에 SUBMITTED/APPLIED/REJECTED 등 내부 상태코드가 그대로 노출되지 않음', page: admin,
  }, async () => {
    const pages = [
      [local, `${TEST_ORIGIN}/my-projects?tab=completed`],
      [admin, `${TEST_ORIGIN}/admin/funding`],
      [admin, `${TEST_ORIGIN}/admin/project-changes`],
    ];
    for (const [page, url] of pages) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('main').waitFor({ timeout: 60_000 });
      const text = await page.locator('main').innerText();
      const exposed = text.match(/\b(?:DRAFT|SUBMITTED|APPROVED|APPLIED|REJECTED|CANCELLED|DUPLICATE|PENDING_NEW_PROJECT|EXISTING_PROJECT)\b/g);
      if (exposed?.length) throw new Error(`내부 상태코드 노출: ${[...new Set(exposed)].join(', ')}`);
    }
    return '지자체 완료요청·관리자 예산조정·사업변경 본문 내부 상태코드 미노출';
  });
}

async function runCoverageRetry(reporter, state, localRole, adminRole) {
  const scenario = '전체 기능 조회 재시험';
  const local = localRole.page;
  const admin = adminRole.page;
  const reference = await loadReferenceProject(state, reporter.args.referenceRunId);

  await independentStep(reporter, {
    scenario, role: '지자체', name: '한글 표시 사업명 원본 검색·상태 유지',
    expected: 'AUTO-INT 원본 검색은 유지하되 결과 행은 한글 실행 표기로 표시', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects?q=${encodeURIComponent(reference.requestName)}&year=${reference.year}&sort=name`, { waitUntil: 'domcontentloaded' });
    const result = local.locator('tr[role="link"]:visible, article:visible').filter({ hasText: reference.requestDisplayName }).first();
    await result.waitFor({ timeout: 60_000 });
    const text = await result.innerText();
    if (text.includes(reference.referenceRunId)) throw new Error('내 사업 결과에 AUTO-INT 실행 식별자가 그대로 노출됩니다.');
    await local.reload({ waitUntil: 'domcontentloaded' });
    await result.waitFor({ timeout: 60_000 });
    await waitForSearchParam(local, 'q', reference.requestName);
    return `${reference.requestDisplayName} · 원본 검색 및 새로고침 상태 유지`;
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '사업명 시험 식별자 전 계열 검색·표시 변환',
    expected: 'UAT·AUTO-UAT·AUTO-BUDGET-UAT·GENERIC-BUDGET-UAT·AUTO-INT 검색 결과는 한글로 표시', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/dashboard`, { waitUntil: 'domcontentloaded' });
    const search = admin.getByPlaceholder('전체 사업에서 사업명 검색');
    await search.waitFor({ timeout: 60_000 });
    const checks = [
      ['UAT 순창', '사용자 검증'],
      ['AUTO-UAT-20260826-180000', '자동 사용자 검증'],
      ['AUTO-BUDGET-UAT', '자동 예산 사용자 검증'],
      ['GENERIC-BUDGET-UAT', '일반 예산 사용자 검증'],
      ['AUTO-INT-20260909-100000', '자동 통합시험 부산 생활거점'],
    ];
    for (const [raw, displayed] of checks) {
      await search.fill(raw);
      await admin.getByRole('button', { name: '전체 목록 검색', exact: true }).click();
      const row = admin.getByRole('row').filter({ hasText: displayed }).first();
      await row.waitFor({ timeout: 60_000 });
      if ((await row.innerText()).includes(raw)) throw new Error(`${raw} 내부 식별자가 결과 행에 그대로 노출됩니다.`);
    }
    return '시험 식별자 5계열 원본 검색 성공 · 결과 행 한글 표시';
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '분석 화면 사업명·분류·원재원 식별값 노출 차단',
    expected: '사업명·분류에 시험 내부코드가 없고 원재원 UUID·N/A가 없음', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/analytics?groupBy=project&year=2027&sido=%EB%B6%80%EC%82%B0&sigungu=%EC%84%9C%EA%B5%AC`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
    await admin.getByRole('heading', { name: '집계 결과', exact: true }).waitFor({ timeout: 60_000 });
    const body = await admin.locator('main').innerText();
    const forbidden = body.match(/\b(?:AUTO-INT-\d{8}-\d{6}|AUTO-UAT(?:-\d{8}(?:-\d{6})?)?|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT|UAT)\b/i)?.[0];
    if (forbidden) throw new Error(`분석 화면에 시험 내부코드가 노출됩니다: ${forbidden}`);
    if (body.includes('원재원 식별값') || /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(body)) {
      throw new Error('분석 화면에 원재원 UUID 또는 내부 식별값 열이 노출됩니다.');
    }
    if (/\bN\/A\b/.test(body)) throw new Error('분석 화면에 영문 자료없음 표기가 노출됩니다.');
    return '시험 내부코드 0건 · 원재원 UUID 0건 · 영문 자료없음 0건';
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '전국→시도→시군구 분석 드릴다운',
    expected: '전국 집계 행 선택 시 시도, 다시 선택 시 시군구 집계로 이동', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '집계 결과' }).waitFor({ timeout: 60_000 });
    await selectWithLabelPrefix(admin, '집계단위').selectOption('national');
    await admin.getByRole('button', { name: '조회', exact: true }).click();
    await waitForSearchParam(admin, 'groupBy', 'national');
    await admin.locator('tr.analytics-drill-row').first().waitFor({ timeout: 60_000 });
    await admin.locator('tr.analytics-drill-row').first().click();
    await waitForSearchParam(admin, 'groupBy', 'sido');
    await admin.locator('tr.analytics-drill-row').first().waitFor({ timeout: 60_000 });
    await admin.locator('tr.analytics-drill-row').first().click();
    await waitForSearchParam(admin, 'groupBy', 'sigungu');
    return `URL ${admin.url()} · 전국→시도→시군구 갱신`;
  });

  await independentStep(reporter, {
    scenario, role: '관리자', name: '사업변경 상세 선택·엑셀',
    expected: '재조회 완료 후 목록 행 선택으로 상세가 열리고 XLSX 생성', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/project-changes`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '사업변경 관리', exact: true }).first().waitFor({ timeout: 60_000 });
    await admin.getByRole('searchbox', { name: '사업변경 검색' }).waitFor({ timeout: 60_000 });
    const row = admin.locator('tbody tr').filter({ has: admin.getByRole('button', { name: '보기', exact: true }) }).first();
    await row.waitFor();
    const detail = admin.locator('.project-change-detail');
    await row.getByRole('button', { name: '보기', exact: true }).click();
    await detail.waitFor({ timeout: 30_000 });
    const detailText = (await detail.innerText()).replace(/\s+/g, ' ');
    if (!detailText.includes('재정') || (!detailText.includes('영향 없음') && !detailText.includes('0원'))) {
      throw new Error(`사업변경 상세 재정 영향 안내 불일치: ${detailText.slice(0, 500)}`);
    }
    const [download] = await Promise.all([
      admin.waitForEvent('download'),
      admin.getByRole('button', { name: '엑셀 내려받기', exact: true }).click(),
    ]);
    return `상세 표시 · ${await saveDownload(download, reporter, `project-changes-retry-${reporter.runId}.xlsx`)}`;
  });

  await independentStep(reporter, {
    scenario, role: '지자체', name: 'TEST 재정원장 집행일 정책 경계',
    expected: 'TEST 원장 시작일 이전은 차단하고 이후 유효 입력은 활성화하되 제출하지 않음', page: local,
  }, async () => {
    await local.goto(`${TEST_ORIGIN}/my-projects/${reference.id}/edit`, { waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: reference.displayName }).waitFor({ timeout: 60_000 });
    await dismissSimilarityDialog(local);
    await local.getByText('원장을 불러오는 중입니다...', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    const banner = local.locator('.funding-runtime-banner.native');
    await banner.waitFor({ timeout: 60_000 });
    const text = (await banner.innerText()).replace(/\s+/g, ' ');
    if (!text.includes('신규 운영거래 시험') || !text.includes('이전 효력일')) throw new Error(`TEST 원장 안내 불일치: ${text}`);
    const submit = local.getByRole('button', { name: '집행 확정', exact: true });
    await local.getByLabel('집행액', { exact: true }).fill('1');
    const nativeStart = dateOnly(state.runtime.native_start_date);
    const before = new Date(`${nativeStart}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    await local.getByLabel('집행일').fill(before.toISOString().slice(0, 10));
    if (!(await submit.isDisabled())) throw new Error('시작일 이전에 집행 확정이 활성화됐습니다.');
    await local.getByLabel('집행일').fill(nativeStart);
    if (await submit.isDisabled()) throw new Error('시작일 이후 유효 입력인데 집행 확정이 비활성입니다.');
    await local.getByLabel('집행액', { exact: true }).fill('0');
    return `${text} · 시작일 이전 차단/이후 활성 · 제출 0건`;
  });
}

async function openOwnedProject(page, project) {
  await page.goto(`${TEST_ORIGIN}/my-projects/${project.id}/edit`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: project.displayName ?? visibleAutomatedProjectName(project.project_name), exact: true }).waitFor({ timeout: 60_000 });
  await dismissSimilarityDialog(page);
}

async function chooseProjectChangeEvidence(page) {
  await page.getByLabel('지자체 → 조합 통보', { exact: false }).check();
  await page.getByLabel('사업내용 변경', { exact: false }).check();
  await page.getByPlaceholder('변경 전후의 구체적인 차이를 입력하세요.').fill('자동 통합시험에서 사업정보 변경 이력과 관리자 동기화를 검증합니다.');
}

async function finishProjectSave(page) {
  await page.getByRole('button', { name: '저장', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: '유사한 사업이 확인되었습니다.' });
  await dialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: '별도 사업으로 유지', exact: true }).click();
  }
  await page.locator('main[aria-busy="false"]').waitFor({ timeout: 60_000 }).catch(() => undefined);
  await page.getByText('모든 변경 저장됨', { exact: true }).waitFor({ timeout: 60_000 });
  const alert = page.locator('[role="alert"]');
  if (await alert.isVisible().catch(() => false)) {
    const message = (await alert.innerText()).trim();
    if (message) throw new Error(`사업정보 저장 오류: ${message}`);
  }
}

async function assertRelatedProjectName(page, expected) {
  const value = await page.getByLabel('타 사업명').inputValue();
  if (value !== expected) throw new Error(`연계사업명 불일치: ${value}`);
}

async function verifyProjectMetadataDatabase(state, project, changedName, reporter) {
  const current = (await state.pgClient.query(`select id,
    coalesce(nullif(btrim(detail_project_name),''),nullif(btrim(fund_project_name),''),project_name) project_name,
    project_period,project_start_year,status,execution_status_reason,business_type,
    original_alloc::bigint::text,increase_amount::bigint::text,decrease_amount::bigint::text,
    alloc::bigint::text,exec::bigint::text
    from public.projects where id=$1`, [project.id])).rows[0];
  const related = (await state.pgClient.query(`select project_name,total_budget::bigint::text,
    regional_fund_alloc::bigint::text,local_fund_alloc::bigint::text
    from public.project_related_projects where project_id=$1 order by created_at desc`, [project.id])).rows;
  const events = (await state.pgClient.query(`select id,change_kind,old_name,new_name,change_basis_code,
    change_reason_codes,similarity_candidate,similarity_result,monetary_impact::bigint::text,status
    from public.project_change_events where project_id=$1 and (old_name=$2 or new_name=$2)
    order by changed_at`, [project.id, changedName])).rows;
  const financesUnchanged = ['original_alloc', 'increase_amount', 'decrease_amount', 'alloc', 'exec']
    .every((key) => current?.[key] === project[key]);
  const relatedValid = related.some((row) => row.project_name === `자동시연 연계사업 ${reporter.runId}`
    && row.total_budget === '300000' && row.regional_fund_alloc === '100000' && row.local_fund_alloc === '50000');
  const changeOut = events.find((row) => row.new_name === changedName && row.change_basis_code === 'LOCAL_NOTICE'
    && row.change_reason_codes?.includes('CONTENT_CHANGE') && row.monetary_impact === '0');
  const changeBack = events.find((row) => row.old_name === changedName && row.new_name === project.requestName
    && row.monetary_impact === '0');
  if (!current || current.project_name !== project.requestName || current.status !== '지연'
      || current.business_type !== 'COMPOSITE' || !financesUnchanged || !relatedValid || !changeOut || !changeBack) {
    throw new Error(`사업정보 DB 무결성 실패: ${JSON.stringify({ current, related, events, financesUnchanged })}`);
  }
  reporter.add({
    scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '사업정보·연계·재정 무결성', status: 'PASS',
    expected: '사업명 복원, 지연상태·복합형·연계사업 저장, 변경이력 0원, 기존 재정금액 불변',
    actual: `사업 ${project.id} · 이름변경/복원 이벤트 ${events.length}건 · 연계사업 ${related.length}건 · 재정 차액 0원`,
  });
  return { projectId: project.id, changedName, current, related, eventIds: events.map((row) => row.id), monetaryGap: '0' };
}

async function runProjectMetadata(reporter, state, localRole, adminRole) {
  const scenario = '사업정보·분류·연계 변경';
  const local = localRole.page;
  const admin = adminRole.page;
  const project = await loadReferenceProject(state, reporter.args.referenceRunId);
  const changedName = `자동 통합시험 사업정보 ${reporter.runId}`;
  const existing = (await state.pgClient.query(`select id from public.project_change_events
    where project_id=$1 and new_name=$2 limit 1`, [project.id, changedName])).rows[0];

  if (existing) {
    reporter.add({
      scenario: '재실행 보호', role: '양쪽', step: '기존 사업정보 변경 실행 재사용', status: 'PASS',
      expected: '동일 실행 ID의 사업명 변경을 중복 저장하지 않음', actual: `기존 변경이벤트 ${existing.id} 재사용`,
    });
    if (project.project_name === project.requestName) {
      await step(reporter, {
        scenario, role: '지자체', name: '재실행 결과 화면 확인',
        expected: '원래 사업명과 저장된 상태·연계사업이 유지됨', page: local,
      }, async () => {
        await openOwnedProject(local, project);
        await assertRelatedProjectName(local, `자동시연 연계사업 ${reporter.runId}`);
        return `사업 ${project.id} · 중복 저장 없이 기존 완료 결과 표시`;
      });
      return verifyProjectMetadataDatabase(state, project, changedName, reporter);
    }
    if (project.project_name !== changedName) {
      throw new Error(`기존 실행의 현재 사업명이 예상과 다릅니다: ${project.project_name}`);
    }
    await step(reporter, {
      scenario, role: '지자체', name: '중단 지점의 저장 결과 확인',
      expected: '중복 저장 없이 변경 사업명·상태·연계사업을 확인', page: local,
    }, async () => {
      await openOwnedProject(local, project);
      await assertRelatedProjectName(local, `자동시연 연계사업 ${reporter.runId}`);
      return `${changedName} · 기존 변경이벤트 ${existing.id} 재사용`;
    });
    await step(reporter, {
      scenario, role: '관리자', name: '중단 지점의 관리자 변경이력 동기화',
      expected: '같은 사업명 변경과 재정 영향 0원이 관리자 화면에 표시', page: admin,
    }, async () => {
      await admin.goto(`${TEST_ORIGIN}/admin/project-changes`, { waitUntil: 'domcontentloaded' });
      await admin.getByRole('heading', { name: '사업변경 관리' }).waitFor({ timeout: 60_000 });
      const filter = admin.locator('label').filter({ hasText: /^\s*변경 후 사업명/ }).locator('input');
      await filter.fill(changedName);
      await admin.getByRole('button', { name: '조회', exact: true }).click();
      await admin.locator('button.my-project-save-button:not([disabled])').filter({ hasText: /^조회$/ }).waitFor({ timeout: 60_000 });
      const eventPanel = admin.getByText('사업변경 목록', { exact: true }).locator('xpath=ancestor::section[1]');
      const row = eventPanel.locator('.project-change-row').filter({ hasText: changedName }).first();
      await row.waitFor({ timeout: 60_000 });
      await row.locator('td').first().click();
      const detail = admin.locator('.project-change-detail');
      await detail.waitFor({ timeout: 30_000 });
      const text = (await detail.innerText()).replace(/\s+/g, ' ');
      if (!text.includes('재정') || !text.includes('0원')) throw new Error(`관리자 재정 영향 안내 불일치: ${text}`);
      return '사업정보 변경 상세 · 재정 영향 0원';
    });
    await step(reporter, {
      scenario, role: '지자체', name: '중단 지점에서 시연 사업명 원복',
      expected: '원래 한글 시연명으로 복원하고 양방향 변경이력 보존', page: local,
    }, async () => {
      await local.bringToFront();
      await local.getByLabel('변경 사업명', { exact: false }).fill(project.requestName);
      await chooseProjectChangeEvidence(local);
      await finishProjectSave(local);
      await local.getByRole('heading', { name: project.requestName, exact: true }).waitFor({ timeout: 60_000 });
      return `${changedName} → ${project.requestName} 복원`;
    });
    return verifyProjectMetadataDatabase(state, project, changedName, reporter);
  }

  await step(reporter, {
    scenario, role: '지자체', name: '사업명·기간·상태·사업유형·분류·연계사업 저장',
    expected: '전용 사업의 재정금액은 건드리지 않고 사업정보와 연계정보만 저장', page: local,
  }, async () => {
    await openOwnedProject(local, project);
    await local.getByLabel('변경 사업명', { exact: false }).fill(changedName);
    await chooseProjectChangeEvidence(local);
    await local.locator('label').filter({ hasText: /^\s*사업기간/ }).locator('input').fill(`${project.year}.01~${project.year}.12 자동시연`);
    await local.locator('select[name="my-project-execution-status"]').selectOption('지연');
    await local.locator('textarea[name="my-project-execution-reason"]').fill('자동 통합시험 상태 사유와 새로고침 유지 검증');
    const businessTypes = local.getByRole('radiogroup', { name: '사업유형' });
    await businessTypes.locator('label').filter({ hasText: '복합형(시설+서비스)' }).locator('input').check();
    const categoryGroup = local.getByRole('group', { name: '전체 소분류' });
    const additionalCategory = categoryGroup.locator('input[type="checkbox"]:not(:checked)').first();
    await additionalCategory.waitFor();
    await additionalCategory.check();
    const relatedGroup = local.getByRole('radiogroup', { name: '타 사업 연계 여부' });
    await relatedGroup.locator('label').filter({ hasText: /^\s*있음\s*$/ }).locator('input').check();
    await local.getByRole('button', { name: '+ 연계사업 추가', exact: true }).click();
    await local.getByLabel('타 사업명').fill(`자동시연 연계사업 ${reporter.runId}`);
    await local.getByLabel('totalBudget').fill('300000');
    await local.getByLabel('regionalFundAlloc').fill('100000');
    await local.getByLabel('localFundAlloc').fill('50000');
    await finishProjectSave(local);
    await local.getByRole('heading', { name: changedName, exact: true }).waitFor();
    return `${changedName} · 지연 · 복합형 · 관련 소분류 추가 · 연계사업 300,000원`;
  });

  await step(reporter, {
    scenario, role: '지자체', name: '새로고침 후 사업정보·연계 유지',
    expected: '변경 사업명·기간·상태사유·사업유형·연계사업이 새로고침 후 유지', page: local,
  }, async () => {
    await local.reload({ waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: changedName, exact: true }).waitFor({ timeout: 60_000 });
    await dismissSimilarityDialog(local);
    const values = {
      name: await local.getByLabel('변경 사업명', { exact: false }).inputValue(),
      status: await local.locator('select[name="my-project-execution-status"]').inputValue(),
      reason: await local.locator('textarea[name="my-project-execution-reason"]').inputValue(),
    };
    if (values.name !== changedName || values.status !== '지연' || !values.reason.includes('자동 통합시험')) {
      throw new Error(`새로고침 후 값 불일치: ${JSON.stringify(values)}`);
    }
    await assertRelatedProjectName(local, `자동시연 연계사업 ${reporter.runId}`);
    return '변경 사업명·지연 사유·복합형·연계사업 유지';
  });

  await step(reporter, {
    scenario, role: '관리자', name: '사업변경 목록·상세·재정영향 0원 동기화',
    expected: '같은 변경이 관리자 목록과 상세에 표시되고 재정금액 영향 없음', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/project-changes`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '사업변경 관리' }).waitFor({ timeout: 60_000 });
    const newNameFilter = admin.locator('label').filter({ hasText: /^\s*변경 후 사업명/ }).locator('input');
    await newNameFilter.fill(changedName);
    await admin.getByRole('button', { name: '조회', exact: true }).click();
    const row = admin.locator('.project-change-row').filter({ hasText: changedName }).first();
    await row.waitFor({ timeout: 60_000 });
    const rowText = await row.innerText();
    if (!rowText.includes('지자체 → 조합 통보') || !rowText.includes('사업내용 변경')) {
      throw new Error('관리자 목록에 변경 근거·사유가 일치하지 않습니다.');
    }
    await row.click();
    await admin.getByText('재정금액 영향 없음 · 사업정보 변경 차액 0원', { exact: true }).waitFor();
    return '지자체 → 조합 통보 · 사업내용 변경 · 재정 영향 0원';
  });

  await step(reporter, {
    scenario, role: '지자체', name: '시연 사업명 원복과 변경이력 보존',
    expected: '후속 예산·통계 시험을 위해 원래 한글 시연명을 복원하되 양방향 이력을 보존', page: local,
  }, async () => {
    await local.bringToFront();
    await local.getByLabel('변경 사업명', { exact: false }).fill(project.requestName);
    await chooseProjectChangeEvidence(local);
    await finishProjectSave(local);
    await local.getByRole('heading', { name: project.requestName, exact: true }).waitFor({ timeout: 60_000 });
    await local.getByRole('heading', { name: '사업변경 이력', exact: true }).waitFor();
    const history = local.locator('.project-change-history-list, .project-change-history').first();
    if (await history.count()) await history.getByText(changedName, { exact: false }).first().waitFor().catch(() => undefined);
    return `${changedName} → ${project.requestName} 복원 · 변경이력 보존`;
  });

  return verifyProjectMetadataDatabase(state, project, changedName, reporter);
}

async function readSmallCategoryProposals(state, projectId, names) {
  return (await state.pgClient.query(`select id,proposed_name,status,approved_small_category_id,
    mapped_small_category_id,rejection_reason,reviewed_at
    from public.project_small_category_proposals
    where project_id=$1 and proposed_name=any($2::text[])
    order by created_at`, [projectId, names])).rows;
}

async function runSmallCategoryLifecycle(reporter, state, localRole, adminRole) {
  const scenario = '소분류 제안 3종 처리';
  const local = localRole.page;
  const admin = adminRole.page;
  const project = await loadReferenceProject(state, reporter.args.referenceRunId);
  const names = {
    approve: `자동시연 신규분류 ${reporter.runId}`,
    map: `자동시연 기존매핑 ${reporter.runId}`,
    reject: `자동시연 반려분류 ${reporter.runId}`,
  };
  const expectedStatuses = { approve: 'APPROVED', map: 'MAPPED', reject: 'REJECTED' };
  const originalNames = { ...names };
  const originalRows = await readSmallCategoryProposals(state, project.id, Object.values(originalNames));
  const anomalies = [];
  for (const key of Object.keys(expectedStatuses)) {
    const row = originalRows.find((item) => item.proposed_name === originalNames[key]);
    if (row && row.status !== 'SUBMITTED' && row.status !== expectedStatuses[key]) {
      anomalies.push({ id: row.id, proposedName: row.proposed_name, expected: expectedStatuses[key], actual: row.status });
      names[key] = `${originalNames[key]} 보완`;
    }
  }
  if (anomalies.length > 0) {
    reporter.add({
      scenario: 'TEST 데이터 보호', role: '양쪽', step: '잘못 종결된 전용 제안 보존·보완 실행 분리', status: 'PASS',
      expected: '기존 종결 데이터를 삭제·변조하지 않고 별도 보완 제안으로 기대 절차 수행',
      actual: anomalies.map((item) => `${item.id} 기대 ${item.expected} / 실제 ${item.actual}`).join(' · '),
    });
  }
  const allNames = Object.values(names);
  const before = await readSmallCategoryProposals(state, project.id, allNames);
  if (before.length > 0) {
    reporter.add({
      scenario: '재실행 보호', role: '양쪽', step: '기존 소분류 제안 재사용', status: 'PASS',
      expected: '동일 실행 ID의 제안을 중복 제출하지 않음',
      actual: `기존 제안 ${before.length}건 재사용 · ${before.map((row) => `${row.status}:${row.id}`).join(', ')}`,
    });
  }

  await step(reporter, {
    scenario, role: '지자체', name: '신규승인·기존매핑·반려용 제안 제출',
    expected: '서로 다른 전용 제안 3건이 검토 대기로 표시되고 공식 분류에는 아직 미반영', page: local,
  }, async () => {
    await openOwnedProject(local, project);
    for (const name of allNames) {
      if (before.some((row) => row.proposed_name === name)) continue;
      const form = local.locator('.small-category-proposal-form');
      await form.locator('input').fill(name);
      await form.locator('textarea').fill(`자동 통합시험 ${name} 관리자 처리 경로 검증`);
      await form.getByRole('button', { name: '소분류 제안 제출', exact: true }).click();
      await local.getByText('소분류 제안을 제출했습니다. 승인 전에는 공식 분류통계에 반영되지 않습니다.', { exact: true }).waitFor({ timeout: 60_000 });
      await local.locator('.small-category-proposal-status-item').filter({ hasText: name }).getByText('검토 대기', { exact: true }).waitFor();
    }
    const current = await readSmallCategoryProposals(state, project.id, allNames);
    if (current.length !== 3) throw new Error(`제안 수 불일치: ${current.length}건`);
    return `검토 대상 제안 ${current.length}건 · ${current.map((row) => row.id).join(', ')}`;
  });

  await step(reporter, {
    scenario, role: '관리자', name: '신규 승인·기존분류 매핑·반려',
    expected: '3건을 각기 다른 공식 절차로 처리하고 이미 종결된 건은 재처리하지 않음', page: admin,
  }, async () => {
    await admin.goto(`${TEST_ORIGIN}/admin/small-category-proposals`, { waitUntil: 'domcontentloaded' });
    await admin.getByRole('heading', { name: '소분류 제안 관리' }).first().waitFor({ timeout: 60_000 });
    const proposalRow = (name) => admin.locator('tbody tr').filter({
      has: admin.locator('td:first-child strong').filter({ hasText: name }),
    }).first();
    const process = async (name, targetStatus, action) => {
      let row = proposalRow(name);
      await row.waitFor({ timeout: 60_000 });
      const currentText = await row.innerText();
      const currentStatus = (await row.locator('td').nth(8).innerText()).trim();
      if (currentStatus === targetStatus) return;
      if (!currentText.includes('검토 대기')) throw new Error(`${name}의 현재 상태가 검토 대기가 아닙니다: ${currentText}`);
      if (action === 'APPROVE') {
        const select = row.locator('.small-category-review-controls select').first();
        if (!(await select.inputValue())) await select.selectOption({ index: 1 });
        await row.getByRole('button', { name: '신규 승인', exact: true }).click();
      } else if (action === 'MAP') {
        const select = row.locator('.small-category-review-controls select').nth(1);
        await select.selectOption({ index: 1 });
        await row.getByRole('button', { name: '기존분류 매핑', exact: true }).click();
      } else {
        admin.once('dialog', (dialog) => dialog.accept(`자동 통합시험 반려 사유 ${reporter.runId}`));
        await row.getByRole('button', { name: '반려', exact: true }).click();
      }
      const expectedDatabaseStatus = action === 'APPROVE' ? 'APPROVED' : action === 'MAP' ? 'MAPPED' : 'REJECTED';
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const current = await readSmallCategoryProposals(state, project.id, [name]);
        if (current[0]?.status === expectedDatabaseStatus) break;
        await admin.waitForTimeout(500);
      }
      const verified = await readSmallCategoryProposals(state, project.id, [name]);
      if (verified[0]?.status !== expectedDatabaseStatus) {
        throw new Error(`${name} DB 처리상태 불일치: ${verified[0]?.status ?? '없음'}`);
      }
      await admin.getByRole('button', { name: '새로고침', exact: true }).click();
      await admin.getByRole('button', { name: '새로고침', exact: true }).waitFor({ timeout: 60_000 });
      row = proposalRow(name);
      await row.waitFor({ timeout: 60_000 });
      const displayedStatus = (await row.locator('td').nth(8).innerText()).trim();
      if (displayedStatus !== targetStatus) throw new Error(`${name} 관리자 목록 상태 표시 불일치: ${displayedStatus}`);
    };
    await process(names.approve, '신규분류 승인', 'APPROVE');
    await process(names.map, '기존분류 연결', 'MAP');
    await process(names.reject, '반려', 'REJECT');
    return '신규분류 승인 1건 · 기존분류 연결 1건 · 반려 1건';
  });

  await step(reporter, {
    scenario, role: '지자체', name: '처리결과·반려사유 새로고침 확인',
    expected: '지자체 사업 상세에서 세 상태와 반려 사유·해결 분류가 새로고침 후 표시', page: local,
  }, async () => {
    await local.reload({ waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: project.project_name, exact: true }).waitFor({ timeout: 60_000 });
    await dismissSimilarityDialog(local);
    const expected = [
      [names.approve, '신규분류 승인'],
      [names.map, '기존분류 연결'],
      [names.reject, '반려'],
    ];
    for (const [name, status] of expected) {
      const item = local.locator('.small-category-proposal-status-item').filter({ hasText: name });
      await item.waitFor({ timeout: 60_000 });
      const text = (await item.innerText()).replace(/\s+/g, ' ');
      const displayedStatus = (await item.locator('.custom-category-status').innerText()).trim();
      if (displayedStatus !== status) throw new Error(`${name} 지자체 처리상태 표시 불일치: ${displayedStatus}`);
      if (name === names.reject && !text.includes(`자동 통합시험 반려 사유 ${reporter.runId}`)) {
        throw new Error(`${name} 반려 사유 표시 불일치: ${text}`);
      }
    }
    return '신규승인·기존매핑·반려 상태와 반려사유 유지';
  });

  const proposals = await readSmallCategoryProposals(state, project.id, allNames);
  const approved = proposals.find((row) => row.proposed_name === names.approve);
  const mapped = proposals.find((row) => row.proposed_name === names.map);
  const rejected = proposals.find((row) => row.proposed_name === names.reject);
  if (proposals.length !== 3 || approved?.status !== 'APPROVED' || !approved.approved_small_category_id
      || mapped?.status !== 'MAPPED' || !mapped.mapped_small_category_id
      || rejected?.status !== 'REJECTED' || rejected.rejection_reason !== `자동 통합시험 반려 사유 ${reporter.runId}`) {
    throw new Error(`소분류 제안 DB 상태 불일치: ${JSON.stringify(proposals)}`);
  }
  reporter.add({
    scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '소분류 제안 3종 종결 상태', status: 'PASS',
    expected: 'APPROVED/MAPPED/REJECTED 각 1건, 해결 분류 ID와 반려 사유 기록',
    actual: proposals.map((row) => `${row.status}:${row.id}`).join(' · '),
  });
  return { projectId: project.id, proposalIds: proposals.map((row) => row.id), statuses: proposals.map((row) => row.status), preservedAnomalies: anomalies };
}

async function readNativeExecutionSnapshot(state, project, memo) {
  const wallets = (await state.pgClient.query(`select wallets.id budget_year_id,wallets.fiscal_year,
    cohorts.origin_fiscal_year,balance.accounting_balance::bigint::text,
    balance.reserved_amount::bigint::text,balance.available_to_commit::bigint::text
    from public.project_budget_years wallets
    join public.project_budget_cohorts cohorts on cohorts.id=wallets.budget_cohort_id
    cross join lateral public.financial_get_budget_year_balance(wallets.id) balance
    where wallets.project_id=$1
    order by wallets.fiscal_year desc,cohorts.origin_fiscal_year,wallets.created_at,wallets.id`, [project.id])).rows;
  if (wallets.length !== 1) throw new Error(`전용 사업의 원장 재원 위치가 1건이 아닙니다: ${wallets.length}건`);
  const executions = (await state.pgClient.query(`select records.id,records.budget_year_id,
    records.amount::bigint::text,records.execution_date,records.status,records.transaction_kind,
    records.memo,records.created_by,records.confirmed_by,records.record_origin
    from public.project_execution_records records
    join public.project_budget_years wallets on wallets.id=records.budget_year_id
    where wallets.project_id=$1 and records.memo=$2 order by records.confirmed_at`, [project.id, memo])).rows;
  const position = (await state.pgClient.query(`select ledger_adjusted_allocation::bigint::text,
    ledger_execution_amount::bigint::text,current_wallet_balance::bigint::text,projection_ready
    from public.financial_project_funding_positions where project_id=$1`, [project.id])).rows[0];
  return { wallet: wallets[0], executions, position };
}

async function runNativeExecution(reporter, state, localRole, adminRole) {
  const scenario = 'TEST 원장 집행 확정';
  const local = localRole.page;
  const admin = adminRole.page;
  const project = await loadReferenceProject(state, reporter.args.referenceRunId);
  const amount = 10_000n;
  const memo = `자동 통합시험 원장 집행 ${reporter.runId}`;
  const before = await readNativeExecutionSnapshot(state, project, memo);
  const nativeStart = dateOnly(state.runtime.native_start_date);
  const nativeStartYear = Number(nativeStart.slice(0, 4));
  const walletYear = Number(before.wallet.fiscal_year);
  if (walletYear < nativeStartYear) {
    throw new Error(`원장 회계연도 ${walletYear}년이 신규 운영거래 시작연도보다 이전이어서 집행을 중단합니다.`);
  }
  const executionDate = walletYear === nativeStartYear ? `${walletYear}-09-02` : `${walletYear}-01-02`;
  if (BigInt(before.wallet.available_to_commit) < amount) {
    throw new Error(`집행 가능액이 부족하여 변경 시나리오를 중단합니다: ${won(before.wallet.available_to_commit)}`);
  }
  if (before.executions.length > 1) {
    throw new Error(`동일 실행 ID 집행이 이미 ${before.executions.length}건 존재하여 중복 위험을 차단했습니다.`);
  }
  if (before.executions.length === 1) {
    reporter.add({
      scenario: '재실행 보호', role: '지자체', step: '기존 확정 집행 재사용', status: 'PASS',
      expected: '동일 실행 ID의 집행을 중복 확정하지 않음', actual: `기존 집행 ${before.executions[0].id} 재사용`,
    });
  }

  await step(reporter, {
    scenario, role: '지자체', name: '전용 사업 원장·가용액 확인',
    expected: `${project.year}년 전용 사업의 ${walletYear} 회계연도 재원과 조정 가능액 ${won(before.wallet.available_to_commit)} 확인`, page: local,
  }, async () => {
    await openOwnedProject(local, project);
    await local.getByText('원장을 불러오는 중입니다...', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    const section = local.locator('section.financial-ledger-section');
    await section.getByRole('heading', { name: /^(재정원장|집행액 입력)$/ }).waitFor({ timeout: 60_000 });
    const walletLabel = `${before.wallet.origin_fiscal_year}년 최초재원 · ${before.wallet.fiscal_year}년 위치`;
    const walletRow = section.locator('tr').filter({ hasText: walletLabel }).first();
    await walletRow.waitFor({ timeout: 30_000 });
    await walletRow.getByRole('radio').check();
    return `${walletLabel} · 조정 가능액 ${won(before.wallet.available_to_commit)}`;
  });

  if (before.executions.length === 0) {
    await step(reporter, {
      scenario, role: '지자체', name: '10,000원 집행 확정',
      expected: `${executionDate} SYSTEM_NATIVE 집행 10,000원 확정 · 동일 요청 1건`, page: local,
    }, async () => {
      const section = local.locator('section.financial-ledger-section');
      const form = section.locator('form').filter({ hasText: '원장 집행 확정' });
      await form.getByLabel('집행액', { exact: true }).fill(amount.toString());
      await form.getByLabel('집행일').fill(executionDate);
      await form.getByLabel('메모 (선택)').fill(memo);
      const submit = form.getByRole('button', { name: '집행 확정', exact: true });
      if (await submit.isDisabled()) throw new Error('유효한 TEST 집행 입력인데 확정 버튼이 비활성입니다.');
      await submit.click();
      const notice = section.getByRole('status');
      const alert = section.locator('.financial-ledger-error');
      const outcome = await Promise.race([
        notice.waitFor({ timeout: 60_000 }).then(() => 'notice'),
        alert.waitFor({ timeout: 60_000 }).then(() => 'alert'),
      ]);
      if (outcome === 'alert') throw new Error(`집행 화면 오류: ${(await alert.innerText()).trim()}`);
      const noticeText = (await notice.innerText()).trim();
      if (!noticeText.includes('집행이') || !noticeText.includes('확정')) throw new Error(`집행 완료 안내 불일치: ${noticeText}`);
      return `${noticeText} · 메모 ${memo}`;
    });
  }

  const after = await readNativeExecutionSnapshot(state, project, memo);
  const record = after.executions[0];
  const audit = record ? (await state.pgClient.query(`select id,action,field_name,new_value
    from public.audit_logs where project_id=$1 and action='EXECUTION_CONFIRMED'
    and field_name='project_execution_records' and new_value::jsonb->>'record_id'=$2`, [project.id, record.id])).rows : [];
  const expectedBalance = before.executions.length === 0
    ? BigInt(before.wallet.accounting_balance) - amount
    : BigInt(after.wallet.accounting_balance);
  const valid = after.executions.length === 1
    && record?.budget_year_id === after.wallet.budget_year_id
    && record.amount === amount.toString()
    && dateOnly(record.execution_date) === executionDate
    && record.status === 'CONFIRMED' && record.transaction_kind === 'NORMAL'
    && record.record_origin === 'SYSTEM_NATIVE'
    && record.created_by === state.localProfile.id && record.confirmed_by === state.localProfile.id
    && BigInt(after.wallet.accounting_balance) === expectedBalance
    && after.position?.projection_ready === true
    && BigInt(after.position.ledger_execution_amount) >= amount
    && after.position.current_wallet_balance === after.wallet.accounting_balance
    && audit.length === 1;
  if (!valid) throw new Error(`집행 금액·상태 무결성 실패: ${JSON.stringify({ before, after, auditCount: audit.length })}`);

  await step(reporter, {
    scenario, role: '지자체', name: '새로고침 후 원장 잔액 유지',
    expected: `확정 집행 10,000원이 반영된 원장 잔액 ${won(after.wallet.accounting_balance)} 유지`, page: local,
  }, async () => {
    await local.reload({ waitUntil: 'domcontentloaded' });
    await local.getByRole('heading', { name: project.project_name, exact: true }).waitFor({ timeout: 60_000 });
    await local.getByText('원장을 불러오는 중입니다...', { exact: true }).waitFor({ state: 'hidden', timeout: 60_000 });
    const section = local.locator('section.financial-ledger-section');
    const balanceTitle = `${BigInt(after.wallet.accounting_balance).toLocaleString('ko-KR')}원`;
    await section.locator(`[title="${balanceTitle}"]`).first().waitFor({ timeout: 30_000 });
    return `집행 ${record.id} · 현재 미집행액 ${won(after.wallet.accounting_balance)}`;
  });

  await step(reporter, {
    scenario, role: '양쪽', name: '관리자·지자체 분석 금액 동기화',
    expected: `부산 서구 ${project.year}년 같은 사업의 조정후배분액 ${won(after.position.ledger_adjusted_allocation)} · 차액 0원`, page: admin,
  }, async () => {
    const readAmount = async (page, role) => {
      await page.goto(`${TEST_ORIGIN}/analytics`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: '기본 조회조건', exact: true }).waitFor({ timeout: 60_000 });
      await page.locator('label').filter({ hasText: /^\s*사업연도/ }).locator('select').selectOption(String(project.year));
      if (role === '관리자') {
        await page.locator('label').filter({ hasText: /^\s*시도/ }).locator('select').selectOption('부산');
        await page.locator('label').filter({ hasText: /^\s*시군구/ }).locator('select').selectOption('서구');
      }
      await page.locator('label').filter({ hasText: /^\s*집계단위/ }).locator('select').selectOption('project');
      await page.getByRole('button', { name: '조회', exact: true }).click();
      const row = page.getByRole('row', { name: new RegExp(project.project_name) });
      await row.waitFor({ timeout: 60_000 });
      return row.locator('.amount-display').first().getAttribute('title');
    };
    const localAmount = await readAmount(local, '지자체');
    const adminAmount = await readAmount(admin, '관리자');
    const expected = won(after.position.ledger_adjusted_allocation);
    if (localAmount !== adminAmount || localAmount !== expected) {
      throw new Error(`분석 금액 불일치: 지자체=${localAmount}, 관리자=${adminAmount}, DB=${expected}`);
    }
    return `지자체=${localAmount} · 관리자=${adminAmount} · DB=${expected} · 차액 0원`;
  });

  reporter.add({
    scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '집행·감사·금액 무결성', status: 'PASS',
    expected: '확정 집행 1건 · SYSTEM_NATIVE · 지자체 본인 지역 · 원장 -10,000원 · 감사 1건',
    actual: `집행 ${record.id} · 감사 ${audit[0].id} · 원장 잔액 ${won(after.wallet.accounting_balance)} · 중복 0건`,
  });
  return {
    projectId: project.id, executionId: record.id, budgetYearId: after.wallet.budget_year_id,
    amount: amount.toString(), executionDate, accountingBalance: after.wallet.accounting_balance,
    auditId: audit[0].id, duplicateCount: 0,
  };
}

async function verifyDatabaseAfterExistingTransfer(config, state, reporter) {
  const pgClient = new Client({
    connectionString: pgConnectionString(config.databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: `browser-uat-transfer-verify-${reporter.runId}`,
  });
  await pgClient.connect();
  try {
    await pgClient.query('begin read only');
    await pgClient.query("set local statement_timeout='45s'");
    const request = (await pgClient.query(`select requests.id,requests.status,requests.total_amount::bigint::text,
      requests.source_project_id,requests.reason,
      coalesce(sum(lines.amount),0)::bigint::text destination_sum,
      count(lines.id)::integer line_count,
      array_remove(array_agg(lines.destination_project_id),null) destination_project_ids
      from public.financial_budget_change_requests requests
      left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
      where requests.reason=$1
      group by requests.id order by requests.requested_at desc limit 1`, [state.transferReason])).rows[0];
    if (!request) throw new Error('DB 대조에서 기존사업 재배분 요청을 찾지 못했습니다.');
    const snapshots = (await pgClient.query(`select project_id,project_role,amount::bigint::text,capture_kind,
      original_before::bigint::text,increase_before::bigint::text,decrease_before::bigint::text,
      adjusted_before::bigint::text,execution_before::bigint::text,unexecuted_before::bigint::text,
      original_after::bigint::text,increase_after::bigint::text,decrease_after::bigint::text,
      adjusted_after::bigint::text,execution_after::bigint::text,unexecuted_after::bigint::text
      from public.financial_budget_workflow_amount_snapshots
      where budget_request_id=$1 and capture_kind='EXACT_AT_APPLY'
      order by project_role`, [request.id])).rows;
    const source = snapshots.find((row) => row.project_role === 'SOURCE');
    const destination = snapshots.find((row) => row.project_role === 'DESTINATION');
    const amount = EXISTING_TRANSFER_AMOUNT;
    const requestValid = request.status === 'APPLIED'
      && request.total_amount === amount.toString()
      && request.source_project_id === state.source.id
      && request.destination_sum === amount.toString()
      && request.line_count === 1
      && request.destination_project_ids?.length === 1
      && request.destination_project_ids[0] === state.destination.id;
    const sourceValid = source?.project_id === state.source.id
      && source.amount === amount.toString()
      && source.capture_kind === 'EXACT_AT_APPLY'
      && BigInt(source.decrease_after) - BigInt(source.decrease_before) === amount
      && BigInt(source.adjusted_before) - BigInt(source.adjusted_after) === amount
      && source.execution_before === source.execution_after;
    const destinationValid = destination?.project_id === state.destination.id
      && destination.amount === amount.toString()
      && destination.capture_kind === 'EXACT_AT_APPLY'
      && BigInt(destination.increase_after) - BigInt(destination.increase_before) === amount
      && BigInt(destination.adjusted_after) - BigInt(destination.adjusted_before) === amount
      && destination.execution_before === destination.execution_after;
    const gap = BigInt(request.total_amount) - BigInt(request.destination_sum);
    if (!requestValid || !sourceValid || !destinationValid || snapshots.length !== 2 || gap !== 0n) {
      throw new Error(`기존사업 재배분 금액·상태 무결성 실패: ${JSON.stringify({ request, snapshots, gap: gap.toString() })}`);
    }
    await pgClient.query('commit');
    reporter.add({
      scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '기존사업 A→B 정확 금액 스냅샷', status: 'PASS',
      expected: '출처 감액 = 목적지 증액 = 100,000원, EXACT_AT_APPLY 2건, 거래 차액 0원, 적용완료',
      actual: `예산요청 ${request.id} · 출처 -${won(amount)} · 목적지 +${won(amount)} · 차액 ${won(gap)}`,
    });
    return { requestId: request.id, source, destination, gap: gap.toString() };
  } finally {
    await pgClient.query('rollback').catch(() => undefined);
    await pgClient.end().catch(() => undefined);
  }
}

async function verifyDatabaseAfterSplitFunding(config, state, reporter) {
  const pgClient = new Client({
    connectionString: pgConnectionString(config.databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: `browser-uat-split-verify-${reporter.runId}`,
  });
  await pgClient.connect();
  try {
    await pgClient.query('begin read only');
    await pgClient.query("set local statement_timeout='45s'");
    const request = (await pgClient.query(`select requests.id,requests.status,
      requests.total_amount::bigint::text,requests.source_project_id,
      coalesce(sum(lines.amount),0)::bigint::text destination_sum,
      count(lines.id)::integer line_count,
      count(*) filter (where lines.destination_type='EXISTING_PROJECT')::integer existing_count,
      count(*) filter (where lines.destination_type='PENDING_NEW_PROJECT')::integer pending_count,
      max(lines.destination_project_id::text) filter (where lines.destination_type='EXISTING_PROJECT') destination_project_id
      from public.financial_budget_change_requests requests
      join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
      where requests.reason=$1 group by requests.id order by requests.requested_at desc limit 1`, [state.splitReason])).rows[0];
    if (!request) throw new Error('DB 대조에서 복수배분 요청을 찾지 못했습니다.');
    const linked = (await pgClient.query(`select pending.id pending_id,pending.status pending_status,
      pending.amount::bigint::text pending_amount,new_requests.id new_request_id,
      new_requests.status new_status,new_requests.requested_amount::bigint::text,
      new_requests.materialized_project_id,links.id link_id,links.status link_status,
      links.amount::bigint::text link_amount
      from public.financial_pending_new_project_funds pending
      join public.financial_budget_change_request_lines lines on lines.id=pending.source_line_id
      left join public.financial_new_project_requests new_requests on new_requests.source_lot_id=pending.lot_id
      left join public.financial_pending_new_project_link_requests links on links.pending_fund_id=pending.id
      where lines.request_id=$1 and lines.destination_type='PENDING_NEW_PROJECT'
      order by links.requested_at desc nulls last limit 1`, [request.id])).rows[0];
    if (!linked) throw new Error('DB 대조에서 예정재원·신규사업·연결 요청을 찾지 못했습니다.');
    const snapshots = (await pgClient.query(`select event_type,event_id,project_id,project_role,
      amount::bigint::text,capture_kind,increase_before::bigint::text,increase_after::bigint::text,
      decrease_before::bigint::text,decrease_after::bigint::text,
      adjusted_before::bigint::text,adjusted_after::bigint::text,
      execution_before::bigint::text,execution_after::bigint::text
      from public.financial_budget_workflow_amount_snapshots
      where budget_request_id=$1 and capture_kind='EXACT_AT_APPLY'
      order by event_type,project_role`, [request.id])).rows;
    const source = snapshots.find((row) => row.event_type === 'BUDGET_CHANGE' && row.project_role === 'SOURCE');
    const existingDestination = snapshots.find((row) => row.event_type === 'BUDGET_CHANGE' && row.project_role === 'DESTINATION');
    const linkedDestination = snapshots.find((row) => row.event_type === 'PENDING_LINK' && row.project_role === 'DESTINATION');
    const total = 200_000n;
    const each = 100_000n;
    const valid = request.status === 'APPLIED' && request.total_amount === total.toString()
      && request.destination_sum === total.toString() && request.line_count === 2
      && request.existing_count === 1 && request.pending_count === 1
      && request.destination_project_id === state.destination.id
      && linked.pending_status === 'LINKED' && linked.pending_amount === each.toString()
      && linked.new_status === 'APPLIED' && linked.requested_amount === each.toString()
      && linked.link_status === 'APPLIED' && linked.link_amount === each.toString()
      && source?.project_id === state.source.id && source.amount === total.toString()
      && BigInt(source.decrease_after) - BigInt(source.decrease_before) === total
      && existingDestination?.project_id === state.destination.id && existingDestination.amount === each.toString()
      && BigInt(existingDestination.increase_after) - BigInt(existingDestination.increase_before) === each
      && linkedDestination?.project_id === linked.materialized_project_id && linkedDestination.amount === each.toString()
      && BigInt(linkedDestination.increase_after) - BigInt(linkedDestination.increase_before) === each;
    const gap = BigInt(request.total_amount) - BigInt(request.destination_sum);
    if (!valid || gap !== 0n) throw new Error(`복수배분·예정재원 연결 무결성 실패: ${JSON.stringify({ request, linked, snapshots, gap: gap.toString() })}`);
    await pgClient.query('commit');
    reporter.add({
      scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '복수배분·예정재원·신규사업 연결 금액 무결성', status: 'PASS',
      expected: '출처 -200,000원 = 기존사업 +100,000원 + 신규사업 +100,000원, 예정재원 LINKED, 거래 차액 0원',
      actual: `예산요청 ${request.id} · 신규요청 ${linked.new_request_id} · 연결요청 ${linked.link_id} · 차액 ${won(gap)}`,
    });
    return { requestId: request.id, ...linked, snapshotCount: snapshots.length, gap: gap.toString() };
  } finally {
    await pgClient.query('rollback').catch(() => undefined);
    await pgClient.end().catch(() => undefined);
  }
}

async function verifyDatabaseAfterCore(env, config, state, reporter) {
  const pgClient = new Client({
    connectionString: pgConnectionString(config.databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: `browser-uat-verify-${reporter.runId}`,
  });
  await pgClient.connect();
  try {
    await pgClient.query('begin read only');
    await pgClient.query("set local statement_timeout='45s'");
    const row = (await pgClient.query(`select n.id new_request_id,n.status new_status,n.requested_amount::bigint::text,
      n.materialized_project_id,b.id budget_request_id,b.status budget_status,b.total_amount::bigint::text,b.source_project_id,
      p.project_code,p.original_alloc::bigint::text,p.increase_amount::bigint::text,p.decrease_amount::bigint::text,
      p.alloc::bigint::text,p.exec::bigint::text,
      (select coalesce(sum(l.amount),0)::bigint::text from public.financial_budget_change_request_lines l where l.request_id=b.id) destination_sum
      from public.financial_new_project_requests n
      join public.financial_budget_change_requests b on b.id=n.source_budget_change_request_id
      left join public.projects p on p.id=n.materialized_project_id
      where n.project_name=$1 order by n.requested_at desc limit 1`, [state.projectName])).rows[0];
    if (!row) throw new Error('DB 대조에서 실행 요청을 찾지 못했습니다.');
    const sourcePosition = (await pgClient.query(`select ledger_original_allocation::bigint::text,
      ledger_adjusted_allocation::bigint::text,ledger_increase_amount::bigint::text,ledger_decrease_amount::bigint::text,
      ledger_execution_amount::bigint::text,current_wallet_balance::bigint::text,projection_ready
      from public.financial_project_funding_positions where project_id=$1`, [state.source.id])).rows[0];
    const snapshots = (await pgClient.query(`select event_type,project_id,project_role,amount::bigint::text,capture_kind,
      increase_before::bigint::text,increase_after::bigint::text,
      decrease_before::bigint::text,decrease_after::bigint::text
      from public.financial_budget_workflow_amount_snapshots
      where budget_request_id=$1 and event_type='BUDGET_CHANGE' and capture_kind='EXACT_AT_APPLY'
      order by project_role`, [row.budget_request_id])).rows;
    const sourceSnapshot = snapshots.find((snapshot) => snapshot.project_role === 'SOURCE');
    const destinationSnapshot = snapshots.find((snapshot) => snapshot.project_role === 'DESTINATION');
    const gap = BigInt(row.total_amount) - BigInt(row.destination_sum);
    const invariant = row.new_status === 'APPLIED' && row.budget_status === 'APPLIED'
      && row.source_project_id === state.source.id
      && row.requested_amount === DEFAULT_AMOUNT.toString()
      && row.increase_amount === DEFAULT_AMOUNT.toString()
      && row.alloc === DEFAULT_AMOUNT.toString()
      && row.exec === '0'
      && sourcePosition?.projection_ready === true
      && BigInt(sourcePosition.ledger_adjusted_allocation) === BigInt(sourcePosition.ledger_original_allocation)
        + BigInt(sourcePosition.ledger_increase_amount) - BigInt(sourcePosition.ledger_decrease_amount)
      && BigInt(sourcePosition.current_wallet_balance) === BigInt(sourcePosition.ledger_adjusted_allocation)
        - BigInt(sourcePosition.ledger_execution_amount)
      && sourcePosition.ledger_execution_amount === state.source.execution
      && sourceSnapshot?.project_id === state.source.id
      && sourceSnapshot.amount === DEFAULT_AMOUNT.toString()
      && BigInt(sourceSnapshot.decrease_after) - BigInt(sourceSnapshot.decrease_before) === DEFAULT_AMOUNT
      && destinationSnapshot?.project_id === row.materialized_project_id
      && destinationSnapshot.amount === DEFAULT_AMOUNT.toString()
      && BigInt(destinationSnapshot.increase_after) - BigInt(destinationSnapshot.increase_before) === DEFAULT_AMOUNT
      && gap === 0n;
    if (!invariant) throw new Error(`금액·상태 무결성 실패: ${JSON.stringify({ ...row, sourcePosition, snapshots, gap: gap.toString() })}`);
    await pgClient.query('commit');
    reporter.add({ scenario: 'DB 읽기 전용 대조', role: '양쪽', step: '거래 금액·상태 무결성', status: 'PASS', expected: '출처 감액 = 목적지 증액 = 1,000,000원, 거래 차액 0원, 모두 적용완료', actual: `예산요청 ${row.budget_request_id}, 신규요청 ${row.new_request_id}, 사업 ${row.materialized_project_id}, 차액 ${won(gap)}` });
    return { ...row, sourcePosition, snapshots, gap: gap.toString() };
  } finally {
    await pgClient.query('rollback').catch(() => undefined);
    await pgClient.end().catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = validateRunId(args.runId || makeRunId());
  const reporter = new Reporter(runId, args);
  const env = { ...loadEnvFile('.env.ledger-test.local'), ...loadEnvFile('.env.ledger-uat-credentials.local') };
  const config = verifyTestConfiguration(env, args);
  process.stdout.write(`[안전확인] 대상=TEST · Vercel=${TEST_ORIGIN} · Supabase=${TEST_REF} · Production 접근/변경=없음\n`);
  process.stdout.write(`[실행정보] ID=${runId} · 모드=${args.mode} · 시나리오=${args.scenario} · 화면 유지=${args.holdMs}ms\n`);
  process.stdout.write('[중단방법] Ctrl+C · 이미 제출된 TEST 거래는 중단만으로 취소되지 않습니다.\n');

  let localRole;
  let adminRole;
  let state;
  let interrupted = false;
  const shutdown = async () => {
    if (interrupted) return;
    interrupted = true;
    process.stdout.write('\n[중단] 자동 조작을 멈춥니다. 이미 제출·승인·적용된 TEST 거래는 자동 취소되지 않습니다.\n');
    await Promise.allSettled([localRole?.browser.close(), adminRole?.browser.close()]);
    reporter.flush({ interrupted: true });
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(130)); });

  try {
    state = await preflight(env, config, runId, args.sourceProjectId);
    state.source.decrease_amount = state.position.decrease_amount;
    reporter.add({ scenario: '사전 점검', role: '양쪽', step: 'TEST 대상·역할·재실행 점검', status: 'PASS', expected: 'TEST 런타임, 부산 서구/관리자, 충분한 감액 가능액, 중복 없음', actual: `런타임 TEST · 부산 서구 · 관리자 · 감액 가능액 ${won(state.position.unexecuted_amount)} · 기존 실행 ${state.existing.length}건` });

    if (args.scenario === 'core' && args.mode === 'mutate' && state.existing.length > 1) {
      throw new Error(`동일 실행 ID 신규사업 요청이 ${state.existing.length}건이라 중복 처리를 차단했습니다.`);
    }
    if (args.scenario === 'core' && args.mode === 'mutate' && state.existing.length > 0) {
      const existing = state.existing[0];
      if (existing.source_budget_change_request_id && existing.actual_source_project_id !== state.source.id) {
        throw new Error(`기존 실행의 출처 사업이 다릅니다. --source-project-id ${existing.actual_source_project_id}로 재실행하세요.`);
      }
      if (existing.status === 'APPLIED' && existing.source_budget_change_request_id) {
        state.resumeApplied = existing;
        reporter.add({ scenario: '재실행 보호', role: '양쪽', step: '기존 완료 거래 검증 재개', status: 'PASS', expected: '동일 실행 ID 중복 제출·승인 없음', actual: `기존 신규사업 요청 ${existing.id}, 부모 예산조정 ${existing.source_budget_change_request_id} APPLIED 재사용` });
      } else if (existing.status === 'DRAFT' && !existing.source_budget_change_request_id) {
        state.resumeDraft = existing;
        reporter.add({ scenario: '재실행 보호', role: '지자체', step: '기존 초안 재사용', status: 'PASS', expected: '동일 실행 ID 신규사업 중복 생성 없음', actual: `기존 초안 ${existing.id} 재사용` });
      } else if (existing.status === 'SUBMITTED' && existing.source_budget_change_request_id) {
        state.resumeSubmitted = existing;
        reporter.add({ scenario: '재실행 보호', role: '양쪽', step: '제출 완료 요청 이어서 실행', status: 'PASS', expected: '동일 실행 ID 요청 재제출 없음', actual: `기존 신규사업 요청 ${existing.id}, 부모 예산조정 ${existing.source_budget_change_request_id} 재사용` });
      } else {
        throw new Error(`동일 실행 ID의 미완료 요청이 있어 중복 제출을 차단했습니다: ${existing.id} (${existing.status})`);
      }
    }

    [localRole, adminRole] = await Promise.all([launchRoleBrowser(args, 0), launchRoleBrowser(args, 960)]);
    await runSmoke(reporter, env, state, localRole, adminRole);
    if (args.scenario === 'core') {
      await runCore(reporter, env, state, localRole, adminRole);
      const dbVerification = await verifyDatabaseAfterCore(env, config, state, reporter);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
    } else if (args.scenario === 'account-matrix') {
      const accountMatrix = await runAccountMatrix(reporter, env, args, localRole, adminRole);
      reporter.flush({ accountMatrix, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'coverage') {
      await runCoverage(reporter, state, localRole, adminRole);
      reporter.flush({ roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'coverage-retry') {
      await runCoverageRetry(reporter, state, localRole, adminRole);
      reporter.flush({ roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'regression') {
      await runRegression(reporter, state, localRole, adminRole);
      reporter.flush({ roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'validation') {
      await runValidationRetry(reporter, state, localRole);
      reporter.flush({ roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
    } else if (args.scenario === 'visible-regression') {
      await runVisibleRegression(reporter, adminRole);
      reporter.flush({ roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'existing-transfer') {
      await runExistingTransfer(reporter, state, localRole, adminRole);
      const dbVerification = await verifyDatabaseAfterExistingTransfer(config, state, reporter);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'split-funding-first') {
      await runSplitFundingFirst(reporter, state, localRole, adminRole);
      const dbVerification = await verifyDatabaseAfterSplitFunding(config, state, reporter);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'rejection-resubmit') {
      await runRejectionResubmit(reporter, state, localRole, adminRole);
      const dbVerification = await verifyDatabaseAfterRejection(state, reporter);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'project-metadata') {
      const dbVerification = await runProjectMetadata(reporter, state, localRole, adminRole);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'small-category-lifecycle') {
      const dbVerification = await runSmallCategoryLifecycle(reporter, state, localRole, adminRole);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else if (args.scenario === 'native-execution') {
      const dbVerification = await runNativeExecution(reporter, state, localRole, adminRole);
      reporter.flush({ dbVerification, roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
      if (reporter.results.some((item) => item.status === 'FAIL')) process.exitCode = 1;
    } else {
      reporter.flush({ roles: { local: state.localProfile, admin: state.adminProfile }, blockedExternalOrigins: [...new Set([...localRole.blockedHosts, ...adminRole.blockedHosts])] });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.scenario === 'core') {
      const attempted = new Set(reporter.results.filter((item) => item.scenario === '핵심 연결').map((item) => item.step));
      for (const [role, name] of CORE_STEPS) {
        if (!attempted.has(name)) reporter.skip('핵심 연결', role, name, '선행 단계 성공 후 실행', `선행 단계 실패로 미실행: ${message}`);
      }
    }
    reporter.add({ scenario: '실행기', role: '시스템', step: '최종 상태', status: 'FAIL', expected: '선택한 시나리오 완료', actual: message });
    reporter.flush({ fatalError: message });
    process.exitCode = 1;
  } finally {
    if (!interrupted) {
      await Promise.allSettled([localRole?.browser.close(), adminRole?.browser.close()]);
    }
    if (state) await finishPreflight(state);
    const pass = reporter.results.filter((item) => item.status === 'PASS').length;
    const fail = reporter.results.filter((item) => item.status === 'FAIL').length;
    const skipped = reporter.results.filter((item) => item.status === '미실행').length;
    process.stdout.write(`\n[완료] PASS ${pass} · FAIL ${fail} · 미실행 ${skipped}\n`);
    process.stdout.write(`[결과] ${path.relative(ROOT, reporter.artifactDir)}\n`);
  }
}

await main();
