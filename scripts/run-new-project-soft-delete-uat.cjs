#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const dotenv=require('dotenv');
const {Client}=require('pg');
const {createClient}=require('@supabase/supabase-js');
const TEST_REF='reviewtestxxxxxxxxxx';
function fail(message){throw new Error(message);}
function connection(value){const url=new URL(value);url.searchParams.delete('sslmode');url.searchParams.delete('uselibpqcompat');return url.toString();}
function ref(value){try{const url=new URL(value);return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]??decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]??null;}catch{return null;}}
async function signIn(values,prefix){const client=createClient(values.NEXT_PUBLIC_SUPABASE_URL,values.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});const result=await client.auth.signInWithPassword({email:values[`${prefix}_EMAIL`],password:values[`${prefix}_PASSWORD`]});if(result.error||!result.data.user)fail(`${prefix} TEST login failed.`);const profile=await client.from('profiles').select('id,role,region_id,region_name').eq('id',result.data.user.id).single();if(profile.error||!profile.data)fail(`${prefix} profile failed.`);return{client,profile:profile.data};}
async function snapshot(pg){return(await pg.query(`select
  (select count(*) from public.projects where deleted_at is null)::int active_projects,
  (select count(*) from public.projects)::int physical_projects,
  (select count(*) from public.financial_new_project_requests where deleted_at is null)::int active_requests,
  (select count(*) from public.financial_new_project_requests)::int physical_requests,
  (select count(*) from public.project_deletion_events)::int deletion_events,
  (select coalesce(sum(coalesce(total_budget,0)),0) from public.projects where deleted_at is null)::text total_budget,
  (select coalesce(sum(coalesce(alloc,0)),0) from public.projects where deleted_at is null)::text allocation,
  (select coalesce(sum(coalesce(exec,0)),0) from public.projects where deleted_at is null)::text execution`)).rows[0];}
