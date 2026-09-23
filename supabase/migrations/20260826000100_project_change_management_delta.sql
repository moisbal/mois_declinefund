begin;

-- TEST-only metadata delta. This migration deliberately does not update any
-- monetary project column or any financial_* Ledger object.
do $$
begin
  if to_regclass('public.financial_ledger_runtime') is null then
    raise exception using errcode = '55000', message =
      'TEST Ledger runtime is required before applying project-change metadata delta.';
  end if;
  if not exists (
    select 1
    from public.financial_ledger_runtime
    where singleton
      and environment_kind = 'TEST'
      and bound_project_ref = 'reviewtestxxxxxxxxxx'
  ) then
    raise exception using errcode = '55000', message =
      'Refusing project-change metadata delta outside the bound TEST project.';
  end if;
end;
$$;

create temp table project_change_monetary_guard on commit drop as
select
  coalesce(sum(total_budget), 0)::numeric as total_budget,
  coalesce(sum(original_alloc), 0)::numeric as original_alloc,
  coalesce(sum(increase_amount), 0)::numeric as increase_amount,
  coalesce(sum(decrease_amount), 0)::numeric as decrease_amount,
  coalesce(sum(alloc), 0)::numeric as alloc,
  coalesce(sum(exec), 0)::numeric as exec,
  coalesce(sum(rate), 0)::numeric as rate
from public.projects;

create extension if not exists pg_trgm;

alter table public.projects
  add column if not exists primary_small_category_id uuid
    references public.small_categories(id) on delete restrict;

update public.projects as projects
set primary_small_category_id = selected.small_category_id
from (
  select distinct on (project_id) project_id, small_category_id
  from public.project_small_categories
  order by project_id, created_at nulls last, small_category_id
) as selected
where selected.project_id = projects.id
  and projects.primary_small_category_id is null;

create index if not exists idx_projects_primary_small_category_id
  on public.projects(primary_small_category_id);

create table if not exists public.project_related_small_categories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  small_category_id uuid not null references public.small_categories(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(project_id, small_category_id)
);

insert into public.project_related_small_categories (
  project_id, small_category_id, created_by, created_at
)
select
  assigned.project_id,
  assigned.small_category_id,
  coalesce(
    (select profiles.id from public.profiles as profiles
      join auth.users as users on users.id = profiles.id
      where profiles.role = 'admin'
      order by profiles.created_at nulls last, profiles.id limit 1),
    (select profiles.id from public.profiles as profiles
      join auth.users as users on users.id = profiles.id
      order by profiles.created_at nulls last, profiles.id limit 1)
  ),
  coalesce(assigned.created_at, now())
from public.project_small_categories as assigned
join public.projects as projects on projects.id = assigned.project_id
where assigned.small_category_id is distinct from projects.primary_small_category_id
  and exists (
    select 1 from public.profiles as profiles
    join auth.users as users on users.id = profiles.id
  )
on conflict (project_id, small_category_id) do nothing;

create index if not exists idx_project_related_small_categories_project
  on public.project_related_small_categories(project_id);
create index if not exists idx_project_related_small_categories_category
  on public.project_related_small_categories(small_category_id);

create table if not exists public.project_small_category_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  project_code text not null,
  region_id uuid not null references public.regions(id) on delete restrict,
  proposed_name varchar(100) not null,
  normalized_name text not null,
  proposal_reason text not null,
  recommended_middle_category_id uuid references public.middle_categories(id) on delete restrict,
  middle_category_review_required boolean not null default true,
  similar_small_categories jsonb not null default '[]'::jsonb,
  status varchar(20) not null default 'SUBMITTED'
    check (status in ('SUBMITTED', 'APPROVED', 'MAPPED', 'REJECTED')),
  approved_small_category_id uuid references public.small_categories(id) on delete restrict,
  mapped_small_category_id uuid references public.small_categories(id) on delete restrict,
  rejection_reason text,
  created_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_small_category_proposals_name_length
    check (char_length(btrim(proposed_name)) between 2 and 100),
  constraint project_small_category_proposals_reason_length
    check (char_length(btrim(proposal_reason)) between 5 and 1000),
  constraint project_small_category_proposals_resolution_check check (
    (status = 'SUBMITTED' and approved_small_category_id is null and mapped_small_category_id is null)
    or (status = 'APPROVED' and approved_small_category_id is not null and mapped_small_category_id is null)
    or (status = 'MAPPED' and approved_small_category_id is null and mapped_small_category_id is not null)
    or (status = 'REJECTED' and approved_small_category_id is null and mapped_small_category_id is null
      and nullif(btrim(rejection_reason), '') is not null)
  )
);

create unique index if not exists uq_pending_small_category_proposal
  on public.project_small_category_proposals(project_id, normalized_name)
  where status = 'SUBMITTED';
create index if not exists idx_small_category_proposals_review
  on public.project_small_category_proposals(status, created_at desc);
create index if not exists idx_small_category_proposals_region
  on public.project_small_category_proposals(region_id, created_at desc);

