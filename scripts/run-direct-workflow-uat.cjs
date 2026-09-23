#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';

function fail(message) { throw new Error(message); }
function check(condition, message) { if (!condition) fail(message); }
function load(file) { return dotenv.parse(fs.readFileSync(path.resolve(process.cwd(), file))); }
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
function apiClient(url, anonKey) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, anonKey, email, password, label) {
  const client = apiClient(url, anonKey);
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.user) fail(`${label} authentication failed: ${result.error?.message ?? 'no user'}`);
  let profile;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    profile = await client.from('profiles').select('id,role,region_id').eq('id', result.data.user.id).single();
    if (!profile.error || !/JWT issued at future/i.test(profile.error.message)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (profile.error || !profile.data) fail(`${label} profile failed: ${profile.error?.message ?? 'no profile'}`);
  return { client, user: result.data.user, profile: profile.data };
}
async function financialSnapshot(pg, requestId) {
  return (await pg.query(`select
    (select count(*)::text from public.projects) project_count,
    (select count(*)::text from public.financial_unallocated_fund_movements) movement_count,
    (select coalesce(sum(amount),0)::text from public.financial_unallocated_fund_movements) movement_amount,
    (select count(*)::text from public.financial_pending_new_project_link_requests) link_count,
    (select count(*)::text from public.financial_post_check_requests) check_count,
    (select count(*)::text from public.system_notifications) notification_count,
    (select status from public.financial_new_project_requests where id=$1) request_status`, [requestId])).rows[0];
}
async function main() {
  if (process.argv.length < 4 || !process.argv.includes('--confirm-test-write')) {
    fail('Usage: node scripts/run-direct-workflow-uat.cjs <test-env> <credentials-env> --confirm-test-write');
  }
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = String(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const anonKey = String(env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '');
  check(String(env.TARGET_ENV).toUpperCase() === 'TEST'
    && env.TEST_PROJECT_REF === TEST_REF
    && env.PROD_PROJECT_REF !== TEST_REF
    && refFromUrl(url) === TEST_REF
    && refFromDatabase(databaseUrl) === TEST_REF, 'Fail-closed TEST target gate rejected configuration.');

  const accounts = await Promise.all([
    signIn(url, anonKey, env.UAT_ADMIN_A_EMAIL, env.UAT_ADMIN_A_PASSWORD, 'admin-a'),
    signIn(url, anonKey, env.UAT_LOCAL_A_EMAIL, env.UAT_LOCAL_A_PASSWORD, 'local-a'),
    signIn(url, anonKey, env.UAT_LOCAL_B_EMAIL, env.UAT_LOCAL_B_PASSWORD, 'local-b'),
    signIn(url, anonKey, env.UAT_LOCAL_C_EMAIL, env.UAT_LOCAL_C_PASSWORD, 'local-c'),
  ]);
  const [admin, ...locals] = accounts;
  check(admin.profile.role === 'admin', 'UAT admin role mismatch.');
  check(locals.every((entry) => entry.profile.role === 'local_user'), 'UAT local role mismatch.');

  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'direct-workflow-uat',
  });
  await pg.connect();
  try {
    const runtime = (await pg.query(`select concat_ws(':',environment_kind,mode,bound_project_ref) value
      from public.financial_ledger_runtime where singleton=true`)).rows[0]?.value;
    check(runtime === `TEST:TEST:${TEST_REF}`, 'TEST ledger runtime is not active.');
    const pending = (await pg.query(`select requests.id,requests.requested_by,requests.region_id,
        requests.requested_amount,requests.source_lot_id,pending.id pending_fund_id,
        lots.original_amount,
        (lots.original_amount - coalesce((
          select sum(movements.amount * case when movements.transaction_kind='REVERSAL' then -1 else 1 end)
          from public.financial_unallocated_fund_movements movements
          where movements.lot_id=lots.id
        ),0))::text remaining_amount
      from public.financial_new_project_requests requests
      join public.financial_unallocated_fund_lots lots on lots.id=requests.source_lot_id
      left join public.financial_pending_new_project_funds pending on pending.lot_id=lots.id
      where requests.status in ('SUBMITTED','APPROVED')
        and requests.materialized_project_id is null
      order by requests.requested_at
      limit 1`)).rows[0];
    check(pending, 'No legacy pending new-project request is available for TEST conversion.');
    const owner = locals.find((entry) => entry.user.id === pending.requested_by);
    check(owner, 'Legacy pending request owner is not one of the approved TEST local accounts.');
    check(owner.profile.region_id === pending.region_id, 'Legacy pending request region mismatch.');
    check(String(pending.requested_amount) === String(pending.remaining_amount), 'Legacy request amount does not match remaining source lot.');

    const before = await financialSnapshot(pg, pending.id);
    const completion = await owner.client.rpc('financial_complete_new_project_request', {
      p_request_id: pending.id,
    });
    if (completion.error) fail(`Direct completion failed: ${completion.error.message}`);
    const completed = Array.isArray(completion.data) ? completion.data[0] : completion.data;
    check(completed?.status === 'APPLIED' && completed?.project_id && completed?.movement_id,
      'Direct completion did not return an applied project and movement.');

    const appliedState = (await pg.query(`select requests.status,requests.processing_mode,
        requests.approved_by,requests.approved_at,requests.materialized_project_id,
        requests.materialized_movement_id,requests.requested_amount,
        projects.total_budget::text project_total_budget,
        movements.amount::text movement_amount,
        pending.status pending_status,
        links.id link_id,links.status link_status,links.processing_mode link_processing_mode,
        links.approved_by link_approved_by,links.materialized_movement_id link_movement_id,
        transitions.before_status,transitions.after_status,transitions.result
      from public.financial_new_project_requests requests
      join public.projects on projects.id=requests.materialized_project_id
      join public.financial_unallocated_fund_movements movements on movements.id=requests.materialized_movement_id
      left join public.financial_pending_new_project_funds pending on pending.lot_id=requests.source_lot_id
      left join public.financial_pending_new_project_link_requests links
        on links.pending_fund_id=pending.id and links.destination_project_id=projects.id
      left join public.financial_direct_processing_transitions transitions
        on transitions.entity_type='NEW_PROJECT' and transitions.entity_id=requests.id
      where requests.id=$1`, [pending.id])).rows[0];
    check(appliedState.status === 'APPLIED' && appliedState.processing_mode === 'DIRECT', 'Request was not marked as direct/applied.');
    check(appliedState.approved_by === null && appliedState.approved_at === null, 'Synthetic approval fields were not cleared.');
    check(appliedState.materialized_project_id === completed.project_id
      && appliedState.materialized_movement_id === completed.movement_id, 'Materialization ids mismatch.');
    check(appliedState.requested_amount === appliedState.project_total_budget
      && appliedState.requested_amount === appliedState.movement_amount, 'Request/project/movement amounts mismatch.');
    check(appliedState.pending_status === 'LINKED'
      && appliedState.link_status === 'APPLIED'
      && appliedState.link_processing_mode === 'DIRECT'
      && appliedState.link_approved_by === null
      && appliedState.link_movement_id === completed.movement_id, 'Pending-fund link was not completed directly.');
    check(appliedState.after_status === 'APPLIED' && appliedState.result === 'COMPLETED', 'Transition audit was not recorded.');

    const afterFirst = await financialSnapshot(pg, pending.id);
    check(BigInt(afterFirst.project_count) === BigInt(before.project_count) + 1n, 'Exactly one project was not created.');
    check(BigInt(afterFirst.movement_count) === BigInt(before.movement_count) + 1n, 'Exactly one movement was not created.');
    check(BigInt(afterFirst.movement_amount) === BigInt(before.movement_amount) + BigInt(pending.requested_amount),
      'Movement total did not increase by the request amount.');
    check(BigInt(afterFirst.link_count) === BigInt(before.link_count) + 1n, 'Exactly one link request was not created.');

    const repeated = await owner.client.rpc('financial_complete_new_project_request', { p_request_id: pending.id });
    if (repeated.error) fail(`Idempotent completion failed: ${repeated.error.message}`);
    const afterRepeat = await financialSnapshot(pg, pending.id);
    check(afterRepeat.project_count === afterFirst.project_count
      && afterRepeat.movement_count === afterFirst.movement_count
      && afterRepeat.movement_amount === afterFirst.movement_amount
      && afterRepeat.link_count === afterFirst.link_count, 'Repeated completion created a duplicate financial record.');

    const legacyPrivilege = (await pg.query(`select
      has_function_privilege('authenticated','public.financial_approve_new_project_request(uuid,text)','EXECUTE') approve_new,
      has_function_privilege('authenticated','public.financial_approve_budget_change_request_group(uuid,jsonb)','EXECUTE') approve_budget,
      has_function_privilege('authenticated','public.financial_review_pending_new_project_link(uuid,text,text)','EXECUTE') review_link`)).rows[0];
    check(!legacyPrivilege.approve_new && !legacyPrivilege.approve_budget && !legacyPrivilege.review_link,
      'A legacy approval RPC remains executable.');

    const financeBeforeChecks = await financialSnapshot(pg, pending.id);
    const createCheck = await admin.client.rpc('financial_create_post_check_request', {
      p_subject_type: 'PROJECT',
      p_subject_id: completed.project_id,
      p_message: '직접 등록된 사업명과 예산연결 근거를 확인하고 조치내용을 회신해 주세요.',
      p_due_date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      p_parent_request_id: null,
    });
    if (createCheck.error) fail(`Post-check creation failed: ${createCheck.error.message}`);
    const checkId = String(createCheck.data);
    const localRequests = await owner.client.rpc('get_financial_post_check_requests', { p_status: null });
    if (localRequests.error) fail(`Local post-check read failed: ${localRequests.error.message}`);
    check(localRequests.data.some((item) => item.id === checkId && item.status === 'REQUESTED'),
      'Target local user cannot read the post-check request.');
    const ownerNotifications = await owner.client.rpc('get_financial_notifications', { p_unread_only: false });
    if (ownerNotifications.error) fail(`Local notification read failed: ${ownerNotifications.error.message}`);
    const notification = ownerNotifications.data.find((item) => item.related_post_check_id === checkId);
    check(notification && notification.read_at === null, 'Durable unread notification was not created.');
    const markRead = await owner.client.rpc('financial_mark_notification_read', { p_notification_id: notification.id });
    if (markRead.error) fail(`Notification read marking failed: ${markRead.error.message}`);
    const afterRead = await owner.client.rpc('get_financial_post_check_requests', { p_status: null });
    check(afterRead.data.find((item) => item.id === checkId)?.status === 'REQUESTED',
      'Reading a notification incorrectly completed the request.');

    const outsider = locals.find((entry) => entry.profile.region_id !== owner.profile.region_id);
    check(outsider, 'A different-region TEST account is required for isolation verification.');
    const outsiderRequests = await outsider.client.rpc('get_financial_post_check_requests', { p_status: null });
    if (outsiderRequests.error) fail(`Cross-region list query failed unexpectedly: ${outsiderRequests.error.message}`);
    check(!outsiderRequests.data.some((item) => item.id === checkId), 'Cross-region request leaked through list RPC.');
    const crossReply = await outsider.client.rpc('financial_reply_post_check_request', {
      p_request_id: checkId, p_reply_message: '다른 지역 접근 시도',
    });
    check(Boolean(crossReply.error), 'Cross-region user could reply to another region request.');

    const reply = await owner.client.rpc('financial_reply_post_check_request', {
      p_request_id: checkId,
      p_reply_message: '사업명과 원천 예정재원 24,315,640원을 확인했으며 별도 정정 사항이 없습니다.',
    });
    if (reply.error) fail(`Local post-check reply failed: ${reply.error.message}`);
    const complete = await admin.client.rpc('financial_complete_post_check_request', { p_request_id: checkId });
    if (complete.error) fail(`Admin post-check completion failed: ${complete.error.message}`);
    const recheck = await admin.client.rpc('financial_create_post_check_request', {
      p_subject_type: 'PROJECT',
      p_subject_id: completed.project_id,
      p_message: '회신 근거가 연결 상세와 일치하는지 한 번 더 확인해 주세요.',
      p_due_date: null,
      p_parent_request_id: checkId,
    });
    if (recheck.error) fail(`Post-check re-request failed: ${recheck.error.message}`);
    const recheckId = String(recheck.data);
    const oldAndNew = await admin.client.rpc('get_financial_post_check_requests', { p_status: null });
    if (oldAndNew.error) fail(`Admin post-check history read failed: ${oldAndNew.error.message}`);
    check(oldAndNew.data.find((item) => item.id === checkId)?.status === 'COMPLETED'
      && oldAndNew.data.find((item) => item.id === recheckId)?.status === 'REQUESTED',
      'Recheck did not preserve the completed parent history.');

    await owner.client.auth.signOut();
    const reauthenticated = await signIn(url, anonKey, env.UAT_LOCAL_A_EMAIL === owner.user.email
      ? env.UAT_LOCAL_A_EMAIL
      : env.UAT_LOCAL_B_EMAIL === owner.user.email
        ? env.UAT_LOCAL_B_EMAIL : env.UAT_LOCAL_C_EMAIL,
    env.UAT_LOCAL_A_EMAIL === owner.user.email
      ? env.UAT_LOCAL_A_PASSWORD
      : env.UAT_LOCAL_B_EMAIL === owner.user.email
        ? env.UAT_LOCAL_B_PASSWORD : env.UAT_LOCAL_C_PASSWORD, 'local-reauth');
    const persisted = await reauthenticated.client.rpc('get_financial_notifications', { p_unread_only: false });
    if (persisted.error) fail(`Notification persistence read failed: ${persisted.error.message}`);
    check(persisted.data.some((item) => item.related_post_check_id === checkId)
      && persisted.data.some((item) => item.related_post_check_id === recheckId),
      'Notifications did not persist after sign-out/sign-in.');

    const financeAfterChecks = await financialSnapshot(pg, pending.id);
    check(financeAfterChecks.project_count === financeBeforeChecks.project_count
      && financeAfterChecks.movement_count === financeBeforeChecks.movement_count
      && financeAfterChecks.movement_amount === financeBeforeChecks.movement_amount
      && financeAfterChecks.link_count === financeBeforeChecks.link_count,
    'Post-check request/reply/completion changed financial records.');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      production_touched: false,
      converted_request_id: pending.id,
      project_id: completed.project_id,
      project_code: completed.project_code,
      amount: pending.requested_amount,
      exactly_once: true,
      legacy_approval_rpc_blocked: true,
      transition_recorded: true,
      confirmation_flow: ['REQUESTED', 'REPLIED', 'COMPLETED', 'RECHECK_REQUESTED'],
      notification_persisted_after_reauthentication: true,
      cross_region_isolation: true,
      post_check_monetary_effect: '0',
      pending_before: before.request_status,
      pending_after: afterRepeat.request_status,
      recheck_id: recheckId,
    }, null, 2)}\n`);
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