(async()=>{
  const envPath=path.resolve(process.cwd(),process.argv[2]??'');const credentialPath=path.resolve(process.cwd(),process.argv[3]??'');
  if(!process.argv[2]||!process.argv[3]||!fs.existsSync(envPath)||!fs.existsSync(credentialPath))fail('Explicit TEST env and credentials files are required.');
  const values={...dotenv.parse(fs.readFileSync(envPath)),...dotenv.parse(fs.readFileSync(credentialPath))};
  if(String(values.TARGET_ENV).toUpperCase()!=='TEST'||values.TEST_PROJECT_REF!==TEST_REF||values.PROD_PROJECT_REF===TEST_REF||ref(values.TEST_DATABASE_URL)!==TEST_REF||!String(values.NEXT_PUBLIC_SUPABASE_URL).includes(TEST_REF))fail('Fail-closed TEST gate rejected configuration.');
  const pg=new Client({connectionString:connection(values.TEST_DATABASE_URL),ssl:{rejectUnauthorized:false},application_name:'new-project-soft-delete-uat'});await pg.connect();
  const localA=await signIn(values,'UAT_LOCAL_A');const localB=await signIn(values,'UAT_LOCAL_B');const admin=await signIn(values,'UAT_ADMIN_A');
  try{
    if(localA.profile.role!=='local_user'||localB.profile.role!=='local_user'||admin.profile.role!=='admin'||!localA.profile.region_id||localA.profile.region_id===localB.profile.region_id)fail('UAT role/region separation is invalid.');
    const runtime=(await pg.query('select environment_kind,mode,bound_project_ref from public.financial_ledger_runtime where singleton=true')).rows[0];if(`${runtime?.environment_kind}:${runtime?.mode}:${runtime?.bound_project_ref}`!==`TEST:TEST:${TEST_REF}`)fail('TEST runtime is not active.');
    const before=await snapshot(pg);const stamp=new Date().toISOString().replace(/\D/g,'').slice(0,14);const name=`[TEST-DELETE-UAT-${stamp}] 신규사업 초안 삭제 검증`;
    const draft=await localA.client.rpc('financial_save_new_project_request_draft_v2',{p_request_id:null,p_region_id:localA.profile.region_id,p_fiscal_year:2027,p_project_name:name,p_fund_project_name:name,p_detail_project_name:name,p_project_period:'2027.01~2027.12',p_project_start_year:2027,p_project_end_year:2027,p_status:'정상추진',p_business_type:'HW',p_large_category_id:null,p_middle_category_id:null,p_source_lot_id:null,p_requested_amount:'0',p_idempotency_key:crypto.randomUUID(),p_execution_status_reason:null});
    if(draft.error)fail(`Draft creation failed: ${draft.error.message}`);const draftRow=Array.isArray(draft.data)?draft.data[0]:draft.data;const draftId=draftRow?.request_id;if(!draftId)fail('Draft id was not returned.');
    const afterCreate=await snapshot(pg);if(afterCreate.active_projects!==before.active_projects||afterCreate.total_budget!==before.total_budget||afterCreate.allocation!==before.allocation||afterCreate.execution!==before.execution||afterCreate.active_requests!==before.active_requests+1)fail('Draft creation affected official statistics or did not change only active draft count.');
    const eligibility=await localA.client.rpc('get_financial_new_project_deletion_eligibility',{p_target_kind:'DRAFT',p_target_id:draftId});if(eligibility.error||eligibility.data?.[0]?.can_delete!==true)fail(`Owner-region draft eligibility failed: ${eligibility.error?.message??eligibility.data?.[0]?.reason}`);
    const crossRegion=await localB.client.rpc('soft_delete_financial_new_project',{p_target_kind:'DRAFT',p_target_id:draftId,p_reason:'타 지자체 접근 차단 검증'});if(!crossRegion.error)fail('Cross-region deletion was not blocked.');
    const adminDelete=await admin.client.rpc('soft_delete_financial_new_project',{p_target_kind:'DRAFT',p_target_id:draftId,p_reason:'관리자 신규 권한 차단 검증'});if(!adminDelete.error)fail('Admin deletion was not blocked.');
    const [first,second]=await Promise.all([
      localA.client.rpc('soft_delete_financial_new_project',{p_target_kind:'DRAFT',p_target_id:draftId,p_reason:'중복 클릭 원자성 검증'}),
      localA.client.rpc('soft_delete_financial_new_project',{p_target_kind:'DRAFT',p_target_id:draftId,p_reason:'중복 클릭 원자성 검증'}),
    ]);const successes=[first,second].filter((item)=>!item.error);const failures=[first,second].filter((item)=>item.error);if(successes.length!==1||failures.length!==1)fail('Concurrent duplicate deletion did not result in exactly one success.');
    const afterDelete=await snapshot(pg);if(afterDelete.active_projects!==before.active_projects||afterDelete.active_requests!==before.active_requests||afterDelete.physical_requests!==before.physical_requests+1||afterDelete.deletion_events!==before.deletion_events+1||afterDelete.total_budget!==before.total_budget||afterDelete.allocation!==before.allocation||afterDelete.execution!==before.execution)fail('Soft deletion count or money invariants failed.');
    const stored=(await pg.query('select deleted_at is not null deleted,deletion_event_id from public.financial_new_project_requests where id=$1',[draftId])).rows[0];if(!stored?.deleted||!stored.deletion_event_id)fail('Deleted draft was not preserved with audit event.');
    const visible=await localA.client.rpc('get_financial_new_project_requests',{p_status:null});if(visible.error||visible.data.some((row)=>row.id===draftId))fail('Deleted draft remains visible in normal request list.');
    const applied=await pg.query(`select requests.id,requests.materialized_project_id from public.financial_new_project_requests requests join public.projects on projects.id=requests.materialized_project_id where requests.region_id=$1 and requests.status='APPLIED' and requests.deleted_at is null and projects.deleted_at is null order by requests.applied_at desc nulls last limit 1`,[localA.profile.region_id]);
    let blockedOfficial=null;if(applied.rows[0]){const projectId=applied.rows[0].materialized_project_id;const check=await localA.client.rpc('get_financial_new_project_deletion_eligibility',{p_target_kind:'PROJECT',p_target_id:projectId});if(check.error||check.data?.[0]?.can_delete!==false)fail('Completed funded new project was not marked non-deletable.');const blocked=await localA.client.rpc('soft_delete_financial_new_project',{p_target_kind:'PROJECT',p_target_id:projectId,p_reason:'거래 이력 차단 검증'});if(!blocked.error)fail('Completed funded new project deletion was not blocked.');const intact=(await pg.query('select deleted_at is null intact from public.projects where id=$1',[projectId])).rows[0]?.intact;if(!intact)fail('Blocked official project was modified.');blockedOfficial={project_id:projectId,reason:check.data[0].reason};}
    const result={status:'PASS',target:'TEST',database_ref:TEST_REF,production_touched:false,credentials_printed:false,draft:{id:draftId,name,region:localA.profile.region_name,deletion_event_id:stored.deletion_event_id},checks:{draft_only_count_changed:true,official_money_unchanged:true,cross_region_blocked:true,admin_not_granted_delete:true,duplicate_click_one_success:true,logical_row_and_event_preserved:true,normal_list_excludes_deleted:true,completed_funded_project_blocked:Boolean(blockedOfficial)},blocked_official:blockedOfficial,before,after_create:afterCreate,after_delete:afterDelete};
    const outputDir=path.resolve(process.cwd(),'test-results','new-project-delete');fs.mkdirSync(outputDir,{recursive:true});const output=path.join(outputDir,`uat-${stamp}.json`);fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});process.stdout.write(`${JSON.stringify({...result,artifact:path.relative(process.cwd(),output)},null,2)}\n`);
  }finally{await Promise.all([localA.client.auth.signOut(),localB.client.auth.signOut(),admin.client.auth.signOut()]);await pg.end();}
})().catch((error)=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