create table if not exists public.project_change_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  project_code text not null,
  region_id uuid not null references public.regions(id) on delete restrict,
  fiscal_year integer,
  change_kind varchar(40) not null
    check (change_kind in ('PROJECT_NAME', 'CLASSIFICATION', 'PROJECT_METADATA')),
  old_name text,
  new_name text,
  change_basis_code varchar(40),
  change_basis_label text,
  other_basis text,
  change_reason_codes text[] not null default array[]::text[],
  change_reason_labels text[] not null default array[]::text[],
  other_reason text,
  detail text,
  old_classification jsonb not null default '{}'::jsonb,
  new_classification jsonb not null default '{}'::jsonb,
  related_small_category_labels text[] not null default array[]::text[],
  similarity_candidate boolean not null default false,
  similarity_result varchar(40),
  ledger_transaction_reference text,
  monetary_impact bigint not null default 0 check (monetary_impact = 0),
  status varchar(30) not null default 'COMPLETED'
    check (status in ('COMPLETED', 'REVIEW_REQUIRED')),
  changed_by uuid not null references auth.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_project_change_events_project
  on public.project_change_events(project_id, changed_at desc);
create index if not exists idx_project_change_events_admin_filters
  on public.project_change_events(fiscal_year, region_id, changed_at desc);
create index if not exists idx_project_change_events_basis
  on public.project_change_events(change_basis_code, changed_at desc);
create index if not exists idx_project_change_events_reasons
  on public.project_change_events using gin(change_reason_codes);

create table if not exists public.project_similarity_decisions (
  id uuid primary key default gen_random_uuid(),
  source_project_id uuid not null references public.projects(id) on delete restrict,
  source_project_name text not null,
  candidate_set_hash text not null,
  candidate_project_id uuid references public.projects(id) on delete restrict,
  candidate_similarity numeric(6,5),
  relationship_type varchar(40) not null
    check (relationship_type in ('SAME_LOGICAL_PROJECT', 'SUBPROJECT', 'SEPARATE', 'UNDECIDED')),
  decision_note text,
  shown_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete restrict,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint project_similarity_decisions_candidate_check check (
    relationship_type in ('SEPARATE', 'UNDECIDED') or candidate_project_id is not null
  )
);

create index if not exists idx_project_similarity_source_version
  on public.project_similarity_decisions(source_project_id, candidate_set_hash, source_project_name);
create index if not exists idx_project_similarity_candidate
  on public.project_similarity_decisions(candidate_project_id);

create or replace function public.project_change_basis_label(p_code text)
returns text language sql immutable as $$
  select case p_code
    when 'LOCAL_NOTICE' then '지자체 → 조합 통보'
    when 'FUND_REVIEW_APPROVAL' then '기금심의 후 승인'
    when 'OTHER' then '기타'
    else null
  end
$$;

create or replace function public.project_change_reason_label(p_code text)
returns text language sql immutable as $$
  select case p_code
    when 'CONTENT_CHANGE' then '사업내용 변경'
    when 'BUDGET_ADJUSTMENT' then '사업간 예산 조정'
    when 'SUBPROJECT_ADJUSTMENT' then '기금사업 내 세부사업 조정'
    when 'UNDERPERFORMING_REPLACEMENT' then '기존사업 추진 부진으로 신규사업 추진'
    when 'OTHER' then '기타'
    else null
  end
$$;

create or replace function public.project_classification_snapshot(p_project_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'large_category_id', projects.large_category_id,
    'large_category_name', large_categories.name,
    'middle_category_id', projects.middle_category_id,
    'middle_category_name', middle_categories.name,
    'primary_small_category_id', projects.primary_small_category_id,
    'primary_small_category_name', primary_small.name,
    'related_small_categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', small.id, 'name', small.name) order by small.name)
      from public.project_related_small_categories as related
      join public.small_categories as small on small.id = related.small_category_id
      where related.project_id = projects.id
    ), '[]'::jsonb),
    'business_type', projects.business_type
  )
  from public.projects as projects
  left join public.large_categories on large_categories.id = projects.large_category_id
  left join public.middle_categories on middle_categories.id = projects.middle_category_id
  left join public.small_categories as primary_small on primary_small.id = projects.primary_small_category_id
  where projects.id = p_project_id
$$;

create or replace function public.project_metadata_assert_access(p_project_id uuid)
returns public.projects
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_role text;
  v_region_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 사업정보를 변경할 수 있습니다.';
  end if;
  v_role := public.current_user_role()::text;
  v_region_id := public.current_user_region_id();
  if v_role not in ('admin', 'local_user') then
    raise exception using errcode = '42501', message = '사업정보 변경 권한이 없습니다.';
  end if;
  select * into v_project from public.projects
  where id = p_project_id and project_code is not null;
  if not found then
    raise exception using errcode = 'P0002', message = '사업을 찾을 수 없습니다.';
  end if;
  if v_role = 'local_user' and v_project.region_id is distinct from v_region_id then
    raise exception using errcode = '42501', message = '본인 지역의 사업만 변경할 수 있습니다.';
  end if;
  return v_project;
