#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const TEST_REF='reviewtestxxxxxxxxxx';
const VERSION='20260914000600';
const SQL_PATH=path.resolve(process.cwd(),'supabase/migrations/20260914000600_new_project_delete_origin_history_hotfix.sql');
function fail(message){throw new Error(message);}
function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;}
function ref(value){try{const url=new URL(value);return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]??decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]??null;}catch{return null;}}
function connection(value){const url=new URL(value);url.searchParams.delete('sslmode');url.searchParams.delete('uselibpqcompat');return url.toString();}
async function snapshot(client){return(await client.query(`select
  (select count(*)::text||':'||coalesce(sum(coalesce(total_budget,0)),0)::text||':'||coalesce(sum(coalesce(alloc,0)),0)::text||':'||coalesce(sum(coalesce(exec,0)),0)::text from public.projects) projects,
  (select count(*)::text from public.financial_new_project_requests) requests,
  (select count(*)::text from public.audit_logs) audits,
  (select count(*)::text from public.project_deletion_events) deletion_events`)).rows[0];}
(async()=>{
  const action=arg('--action'); if(!['validate','apply'].includes(action)) fail('--action must be validate or apply.');
  if(action==='apply'&&!process.argv.includes('--confirm-test-write')) fail('TEST apply requires --confirm-test-write.');
  const envPath=path.resolve(process.cwd(),arg('--env-file')??''); if(!arg('--env-file')||!fs.existsSync(envPath)||!fs.existsSync(SQL_PATH)) fail('Migration or TEST env file is missing.');
  const env=dotenv.parse(fs.readFileSync(envPath)); const databaseUrl=String(env.TEST_DATABASE_URL??'');
  if(String(env.TARGET_ENV).toUpperCase()!=='TEST'||env.TEST_PROJECT_REF!==TEST_REF||env.PROD_PROJECT_REF===TEST_REF||ref(databaseUrl)!==TEST_REF) fail('Fail-closed target gate rejected configuration.');
  const sql=fs.readFileSync(SQL_PATH,'utf8'); const sha=crypto.createHash('sha256').update(sql).digest('hex');
  const client=new Client({connectionString:connection(databaseUrl),ssl:{rejectUnauthorized:false},application_name:`new-project-delete-hotfix-${action}`}); await client.connect(); let tx=false;
  try{
    const runtime=(await client.query('select environment_kind,mode,bound_project_ref from public.financial_ledger_runtime where singleton=true')).rows[0];
    if(`${runtime?.environment_kind}:${runtime?.mode}:${runtime?.bound_project_ref}`!==`TEST:TEST:${TEST_REF}`) fail('TEST runtime is not active.');
    const before=await snapshot(client); await client.query('begin');tx=true;
    const lock=await client.query(`select pg_try_advisory_xact_lock(hashtextextended('new-project-delete-hotfix-${VERSION}',${VERSION})) locked`);if(!lock.rows[0]?.locked)fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'"); await client.query(sql);
    if(JSON.stringify(await snapshot(client))!==JSON.stringify(before))fail('Hotfix changed business rows, money, audits, or deletion events.');
    if(action==='validate')await client.query('rollback');else await client.query('commit');tx=false;
    process.stdout.write(`${JSON.stringify({ok:true,target:'TEST',production_touched:false,action,transaction:action==='validate'?'ROLLED_BACK':'COMMITTED',migration_version:VERSION,migration_sha256:sha,business_rows_unchanged:true},null,2)}\n`);
  }finally{if(tx)await client.query('rollback').catch(()=>undefined);await client.end();}
})().catch((error)=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
