-- DRAFT MIGRATION ONLY: do not execute without reviewing the live Supabase schema and backups.
--
-- This migration is additive. It deliberately leaves the imported legacy
-- projects.category (legacy large category) and projects.project_type
-- (legacy free-text small category) columns untouched.
--
-- `business_type` is the new, controlled HW/SW/COMPOSITE value. It is not
-- called project_type because that name is already used by imported data.

begin;

create table if not exists public.large_categories (
  id uuid primary key default gen_random_uuid(),
  code varchar(64) not null unique,
  name varchar(100) not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.middle_categories (
  id uuid primary key default gen_random_uuid(),
  code varchar(64) not null unique,
  name varchar(100) not null,
  large_category_id uuid not null references public.large_categories(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, large_category_id),
  unique (large_category_id, name)
);

create table if not exists public.small_categories (
  id uuid primary key default gen_random_uuid(),
  code varchar(64) not null unique,
  name varchar(100) not null,
  large_category_id uuid not null references public.large_categories(id) on delete restrict,
  middle_category_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (middle_category_id, name),
  constraint small_categories_middle_large_fkey
    foreign key (middle_category_id, large_category_id)
    references public.middle_categories(id, large_category_id)
    on delete restrict
);

alter table public.projects
  add column if not exists large_category_id uuid,
  add column if not exists middle_category_id uuid,
  add column if not exists business_type varchar(16);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_large_category_fkey'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_large_category_fkey
      foreign key (large_category_id)
      references public.large_categories(id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_middle_large_fkey'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_middle_large_fkey
      foreign key (middle_category_id, large_category_id)
      references public.middle_categories(id, large_category_id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_classification_pair_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_classification_pair_check
      check (
        (large_category_id is null and middle_category_id is null)
        or (large_category_id is not null and middle_category_id is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'projects_business_type_check'
      and conrelid = 'public.projects'::regclass
  ) then
    alter table public.projects
      add constraint projects_business_type_check
      check (business_type is null or business_type in ('HW', 'SW', 'COMPOSITE'));
  end if;
end;
$$;

create table if not exists public.project_small_categories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  small_category_id uuid not null references public.small_categories(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (project_id, small_category_id)
);

create index if not exists idx_projects_large_category_id
  on public.projects(large_category_id);
create index if not exists idx_projects_middle_category_id
  on public.projects(middle_category_id);
create index if not exists idx_projects_business_type
  on public.projects(business_type);
create index if not exists idx_project_small_categories_project_id
  on public.project_small_categories(project_id);
create index if not exists idx_project_small_categories_small_category_id
  on public.project_small_categories(small_category_id);

-- Seed only the master values explicitly supplied in the implementation request.
-- Add the remaining middle/small categories through these master tables; do not
-- infer or bulk-map values from the 3,895 existing projects in this migration.
insert into public.large_categories (code, name)
values
  ('EDUCATION', '교육'),
  ('CHILDCARE', '보육'),
  ('LOCAL_HEALTHCARE', '지역의료'),
  ('CULTURE_TOURISM', '문화관광'),
  ('INDUSTRY_JOBS', '산업일자리'),
  ('HOUSING', '주거'),
  ('TRANSPORT', '교통'),
  ('OTHER', '기타')
on conflict (code) do nothing;

insert into public.middle_categories (code, name, large_category_id)
select values_to_insert.code, values_to_insert.name, large_categories.id
from (
  values
    ('EDU_LOCAL_SCHOOL', '지역학교 활성화', 'EDUCATION'),
    ('HOUSING_PUBLIC', '공공주택 공급', 'HOUSING'),
    ('IND_BUSINESS_STARTUP', '기업·창업지원', 'INDUSTRY_JOBS'),
    ('IND_INDUSTRIAL_BASE', '산업기반', 'INDUSTRY_JOBS'),
    ('IND_PRIMARY_INDUSTRY', '농림어업', 'INDUSTRY_JOBS'),
    ('IND_STARTUP_SUPPORT', '창업지원', 'INDUSTRY_JOBS')
) as values_to_insert(code, name, large_code)
join public.large_categories as large_categories
  on large_categories.code = values_to_insert.large_code
on conflict (code) do nothing;

insert into public.small_categories (code, name, large_category_id, middle_category_id)
select
  values_to_insert.code,
  values_to_insert.name,
  large_categories.id,
  middle_categories.id
from (
  values
    ('EDU_RURAL_STUDY', '농산어촌 유학', 'EDUCATION', 'EDU_LOCAL_SCHOOL'),
    ('EDU_SCHOOL_PROGRAM', '학교연계 프로그램', 'EDUCATION', 'EDU_LOCAL_SCHOOL'),
    ('HOUSING_PUBLIC_RENTAL', '공공임대주택', 'HOUSING', 'HOUSING_PUBLIC'),
    ('HOUSING_YOUTH', '청년주택', 'HOUSING', 'HOUSING_PUBLIC'),
    ('IND_CORPORATE_SUPPORT', '기업지원', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_STARTUP_ASSISTANCE', '창업지원', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_SMALL_BUSINESS', '소상공인 지원', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_FINANCE_GUARANTEE', '금융·보증지원', 'INDUSTRY_JOBS', 'IND_BUSINESS_STARTUP'),
    ('IND_INDUSTRIAL_COMPLEX', '산업단지', 'INDUSTRY_JOBS', 'IND_INDUSTRIAL_BASE'),
    ('IND_SUPPORT_FACILITY', '산업지원시설', 'INDUSTRY_JOBS', 'IND_INDUSTRIAL_BASE'),
    ('IND_RESEARCH_DEMONSTRATION', '연구·실증시설', 'INDUSTRY_JOBS', 'IND_INDUSTRIAL_BASE'),
    ('IND_AGRICULTURE', '농업', 'INDUSTRY_JOBS', 'IND_PRIMARY_INDUSTRY'),
    ('IND_SMART_FARM', '스마트팜', 'INDUSTRY_JOBS', 'IND_PRIMARY_INDUSTRY'),
    ('IND_FISHERIES', '어업', 'INDUSTRY_JOBS', 'IND_PRIMARY_INDUSTRY'),
    ('IND_FORESTRY', '임업', 'INDUSTRY_JOBS', 'IND_PRIMARY_INDUSTRY'),
    ('IND_STARTUP_SPACE', '창업공간', 'INDUSTRY_JOBS', 'IND_STARTUP_SUPPORT'),
    ('IND_STARTUP_PROGRAM', '창업프로그램', 'INDUSTRY_JOBS', 'IND_STARTUP_SUPPORT')
) as values_to_insert(code, name, large_code, middle_code)
join public.large_categories as large_categories
  on large_categories.code = values_to_insert.large_code
join public.middle_categories as middle_categories
  on middle_categories.code = values_to_insert.middle_code
 and middle_categories.large_category_id = large_categories.id
on conflict (code) do nothing;

-- Preserve the existing RLS model: authenticated users may read the master,
-- and may read only small-category links for projects in their own region.
alter table public.large_categories enable row level security;
alter table public.middle_categories enable row level security;
alter table public.small_categories enable row level security;
alter table public.project_small_categories enable row level security;

grant select on public.large_categories, public.middle_categories, public.small_categories to authenticated;
grant select on public.project_small_categories to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'large_categories' and policyname = 'large_categories_select_authenticated') then
    create policy large_categories_select_authenticated on public.large_categories
      for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'middle_categories' and policyname = 'middle_categories_select_authenticated') then
    create policy middle_categories_select_authenticated on public.middle_categories
      for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'small_categories' and policyname = 'small_categories_select_authenticated') then
    create policy small_categories_select_authenticated on public.small_categories
      for select to authenticated using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'project_small_categories' and policyname = 'project_small_categories_select_region_or_admin') then
    create policy project_small_categories_select_region_or_admin on public.project_small_categories
      for select to authenticated using (
        exists (
          select 1
          from public.projects as projects
          join public.profiles as profiles on profiles.id = auth.uid()
          where projects.id = project_small_categories.project_id
            and (profiles.role = 'admin' or profiles.region_id = projects.region_id)
        )
      );
  end if;
end;
$$;

create or replace function public.validate_project_small_category_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_large_category_id uuid;
  v_middle_category_id uuid;
  v_small_large_category_id uuid;
  v_small_middle_category_id uuid;
begin
  select large_category_id, middle_category_id
    into v_large_category_id, v_middle_category_id
  from public.projects
  where id = new.project_id;

  if not found then
    raise exception using errcode = '23503', message = '연결할 사업을 찾을 수 없습니다.';
  end if;

  if v_large_category_id is null or v_middle_category_id is null then
    raise exception using
      errcode = '23514',
      message = '대분류와 중분류가 확정된 사업에만 소분류를 연결할 수 있습니다.';
  end if;

  select large_category_id, middle_category_id
    into v_small_large_category_id, v_small_middle_category_id
  from public.small_categories
  where id = new.small_category_id;

  if not found
     or v_small_large_category_id is distinct from v_large_category_id
     or v_small_middle_category_id is distinct from v_middle_category_id then
    raise exception using
      errcode = '23514',
      message = '소분류는 사업의 대분류 및 중분류와 일치해야 합니다.';
  end if;

  return new;
end;
$$;

drop trigger if exists project_small_categories_validate_assignment on public.project_small_categories;
create trigger project_small_categories_validate_assignment
  before insert or update of project_id, small_category_id on public.project_small_categories
  for each row execute function public.validate_project_small_category_assignment();

create or replace function public.validate_project_classification_parent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.large_category_id is null) is distinct from (new.middle_category_id is null) then
    raise exception using
      errcode = '23514',
      message = '대분류와 중분류는 함께 저장되어야 합니다.';
  end if;

  if exists (
    select 1
    from public.project_small_categories as project_small_categories
    join public.small_categories as small_categories
      on small_categories.id = project_small_categories.small_category_id
    where project_small_categories.project_id = new.id
      and (
        small_categories.large_category_id is distinct from new.large_category_id
        or small_categories.middle_category_id is distinct from new.middle_category_id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = '연결된 소분류가 새 대분류 또는 중분류와 일치하지 않습니다.';
  end if;

  return new;
end;
$$;

drop trigger if exists projects_validate_classification_parent on public.projects;
create trigger projects_validate_classification_parent
  before insert or update of large_category_id, middle_category_id on public.projects
  for each row execute function public.validate_project_classification_parent();

create or replace function public.update_project_classification_with_audit(
  p_project_id uuid,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_small_category_ids uuid[],
  p_business_type varchar
)
returns table (
  id uuid,
  project_code text,
  large_category_id uuid,
  middle_category_id uuid,
  business_type varchar,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_role text;
  v_user_region_id uuid;
  v_project public.projects%rowtype;
  v_input_small_count integer;
  v_unique_small_count integer;
  v_valid_small_count integer;
  v_old_small_category_ids uuid[];
  v_new_small_category_ids uuid[];
  v_old_value jsonb;
  v_new_value jsonb;
  v_updated_at timestamptz := clock_timestamp();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 사업 분류를 수정할 수 있습니다.';
  end if;

  if p_large_category_id is null or p_middle_category_id is null then
    raise exception using errcode = '22004', message = '대분류와 중분류를 모두 선택해야 합니다.';
  end if;

  if p_small_category_ids is null or coalesce(array_length(p_small_category_ids, 1), 0) = 0 then
    raise exception using errcode = '22004', message = '소분류를 1개 이상 선택해야 합니다.';
  end if;

  if exists (select 1 from unnest(p_small_category_ids) as selected(id) where selected.id is null) then
    raise exception using errcode = '22004', message = '소분류에 빈 값이 포함되어 있습니다.';
  end if;

  if p_business_type not in ('HW', 'SW', 'COMPOSITE') then
    raise exception using errcode = '22023', message = '사업유형은 HW, SW, 복합(HW+SW) 중 하나여야 합니다.';
  end if;

  v_user_role := public.current_user_role()::text;
  v_user_region_id := public.current_user_region_id();
  if v_user_role is null or v_user_role not in ('admin', 'local_user') then
    raise exception using errcode = '42501', message = '사업 수정 권한이 없습니다.';
  end if;
  if v_user_role = 'local_user' and v_user_region_id is null then
    raise exception using errcode = '42501', message = '지역 정보가 없는 사용자는 사업을 수정할 수 없습니다.';
  end if;

  select projects.*
    into v_project
  from public.projects as projects
  where projects.id = p_project_id
    and projects.project_code is not null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '수정할 사업을 찾을 수 없습니다.';
  end if;
  if v_user_role = 'local_user' and v_project.region_id is distinct from v_user_region_id then
    raise exception using errcode = '42501', message = '본인 지역의 사업만 수정할 수 있습니다.';
  end if;

  perform 1
  from public.middle_categories as middle_categories
  where middle_categories.id = p_middle_category_id
    and middle_categories.large_category_id = p_large_category_id;
  if not found then
    raise exception using errcode = '23514', message = '선택한 중분류는 대분류에 속해야 합니다.';
  end if;

  select count(*), count(distinct selected.id)
    into v_input_small_count, v_unique_small_count
  from unnest(p_small_category_ids) as selected(id);
  if v_input_small_count <> v_unique_small_count then
    raise exception using errcode = '23505', message = '동일한 소분류를 중복 선택할 수 없습니다.';
  end if;

  select count(*) into v_valid_small_count
  from public.small_categories as small_categories
  where small_categories.id = any(p_small_category_ids)
    and small_categories.large_category_id = p_large_category_id
    and small_categories.middle_category_id = p_middle_category_id;
  if v_valid_small_count <> v_unique_small_count then
    raise exception using
      errcode = '23514',
      message = '모든 소분류는 같은 대분류와 중분류에 속해야 합니다.';
  end if;

  select coalesce(array_agg(project_small_categories.small_category_id order by project_small_categories.small_category_id), array[]::uuid[])
    into v_old_small_category_ids
  from public.project_small_categories as project_small_categories
  where project_small_categories.project_id = v_project.id;

  select array_agg(selected.id order by selected.id)
    into v_new_small_category_ids
  from unnest(p_small_category_ids) as selected(id);

  if v_project.large_category_id is not distinct from p_large_category_id
     and v_project.middle_category_id is not distinct from p_middle_category_id
     and v_project.business_type is not distinct from p_business_type
     and v_old_small_category_ids is not distinct from v_new_small_category_ids then
    return query
    select
      v_project.id,
      v_project.project_code::text,
      v_project.large_category_id,
      v_project.middle_category_id,
      v_project.business_type,
      v_project.updated_at;
    return;
  end if;

  v_old_value := jsonb_build_object(
    'large_category_id', v_project.large_category_id,
    'middle_category_id', v_project.middle_category_id,
    'small_category_ids', to_jsonb(v_old_small_category_ids),
    'business_type', v_project.business_type
  );

  -- Deleting first allows the parent consistency trigger to reject accidental
  -- direct updates while still letting this atomic RPC replace the selection.
  delete from public.project_small_categories
  where project_id = v_project.id;

  update public.projects as projects
  set
    large_category_id = p_large_category_id,
    middle_category_id = p_middle_category_id,
    business_type = p_business_type,
    updated_at = v_updated_at
  where projects.id = v_project.id
  returning projects.* into v_project;

  insert into public.project_small_categories (project_id, small_category_id, created_at)
  select v_project.id, selected.id, v_updated_at
  from unnest(p_small_category_ids) as selected(id);

  v_new_value := jsonb_build_object(
    'large_category_id', v_project.large_category_id,
    'middle_category_id', v_project.middle_category_id,
    'small_category_ids', to_jsonb(v_new_small_category_ids),
    'business_type', v_project.business_type
  );

  insert into public.audit_logs (
    project_id,
    region_id,
    changed_by,
    action,
    field_name,
    old_value,
    new_value,
    changed_at,
    created_at,
    updated_at
  )
  values (
    v_project.id,
    v_project.region_id,
    v_user_id,
    'UPDATE_CLASSIFICATION',
    'project_classification',
    v_old_value::text,
    v_new_value::text,
    v_updated_at,
    v_updated_at,
    v_updated_at
  );

  return query
  select
    v_project.id,
    v_project.project_code::text,
    v_project.large_category_id,
    v_project.middle_category_id,
    v_project.business_type,
    v_project.updated_at;
end;
$$;

revoke all on function public.update_project_classification_with_audit(uuid, uuid, uuid, uuid[], varchar) from public;
revoke all on function public.update_project_classification_with_audit(uuid, uuid, uuid, uuid[], varchar) from anon;
grant execute on function public.update_project_classification_with_audit(uuid, uuid, uuid, uuid[], varchar) to authenticated;

-- Deliberately not executed: review and approve a separately scoped legacy-data
-- migration before converting any historical value. Example only:
-- update public.projects set category = '지역의료' where category = '노인의료';

notify pgrst, 'reload schema';

commit;