end;
$$;

create or replace function public.get_project_similarity_candidates(
  p_project_id uuid,
  p_new_name text,
  p_limit integer default 5
)
returns table (
  candidate_project_id uuid,
  project_name text,
  project_code text,
  fiscal_year integer,
  region_name text,
  classification_name text,
  similarity_score numeric,
  candidate_set_hash text,
  should_prompt boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_name text := btrim(coalesce(p_new_name, ''));
  v_hash text;
begin
  v_project := public.project_metadata_assert_access(p_project_id);
  if char_length(v_name) not between 2 and 250 then
    raise exception using errcode = '22023', message = '비교할 사업명은 2~250자로 입력하세요.';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 5), 1), 10);

  with ranked as (
    select
      candidate.id,
      row_number() over (
        order by
          (candidate.region_id = v_project.region_id) desc,
          (abs(coalesce(candidate.year, 0) - coalesce(v_project.year, 0)) <= 1) desc,
          similarity(coalesce(candidate.detail_project_name, candidate.fund_project_name, candidate.project_name, ''), v_name) desc,
          candidate.project_code
      ) as position
    from public.projects as candidate
    where candidate.id <> v_project.id
      and candidate.project_code is not null
      and similarity(coalesce(candidate.detail_project_name, candidate.fund_project_name, candidate.project_name, ''), v_name) >= 0.20
    limit p_limit
  )
  select md5(coalesce(string_agg(id::text, ',' order by position), '')) into v_hash from ranked;

  return query
  with ranked as (
    select
      candidate.id,
      coalesce(candidate.detail_project_name, candidate.fund_project_name, candidate.project_name, '-') as display_name,
      candidate.project_code,
      candidate.year,
      candidate.region_id,
      candidate.large_category_id,
      similarity(coalesce(candidate.detail_project_name, candidate.fund_project_name, candidate.project_name, ''), v_name)::numeric as score,
      row_number() over (
        order by
          (candidate.region_id = v_project.region_id) desc,
          (abs(coalesce(candidate.year, 0) - coalesce(v_project.year, 0)) <= 1) desc,
          similarity(coalesce(candidate.detail_project_name, candidate.fund_project_name, candidate.project_name, ''), v_name) desc,
          candidate.project_code
      ) as position
    from public.projects as candidate
    where candidate.id <> v_project.id
      and candidate.project_code is not null
      and similarity(coalesce(candidate.detail_project_name, candidate.fund_project_name, candidate.project_name, ''), v_name) >= 0.20
    limit p_limit
  )
  select
    ranked.id,
    ranked.display_name,
    ranked.project_code,
    ranked.year,
    regions.display_name,
    large_categories.name,
    ranked.score,
    v_hash,
    not exists (
      select 1 from public.project_similarity_decisions as decisions
      where decisions.source_project_id = v_project.id
        and decisions.source_project_name = v_name
        and decisions.candidate_set_hash = v_hash
        and decisions.relationship_type <> 'UNDECIDED'
    )
  from ranked
  left join public.regions on regions.id = ranked.region_id
  left join public.large_categories on large_categories.id = ranked.large_category_id
  order by ranked.position;
end;
$$;

create or replace function public.record_project_similarity_decision(
  p_project_id uuid,
  p_source_project_name text,
  p_candidate_set_hash text,
  p_candidate_project_id uuid,
  p_similarity numeric,
  p_relationship_type text,
  p_decision_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_decision_id uuid;
  v_relationship text := upper(btrim(coalesce(p_relationship_type, '')));
begin
  v_project := public.project_metadata_assert_access(p_project_id);
  if v_relationship not in ('SAME_LOGICAL_PROJECT', 'SUBPROJECT', 'SEPARATE', 'UNDECIDED') then
    raise exception using errcode = '22023', message = '유사사업 관계유형이 올바르지 않습니다.';
  end if;
  if v_relationship in ('SAME_LOGICAL_PROJECT', 'SUBPROJECT') and p_candidate_project_id is null then
    raise exception using errcode = '22023', message = '연계할 후보 사업을 선택하세요.';
  end if;
  if p_candidate_project_id = p_project_id then
    raise exception using errcode = '22023', message = '동일한 사업을 후보로 선택할 수 없습니다.';
  end if;
  if nullif(btrim(coalesce(p_candidate_set_hash, '')), '') is null then
    raise exception using errcode = '22023', message = '후보집합 식별값이 필요합니다.';
  end if;

  insert into public.project_similarity_decisions (
    source_project_id, source_project_name, candidate_set_hash,
    candidate_project_id, candidate_similarity, relationship_type,
    decision_note, shown_at, decided_by, decided_at
  ) values (
    v_project.id, btrim(p_source_project_name), p_candidate_set_hash,
    p_candidate_project_id, p_similarity, v_relationship,
    nullif(btrim(coalesce(p_decision_note, '')), ''), now(), auth.uid(),
    case when v_relationship = 'UNDECIDED' then null else now() end
  ) returning id into v_decision_id;

  insert into public.audit_logs (
    project_id, region_id, action, field_name, old_value, new_value, changed_by, changed_at
  ) values (
    v_project.id, v_project.region_id, 'REVIEW_SIMILAR_PROJECT', 'project_similarity', null,
    jsonb_build_object(
      'candidate_project_id', p_candidate_project_id,
      'relationship_type', v_relationship,
      'candidate_set_hash', p_candidate_set_hash
    )::text,
    auth.uid(), now()
  );

  -- This is recommendation metadata only. It intentionally does not call the
  -- immutable financial lineage verification/assignment functions.
  return v_decision_id;
end;
$$;

create or replace function public.submit_project_small_category_proposal(
  p_project_id uuid,
  p_proposed_name text,
  p_proposal_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_normalized text;
  v_middle_ids uuid[];
  v_recommended_middle_id uuid;
  v_similar jsonb;
  v_proposal_id uuid;
begin
  v_project := public.project_metadata_assert_access(p_project_id);
  if char_length(btrim(coalesce(p_proposed_name, ''))) not between 2 and 100 then
    raise exception using errcode = '22023', message = '제안 소분류명은 2~100자로 입력하세요.';
  end if;
  if char_length(btrim(coalesce(p_proposal_reason, ''))) not between 5 and 1000 then
    raise exception using errcode = '22023', message = '제안 사유는 5~1000자로 입력하세요.';
  end if;
  v_normalized := public.normalize_custom_category_text(p_proposed_name);

  select array_agg(distinct small.middle_category_id)
  into v_middle_ids
  from (
    select projects.primary_small_category_id as small_category_id
    from public.projects as projects where projects.id = v_project.id
    union all
    select related.small_category_id
    from public.project_related_small_categories as related
    where related.project_id = v_project.id
  ) as selected
  join public.small_categories as small on small.id = selected.small_category_id;

  if coalesce(array_length(v_middle_ids, 1), 0) = 1 then
    v_recommended_middle_id := v_middle_ids[1];
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', small.id,
    'name', small.name,
    'middle_category_id', small.middle_category_id,
    'similarity', similarity(small.name, btrim(p_proposed_name))
  ) order by similarity(small.name, btrim(p_proposed_name)) desc), '[]'::jsonb)
  into v_similar
  from (
    select * from public.small_categories
    where similarity(name, btrim(p_proposed_name)) >= 0.20
    order by similarity(name, btrim(p_proposed_name)) desc
    limit 5
  ) as small;

  insert into public.project_small_category_proposals (
    project_id, project_code, region_id, proposed_name, normalized_name,
    proposal_reason, recommended_middle_category_id,
    middle_category_review_required, similar_small_categories, created_by
  ) values (
    v_project.id, v_project.project_code, v_project.region_id,
    btrim(p_proposed_name), v_normalized, btrim(p_proposal_reason),
    v_recommended_middle_id, v_recommended_middle_id is null, v_similar, auth.uid()
  ) returning id into v_proposal_id;

  insert into public.audit_logs (
    project_id, region_id, action, field_name, old_value, new_value, changed_by, changed_at
  ) values (
    v_project.id, v_project.region_id, 'SUBMIT_SMALL_CATEGORY_PROPOSAL',
    'small_category_proposal', null,
    jsonb_build_object('proposal_id', v_proposal_id, 'proposed_name', btrim(p_proposed_name),
      'proposal_reason', btrim(p_proposal_reason),
      'recommended_middle_category_id', v_recommended_middle_id)::text,
    auth.uid(), now()
  );
  return v_proposal_id;
end;
$$;

create or replace function public.review_project_small_category_proposal(
  p_proposal_id uuid,
  p_action text,
  p_middle_category_id uuid default null,
  p_existing_small_category_id uuid default null,
  p_rejection_reason text default null
)
returns table(status text, resolved_small_category_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_proposal public.project_small_category_proposals%rowtype;
  v_action text := upper(btrim(coalesce(p_action, '')));
  v_small_category_id uuid;
  v_large_category_id uuid;
  v_code text;
begin
  if auth.uid() is null or public.current_user_role()::text <> 'admin' then
    raise exception using errcode = '42501', message = '관리자만 소분류 제안을 처리할 수 있습니다.';
  end if;
  select * into v_proposal from public.project_small_category_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = '소분류 제안을 찾을 수 없습니다.';
  end if;
  if v_proposal.status <> 'SUBMITTED' then
    raise exception using errcode = '55000', message = '이미 처리된 소분류 제안입니다.';
  end if;

  if v_action = 'APPROVE' then
    if p_middle_category_id is null then
      raise exception using errcode = '22023', message = '신규 승인 시 중분류를 지정하세요.';
    end if;
    select large_category_id into v_large_category_id
    from public.middle_categories where id = p_middle_category_id;
    if not found then
      raise exception using errcode = '22023', message = '유효한 중분류를 선택하세요.';
    end if;
    if exists (
      select 1 from public.small_categories
      where middle_category_id = p_middle_category_id
        and public.normalize_custom_category_text(name) = v_proposal.normalized_name
    ) then
      raise exception using errcode = '23505', message = '동일 중분류에 같은 소분류가 이미 있습니다. 기존 분류 매핑을 사용하세요.';
    end if;
    v_code := 'USR-' || upper(substr(md5(v_proposal.id::text), 1, 10));
    insert into public.small_categories(code, name, large_category_id, middle_category_id)
    values (v_code, v_proposal.proposed_name, v_large_category_id, p_middle_category_id)
    returning id into v_small_category_id;
    update public.project_small_category_proposals set
      status = 'APPROVED', approved_small_category_id = v_small_category_id,
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
    where id = v_proposal.id;
  elsif v_action = 'MAP' then
    if p_existing_small_category_id is null
       or not exists (select 1 from public.small_categories where id = p_existing_small_category_id) then
      raise exception using errcode = '22023', message = '매핑할 기존 소분류를 선택하세요.';
    end if;
    v_small_category_id := p_existing_small_category_id;
    update public.project_small_category_proposals set
      status = 'MAPPED', mapped_small_category_id = v_small_category_id,
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
    where id = v_proposal.id;
  elsif v_action = 'REJECT' then
    if char_length(btrim(coalesce(p_rejection_reason, ''))) < 2 then
      raise exception using errcode = '22023', message = '반려 사유를 입력하세요.';
    end if;
    update public.project_small_category_proposals set
      status = 'REJECTED', rejection_reason = btrim(p_rejection_reason),
      reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
    where id = v_proposal.id;
  else
    raise exception using errcode = '22023', message = '처리 방식은 승인, 기존분류 매핑, 반려 중 하나여야 합니다.';
  end if;

  insert into public.audit_logs (
    project_id, region_id, action, field_name, old_value, new_value, changed_by, changed_at
  ) values (
    v_proposal.project_id, v_proposal.region_id, 'REVIEW_SMALL_CATEGORY_PROPOSAL',
    'small_category_proposal',
    jsonb_build_object('proposal_id', v_proposal.id, 'status', v_proposal.status)::text,
    jsonb_build_object('action', v_action, 'resolved_small_category_id', v_small_category_id,
      'rejection_reason', nullif(btrim(coalesce(p_rejection_reason, '')), ''))::text,
    auth.uid(), now()
  );
  return query select v_action, v_small_category_id;
end;
$$;

-- The previous custom-category migration required every historical custom
-- suggestion to stay under the project's current parent. Those rows are now
-- review records, not active classification. Validate the representative
-- category instead so a legitimate parent change is not blocked by history.
create or replace function public.validate_project_classification_parent()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_primary_large_category_id uuid;
  v_primary_middle_category_id uuid;
begin
  if (new.large_category_id is null) is distinct from (new.middle_category_id is null) then
    raise exception using
      errcode = '23514',
      message = '대분류와 중분류는 함께 저장되어야 합니다.';
  end if;

  if new.primary_small_category_id is not null then
    select small_categories.large_category_id, small_categories.middle_category_id
      into v_primary_large_category_id, v_primary_middle_category_id
    from public.small_categories
    where small_categories.id = new.primary_small_category_id;

    if not found
       or v_primary_large_category_id is distinct from new.large_category_id
       or v_primary_middle_category_id is distinct from new.middle_category_id then
      raise exception using
        errcode = '23514',
        message = '대표 소분류는 사업의 대분류 및 중분류와 일치해야 합니다.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.update_my_project_metadata_v2(
  p_project_id uuid,
  p_detail_project_name text,
  p_project_period text,
  p_project_start_year integer,
  p_status text,
  p_related_projects jsonb,
  p_primary_small_category_id uuid,
  p_related_small_category_ids uuid[],
  p_business_type text,
  p_change_basis_code text default null,
  p_other_basis text default null,
  p_change_reason_codes text[] default null,
  p_other_reason text default null,
  p_change_detail text default null,
  p_similarity_candidate boolean default false,
  p_save_mode text default 'SAVE'
)
returns table (
  id uuid,
  project_code text,
  alloc bigint,
  exec bigint,
  rate numeric,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project public.projects%rowtype;
  v_before public.projects%rowtype;
  v_primary public.small_categories%rowtype;
  v_related_ids uuid[];
  v_reason_codes text[] := coalesce(p_change_reason_codes, array[]::text[]);
  v_reason_labels text[];
  v_basis_code text := upper(btrim(coalesce(p_change_basis_code, '')));
  v_basis_label text;
  v_name_changed boolean;
  v_classification_changed boolean;
  v_old_classification jsonb;
  v_new_classification jsonb;
  v_related_labels text[];
  v_related jsonb;
  v_related_item jsonb;
  v_related_name text;
  v_related_names text[] := array[]::text[];
  v_save_mode text := upper(btrim(coalesce(p_save_mode, 'SAVE')));
  v_now timestamptz := clock_timestamp();
  v_change_kind text;
begin
  v_project := public.project_metadata_assert_access(p_project_id);
  select * into v_before from public.projects where id = p_project_id for update;
  if v_save_mode not in ('DRAFT', 'SAVE') then
    raise exception using errcode = '22023', message = '저장 방식이 올바르지 않습니다.';
  end if;
  if char_length(btrim(coalesce(p_detail_project_name, ''))) not between 2 and 250 then
    raise exception using errcode = '22023', message = '변경 사업명은 2~250자로 입력하세요.';
  end if;
  if char_length(btrim(coalesce(p_project_period, ''))) not between 2 and 120 then
    raise exception using errcode = '22023', message = '사업기간은 2~120자로 입력하세요.';
  end if;
  if p_project_start_year is null or p_project_start_year < 1900
     or (v_before.year is not null and p_project_start_year > v_before.year) then
    raise exception using errcode = '22023', message = '시작연도는 사업연도 이하로 입력하세요.';
  end if;
  if p_status not in ('정상추진', '지연', '완료', '추진곤란') then
    raise exception using errcode = '22023', message = '집행상태 값이 올바르지 않습니다.';
  end if;
  if p_business_type not in ('HW', 'SW', 'COMPOSITE') then
    raise exception using errcode = '22023', message = '사업유형 값이 올바르지 않습니다.';
  end if;
  select * into v_primary from public.small_categories where id = p_primary_small_category_id;
  if not found then
    raise exception using errcode = '22023', message = '대표 소분류를 1개 선택하세요.';
  end if;

  select coalesce(array_agg(distinct selected.id order by selected.id), array[]::uuid[])
  into v_related_ids
  from unnest(coalesce(p_related_small_category_ids, array[]::uuid[])) as selected(id)
  where selected.id is distinct from p_primary_small_category_id;
  if (select count(*) from public.small_categories where id = any(v_related_ids))
     <> coalesce(array_length(v_related_ids, 1), 0) then
    raise exception using errcode = '22023', message = '관련 소분류에 승인되지 않은 값이 있습니다.';
  end if;

  v_name_changed := btrim(p_detail_project_name) is distinct from
    coalesce(nullif(btrim(v_before.detail_project_name), ''), nullif(btrim(v_before.fund_project_name), ''), btrim(v_before.project_name));
  if v_name_changed then
    v_basis_label := public.project_change_basis_label(v_basis_code);
    if v_basis_label is null then
      raise exception using errcode = '22023', message = '사업명 변경 근거를 선택하세요.';
    end if;
    if v_basis_code = 'OTHER' and char_length(btrim(coalesce(p_other_basis, ''))) < 2 then
      raise exception using errcode = '22023', message = '기타 변경 근거를 입력하세요.';
    end if;
    if coalesce(array_length(v_reason_codes, 1), 0) = 0 then
      raise exception using errcode = '22023', message = '사업명 변경 사유를 1개 이상 선택하세요.';
    end if;
    if exists (select 1 from unnest(v_reason_codes) as reason(code)
      where public.project_change_reason_label(reason.code) is null) then
      raise exception using errcode = '22023', message = '사업명 변경 사유 값이 올바르지 않습니다.';
    end if;
    if 'OTHER' = any(v_reason_codes) and char_length(btrim(coalesce(p_other_reason, ''))) < 2 then
      raise exception using errcode = '22023', message = '기타 변경 사유를 입력하세요.';
    end if;
    select array_agg(public.project_change_reason_label(reason.code) order by reason.ordinality)
    into v_reason_labels
    from unnest(v_reason_codes) with ordinality as reason(code, ordinality);
  end if;

  v_old_classification := public.project_classification_snapshot(v_before.id);
  v_classification_changed := v_before.primary_small_category_id is distinct from p_primary_small_category_id
    or v_before.business_type is distinct from p_business_type
    or (select coalesce(array_agg(small_category_id order by small_category_id), array[]::uuid[])
        from public.project_related_small_categories where project_id = v_before.id)
       is distinct from v_related_ids;

  -- Compatibility table now carries the representative category only. Related
  -- categories live separately and are never joined into official money totals.
  delete from public.project_small_categories where project_id = v_before.id;
  delete from public.project_related_small_categories where project_id = v_before.id;

  update public.projects set
    detail_project_name = btrim(p_detail_project_name),
    project_period = btrim(p_project_period),
    project_start_year = p_project_start_year,
    status = p_status,
    large_category_id = v_primary.large_category_id,
    middle_category_id = v_primary.middle_category_id,
    primary_small_category_id = v_primary.id,
    business_type = p_business_type,
    updated_at = v_now
  where projects.id = v_before.id;

  insert into public.project_small_categories(project_id, small_category_id, created_at)
  values (v_before.id, v_primary.id, v_now);
  insert into public.project_related_small_categories(project_id, small_category_id, created_by, created_at)
  select v_before.id, selected.id, auth.uid(), v_now from unnest(v_related_ids) as selected(id);

  v_related := coalesce(p_related_projects, '[]'::jsonb);
  if jsonb_typeof(v_related) <> 'array' then
    raise exception using errcode = '22023', message = '연계사업 목록 형식이 올바르지 않습니다.';
  end if;
  for v_related_item in select value from jsonb_array_elements(v_related)
  loop
    v_related_name := btrim(coalesce(v_related_item->>'project_name', ''));
    if char_length(v_related_name) not between 2 and 200 or v_related_name = any(v_related_names) then
      raise exception using errcode = '22023', message = '연계사업명은 2~200자로 중복 없이 입력하세요.';
    end if;
    v_related_names := array_append(v_related_names, v_related_name);
    if (v_related_item->>'total_budget')::numeric < 0
       or (v_related_item->>'regional_fund_alloc')::numeric < 0
       or (v_related_item->>'local_fund_alloc')::numeric < 0 then
      raise exception using errcode = '22023', message = '연계사업 참고 금액은 0 이상이어야 합니다.';
    end if;
  end loop;
  delete from public.project_related_projects where project_id = v_before.id;
  insert into public.project_related_projects(
    project_id, project_name, total_budget, regional_fund_alloc, local_fund_alloc, created_at, updated_at
  )
  select
    v_before.id,
    btrim(item.project_name),
    item.total_budget,
    item.regional_fund_alloc,
    item.local_fund_alloc,
    v_now,
    v_now
  from jsonb_to_recordset(v_related) as item(
    project_name text, total_budget bigint, regional_fund_alloc bigint, local_fund_alloc bigint
  );

  v_new_classification := public.project_classification_snapshot(v_before.id);
  select coalesce(array_agg(small.name order by small.name), array[]::text[])
  into v_related_labels
  from public.project_related_small_categories as related
  join public.small_categories as small on small.id = related.small_category_id
  where related.project_id = v_before.id;

  if v_name_changed or v_classification_changed then
    v_change_kind := case
      when v_name_changed and v_classification_changed then 'PROJECT_METADATA'
      when v_name_changed then 'PROJECT_NAME'
      else 'CLASSIFICATION'
    end;
    insert into public.project_change_events (
      project_id, project_code, region_id, fiscal_year, change_kind,
      old_name, new_name, change_basis_code, change_basis_label, other_basis,
      change_reason_codes, change_reason_labels, other_reason, detail,
      old_classification, new_classification, related_small_category_labels,
      similarity_candidate, similarity_result, monetary_impact, status,
      changed_by, changed_at
    ) values (
      v_before.id, v_before.project_code, v_before.region_id, v_before.year, v_change_kind,
      coalesce(nullif(btrim(v_before.detail_project_name), ''), nullif(btrim(v_before.fund_project_name), ''), btrim(v_before.project_name)),
      btrim(p_detail_project_name),
      case when v_name_changed then v_basis_code else null end,
      case when v_name_changed then v_basis_label else null end,
      case when v_name_changed and v_basis_code = 'OTHER' then nullif(btrim(p_other_basis), '') else null end,
      case when v_name_changed then v_reason_codes else array[]::text[] end,
      case when v_name_changed then coalesce(v_reason_labels, array[]::text[]) else array[]::text[] end,
      case when v_name_changed and 'OTHER' = any(v_reason_codes) then nullif(btrim(p_other_reason), '') else null end,
      nullif(btrim(coalesce(p_change_detail, '')), ''),
      v_old_classification, v_new_classification, v_related_labels,
      p_similarity_candidate,
      (select relationship_type from public.project_similarity_decisions
       where source_project_id = v_before.id and source_project_name = btrim(p_detail_project_name)
       order by created_at desc limit 1),
      0,
      case when p_similarity_candidate and not exists (
        select 1 from public.project_similarity_decisions
        where source_project_id = v_before.id
          and source_project_name = btrim(p_detail_project_name)
          and relationship_type <> 'UNDECIDED'
      ) then 'REVIEW_REQUIRED' else 'COMPLETED' end,
      auth.uid(), v_now
    );
  end if;

  insert into public.audit_logs (
    project_id, region_id, action, field_name, old_value, new_value, changed_by, changed_at
  ) values (
    v_before.id, v_before.region_id, 'UPDATE_PROJECT_METADATA', 'project_metadata',
    jsonb_build_object('name', coalesce(v_before.detail_project_name, v_before.fund_project_name, v_before.project_name),
      'classification', v_old_classification, 'save_mode', v_save_mode)::text,
    jsonb_build_object('name', btrim(p_detail_project_name), 'classification', v_new_classification,
      'change_basis_code', case when v_name_changed then v_basis_code else null end,
      'change_reason_codes', case when v_name_changed then v_reason_codes else array[]::text[] end,
      'save_mode', v_save_mode)::text,
    auth.uid(), v_now
  );

  return query
  select projects.id, projects.project_code, projects.alloc, projects.exec, projects.rate, projects.updated_at
  from public.projects where projects.id = v_before.id;
end;
$$;

create or replace view public.project_primary_classification_statistics
with (security_invoker = true) as
select
  projects.id as project_id,
  projects.region_id,
  projects.year as fiscal_year,
  projects.primary_small_category_id,
  small_categories.name as primary_small_category_name,
  projects.alloc,
  projects.exec
from public.projects
left join public.small_categories on small_categories.id = projects.primary_small_category_id;

comment on view public.project_primary_classification_statistics is
  'Official classification grain: exactly one row per project. Related categories are intentionally excluded from monetary aggregation.';

alter table public.project_related_small_categories enable row level security;
alter table public.project_small_category_proposals enable row level security;
alter table public.project_change_events enable row level security;
alter table public.project_similarity_decisions enable row level security;

create policy project_related_small_categories_select_region_or_admin
  on public.project_related_small_categories for select to authenticated using (
    exists (
      select 1 from public.profiles
      join public.projects on projects.id = project_related_small_categories.project_id
      where profiles.id = auth.uid()
        and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
    )
  );
create policy project_small_category_proposals_select_region_or_admin
  on public.project_small_category_proposals for select to authenticated using (
    exists (select 1 from public.profiles where id = auth.uid()
      and (role = 'admin' or region_id = project_small_category_proposals.region_id))
  );
create policy project_change_events_select_region_or_admin
  on public.project_change_events for select to authenticated using (
    exists (select 1 from public.profiles where id = auth.uid()
      and (role = 'admin' or region_id = project_change_events.region_id))
  );
create policy project_similarity_decisions_select_region_or_admin
  on public.project_similarity_decisions for select to authenticated using (
    exists (
      select 1 from public.profiles
      join public.projects on projects.id = project_similarity_decisions.source_project_id
      where profiles.id = auth.uid()
        and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
    )
  );

revoke all on table
  public.project_related_small_categories,
  public.project_small_category_proposals,
  public.project_change_events,
  public.project_similarity_decisions
from public, anon, authenticated;
grant select on table
  public.project_related_small_categories,
  public.project_small_category_proposals,
  public.project_change_events,
  public.project_similarity_decisions
to authenticated;
revoke all on public.project_primary_classification_statistics from public, anon;
grant select on public.project_primary_classification_statistics to authenticated;

revoke all on function public.project_change_basis_label(text) from public, anon;
revoke all on function public.project_change_reason_label(text) from public, anon;
revoke all on function public.project_classification_snapshot(uuid) from public, anon;
revoke all on function public.project_metadata_assert_access(uuid) from public, anon, authenticated;
revoke all on function public.get_project_similarity_candidates(uuid, text, integer) from public, anon;
revoke all on function public.record_project_similarity_decision(uuid, text, text, uuid, numeric, text, text) from public, anon;
revoke all on function public.submit_project_small_category_proposal(uuid, text, text) from public, anon;
revoke all on function public.review_project_small_category_proposal(uuid, text, uuid, uuid, text) from public, anon;
revoke all on function public.update_my_project_metadata_v2(
  uuid, text, text, integer, text, jsonb, uuid, uuid[], text,
  text, text, text[], text, text, boolean, text
) from public, anon;

grant execute on function public.get_project_similarity_candidates(uuid, text, integer) to authenticated;
grant execute on function public.record_project_similarity_decision(uuid, text, text, uuid, numeric, text, text) to authenticated;
grant execute on function public.submit_project_small_category_proposal(uuid, text, text) to authenticated;
grant execute on function public.review_project_small_category_proposal(uuid, text, uuid, uuid, text) to authenticated;
grant execute on function public.update_my_project_metadata_v2(
  uuid, text, text, integer, text, jsonb, uuid, uuid[], text,
  text, text, text[], text, text, boolean, text
) to authenticated;

do $$
declare
  v_before project_change_monetary_guard%rowtype;
  v_after record;
begin
  select * into v_before from project_change_monetary_guard;
  select
    coalesce(sum(total_budget), 0)::numeric as total_budget,
    coalesce(sum(original_alloc), 0)::numeric as original_alloc,
    coalesce(sum(increase_amount), 0)::numeric as increase_amount,
    coalesce(sum(decrease_amount), 0)::numeric as decrease_amount,
    coalesce(sum(alloc), 0)::numeric as alloc,
    coalesce(sum(exec), 0)::numeric as exec,
    coalesce(sum(rate), 0)::numeric as rate
  into v_after
  from public.projects;
  if row(v_before.total_budget, v_before.original_alloc, v_before.increase_amount, v_before.decrease_amount, v_before.alloc, v_before.exec, v_before.rate)
     is distinct from
     row(v_after.total_budget, v_after.original_alloc, v_after.increase_amount, v_after.decrease_amount, v_after.alloc, v_after.exec, v_after.rate) then
    raise exception using errcode = '23514', message = 'Metadata delta changed project monetary totals.';
  end if;
end;
$$;

commit;
