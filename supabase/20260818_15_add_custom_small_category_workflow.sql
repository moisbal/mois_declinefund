-- DRAFT MIGRATION ONLY: execute manually in the Supabase SQL editor after
-- reviewing it. This is additive and does not modify imported legacy values
-- or existing project classification rows.
--
-- Prerequisite: 20260818_13_add_project_classification.sql
-- Recommended:  20260818_14_expand_project_classification_master.sql

begin;

-- pg_trgm gives the suggestion function a lightweight Korean text-similarity
-- fallback. Exact names and approved aliases always rank above this fallback.
create extension if not exists pg_trgm;

create table if not exists public.project_category_aliases (
  id uuid primary key default gen_random_uuid(),
  alias varchar(100) not null,
  normalized_alias varchar(100) not null,
  large_category_id uuid not null references public.large_categories(id) on delete restrict,
  middle_category_id uuid not null,
  small_category_id uuid references public.small_categories(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_alias, middle_category_id),
  constraint project_category_aliases_middle_large_fkey
    foreign key (middle_category_id, large_category_id)
    references public.middle_categories(id, large_category_id)
    on delete restrict
);

create table if not exists public.project_custom_small_categories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  input_value varchar(100) not null,
  normalized_value varchar(100) not null,
  large_category_id uuid not null references public.large_categories(id) on delete restrict,
  middle_category_id uuid not null,
  suggested_small_category_id uuid references public.small_categories(id) on delete restrict,
  classification_method varchar(32) not null,
  confidence numeric(4, 3) not null default 0,
  validation_status varchar(32) not null default 'PENDING_REVIEW',
  created_by uuid not null references public.profiles(id) on delete restrict,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, normalized_value),
  constraint project_custom_small_categories_middle_large_fkey
    foreign key (middle_category_id, large_category_id)
    references public.middle_categories(id, large_category_id)
    on delete restrict,
  constraint project_custom_small_categories_method_check
    check (classification_method in (
      'EXACT_MASTER', 'ALIAS_EXACT', 'ALIAS_CONTAINS', 'SIMILAR_NAME', 'MANUAL_CONTEXT'
    )),
  constraint project_custom_small_categories_confidence_check
    check (confidence >= 0 and confidence <= 1),
  constraint project_custom_small_categories_status_check
    check (validation_status in ('PENDING_REVIEW', 'CONFIRMED', 'REJECTED'))
);

create index if not exists idx_project_category_aliases_normalized_alias
  on public.project_category_aliases(normalized_alias);
create index if not exists idx_project_custom_small_categories_project_id
  on public.project_custom_small_categories(project_id);
create index if not exists idx_project_custom_small_categories_review
  on public.project_custom_small_categories(validation_status, created_at desc);
create index if not exists idx_project_custom_small_categories_normalized_value
  on public.project_custom_small_categories(normalized_value);

-- Safe, deterministic normalisation used in every validation path. The raw
-- input remains unchanged for display and audit; this value is only for
-- duplicate detection and matching.
create or replace function public.normalize_custom_category_text(p_value text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select lower(regexp_replace(btrim(p_value), '[[:space:][:punct:]]+', '', 'g'));
$$;

-- Initial aliases are deliberately small and explainable. Administrators can
-- grow this table through standard-category promotion without editing code.
insert into public.project_category_aliases (
  alias,
  normalized_alias,
  large_category_id,
  middle_category_id,
  small_category_id
)
select
  values_to_insert.alias,
  public.normalize_custom_category_text(values_to_insert.alias),
  large_categories.id,
  middle_categories.id,
  small_categories.id
from (
  values
    ('귀농', 'IND_AGRICULTURE'),
    ('귀촌', 'IND_AGRICULTURE'),
    ('청년정착', 'IND_YOUTH_JOB'),
    ('청년일자리', 'IND_YOUTH_JOB'),
    ('창업거점', 'IND_STARTUP_SPACE'),
    ('창업보육', 'IND_STARTUP_ASSISTANCE'),
    ('스마트농업', 'IND_SMART_FARM'),
    ('빈집정비', 'HOUSING_EMPTY_HOME'),
    ('빈집활용', 'HOUSING_EMPTY_HOME'),
    ('청년임대', 'HOUSING_YOUTH'),
    ('공공임대', 'HOUSING_PUBLIC_RENTAL'),
    ('공동돌봄', 'CARE_PROGRAM'),
    ('키즈카페', 'CARE_PARENTING'),
    ('건강돌봄', 'HEALTH_PROGRAM'),
    ('원격의료', 'HEALTH_REMOTE'),
    ('생활관광', 'CULTURE_PROGRAM'),
    ('문화공연', 'CULTURE_PERFORMANCE'),
    ('생활체육', 'CULTURE_SPORTS_FACILITY'),
    ('대중교통', 'TRANSPORT_ACCESS'),
    ('교통약자', 'TRANSPORT_ACCESS'),
    ('디지털행정', 'OTHER_DIGITAL_SERVICE'),
    ('주민서비스', 'OTHER_DIGITAL_SERVICE')
) as values_to_insert(alias, small_code)
join public.small_categories as small_categories
  on small_categories.code = values_to_insert.small_code
join public.middle_categories as middle_categories
  on middle_categories.id = small_categories.middle_category_id
join public.large_categories as large_categories
  on large_categories.id = small_categories.large_category_id
on conflict (normalized_alias, middle_category_id) do nothing;

alter table public.project_category_aliases enable row level security;
alter table public.project_custom_small_categories enable row level security;

grant select on public.project_category_aliases, public.project_custom_small_categories to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'project_category_aliases'
      and policyname = 'project_category_aliases_select_authenticated'
  ) then
    create policy project_category_aliases_select_authenticated
      on public.project_category_aliases
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'project_custom_small_categories'
      and policyname = 'project_custom_small_categories_select_region_or_admin'
  ) then
    create policy project_custom_small_categories_select_region_or_admin
      on public.project_custom_small_categories
      for select to authenticated using (
        exists (
          select 1
          from public.projects as projects
          join public.profiles as profiles on profiles.id = auth.uid()
          where projects.id = project_custom_small_categories.project_id
            and (
              profiles.role = 'admin'
              or profiles.region_id = projects.region_id
            )
        )
      );
  end if;
end;
$$;

-- Returns at most three explainable candidates. This function never writes a
-- master category and is safe to call while the user is typing.
create or replace function public.suggest_custom_small_category(
  p_input_value text,
  p_large_category_id uuid default null,
  p_middle_category_id uuid default null
)
returns table (
  large_category_id uuid,
  middle_category_id uuid,
  small_category_id uuid,
  large_category_name text,
  middle_category_name text,
  small_category_name text,
  confidence numeric,
  classification_method varchar
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_normalized_value text;
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 분류 후보를 조회할 수 있습니다.';
  end if;

  if p_input_value is null
     or char_length(btrim(p_input_value)) < 2
     or char_length(btrim(p_input_value)) > 100
     or btrim(p_input_value) !~ '^[0-9A-Za-z가-힣·&() /-]+$' then
    raise exception using
      errcode = '22023',
      message = '소분류 직접 입력은 2~100자의 한글, 영문, 숫자 및 기본 기호만 사용할 수 있습니다.';
  end if;

  v_normalized_value := public.normalize_custom_category_text(p_input_value);
  if char_length(v_normalized_value) < 2 then
    raise exception using errcode = '22023', message = '유효한 소분류 직접 입력값을 입력하세요.';
  end if;

  return query
  with candidates as (
    select
      small_categories.large_category_id,
      small_categories.middle_category_id,
      small_categories.id as small_category_id,
      1.000::numeric as confidence,
      'EXACT_MASTER'::varchar as classification_method
    from public.small_categories as small_categories
    where public.normalize_custom_category_text(small_categories.name) = v_normalized_value

    union all

    select
      aliases.large_category_id,
      aliases.middle_category_id,
      aliases.small_category_id,
      0.980::numeric as confidence,
      'ALIAS_EXACT'::varchar as classification_method
    from public.project_category_aliases as aliases
    where aliases.normalized_alias = v_normalized_value

    union all

    select
      aliases.large_category_id,
      aliases.middle_category_id,
      aliases.small_category_id,
      0.860::numeric as confidence,
      'ALIAS_CONTAINS'::varchar as classification_method
    from public.project_category_aliases as aliases
    where char_length(aliases.normalized_alias) >= 2
      and position(aliases.normalized_alias in v_normalized_value) > 0

    union all

    select
      small_categories.large_category_id,
      small_categories.middle_category_id,
      small_categories.id as small_category_id,
      round(similarity(
        public.normalize_custom_category_text(small_categories.name),
        v_normalized_value
      )::numeric, 3) as confidence,
      'SIMILAR_NAME'::varchar as classification_method
    from public.small_categories as small_categories
    where similarity(public.normalize_custom_category_text(small_categories.name), v_normalized_value) >= 0.180
  ), ranked as (
    select distinct on (candidates.large_category_id, candidates.middle_category_id, candidates.small_category_id)
      candidates.*
    from candidates
    where candidates.small_category_id is not null
      and (p_large_category_id is null or candidates.large_category_id = p_large_category_id)
      and (p_middle_category_id is null or candidates.middle_category_id = p_middle_category_id)
    order by
      candidates.large_category_id,
      candidates.middle_category_id,
      candidates.small_category_id,
      candidates.confidence desc
  )
  select
    ranked.large_category_id,
    ranked.middle_category_id,
    ranked.small_category_id,
    large_categories.name::text,
    middle_categories.name::text,
    small_categories.name::text,
    ranked.confidence,
    ranked.classification_method
  from ranked
  join public.large_categories as large_categories on large_categories.id = ranked.large_category_id
  join public.middle_categories as middle_categories on middle_categories.id = ranked.middle_category_id
  join public.small_categories as small_categories on small_categories.id = ranked.small_category_id
  order by ranked.confidence desc, middle_categories.name, small_categories.name
  limit 3;
end;
$$;

create or replace function public.validate_project_custom_small_category_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_project_large_category_id uuid;
  v_project_middle_category_id uuid;
  v_suggested_large_category_id uuid;
  v_suggested_middle_category_id uuid;
begin
  select large_category_id, middle_category_id
    into v_project_large_category_id, v_project_middle_category_id
  from public.projects
  where id = new.project_id;

  if not found then
    raise exception using errcode = '23503', message = '연결할 사업을 찾을 수 없습니다.';
  end if;

  if v_project_large_category_id is null
     or v_project_middle_category_id is null
     or new.large_category_id is distinct from v_project_large_category_id
     or new.middle_category_id is distinct from v_project_middle_category_id then
    raise exception using
      errcode = '23514',
      message = '사용자 입력 소분류는 사업의 대분류 및 중분류와 일치해야 합니다.';
  end if;

  if new.suggested_small_category_id is not null then
    select large_category_id, middle_category_id
      into v_suggested_large_category_id, v_suggested_middle_category_id
    from public.small_categories
    where id = new.suggested_small_category_id;

    if not found
       or v_suggested_large_category_id is distinct from new.large_category_id
       or v_suggested_middle_category_id is distinct from new.middle_category_id then
      raise exception using
        errcode = '23514',
        message = '추천 표준 소분류는 사용자 입력 소분류의 대분류 및 중분류와 일치해야 합니다.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists project_custom_small_categories_validate_assignment on public.project_custom_small_categories;
create trigger project_custom_small_categories_validate_assignment
  before insert or update of project_id, large_category_id, middle_category_id, suggested_small_category_id
  on public.project_custom_small_categories
  for each row execute function public.validate_project_custom_small_category_assignment();

-- Replace the earlier parent trigger with a version that checks both standard
-- and user-entered small categories. Rejected suggestions no longer constrain
-- a project's active classification.
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
  ) or exists (
    select 1
    from public.project_custom_small_categories as custom_small_categories
    where custom_small_categories.project_id = new.id
      and custom_small_categories.validation_status <> 'REJECTED'
      and (
        custom_small_categories.large_category_id is distinct from new.large_category_id
        or custom_small_categories.middle_category_id is distinct from new.middle_category_id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = '연결된 소분류가 새 대분류 또는 중분류와 일치하지 않습니다.';
  end if;

  return new;
end;
$$;

create or replace function public.update_project_classification_with_custom_small_categories(
  p_project_id uuid,
  p_large_category_id uuid,
  p_middle_category_id uuid,
  p_standard_small_category_ids uuid[],
  p_custom_small_categories jsonb,
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
  v_standard_count integer;
  v_unique_standard_count integer;
  v_valid_standard_count integer;
  v_custom_count integer := 0;
  v_custom_item jsonb;
  v_input_value text;
  v_normalized_value text;
  v_suggested_small_category_id uuid;
  v_method varchar(32);
  v_confidence numeric(4, 3);
  v_status varchar(32);
  v_normalized_values text[] := array[]::text[];
  v_old_standard_small_category_ids uuid[];
  v_old_custom_small_categories jsonb;
  v_new_standard_small_category_ids uuid[];
  v_new_custom_small_categories jsonb := '[]'::jsonb;
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
  if p_business_type not in ('HW', 'SW', 'COMPOSITE') then
    raise exception using errcode = '22023', message = '사업유형은 HW, SW, 복합(HW+SW) 중 하나여야 합니다.';
  end if;
  if p_custom_small_categories is null then
    p_custom_small_categories := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_custom_small_categories) <> 'array' then
    raise exception using errcode = '22023', message = '사용자 입력 소분류 형식이 올바르지 않습니다.';
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

  select
    coalesce(array_length(p_standard_small_category_ids, 1), 0),
    count(distinct selected.id)
  into v_standard_count, v_unique_standard_count
  from unnest(coalesce(p_standard_small_category_ids, array[]::uuid[])) as selected(id);
  if v_standard_count <> v_unique_standard_count then
    raise exception using errcode = '23505', message = '동일한 표준 소분류를 중복 선택할 수 없습니다.';
  end if;

  select count(*) into v_valid_standard_count
  from public.small_categories as small_categories
  where small_categories.id = any(coalesce(p_standard_small_category_ids, array[]::uuid[]))
    and small_categories.large_category_id = p_large_category_id
    and small_categories.middle_category_id = p_middle_category_id;
  if v_valid_standard_count <> v_unique_standard_count then
    raise exception using
      errcode = '23514',
      message = '모든 표준 소분류는 같은 대분류와 중분류에 속해야 합니다.';
  end if;

  for v_custom_item in select value from jsonb_array_elements(p_custom_small_categories)
  loop
    v_input_value := btrim(v_custom_item ->> 'input_value');
    if v_input_value is null
       or char_length(v_input_value) < 2
       or char_length(v_input_value) > 100
       or v_input_value !~ '^[0-9A-Za-z가-힣·&() /-]+$' then
      raise exception using
        errcode = '22023',
        message = '소분류 직접 입력은 2~100자의 한글, 영문, 숫자 및 기본 기호만 사용할 수 있습니다.';
    end if;

    v_normalized_value := public.normalize_custom_category_text(v_input_value);
    if char_length(v_normalized_value) < 2
       or v_normalized_value = any(v_normalized_values) then
      raise exception using errcode = '23505', message = '동일한 사용자 입력 소분류를 중복 저장할 수 없습니다.';
    end if;
    v_normalized_values := array_append(v_normalized_values, v_normalized_value);

    v_method := upper(coalesce(v_custom_item ->> 'classification_method', 'MANUAL_CONTEXT'));
    if v_method not in ('EXACT_MASTER', 'ALIAS_EXACT', 'ALIAS_CONTAINS', 'SIMILAR_NAME', 'MANUAL_CONTEXT') then
      raise exception using errcode = '22023', message = '사용자 입력 소분류의 분류 방식이 올바르지 않습니다.';
    end if;

    v_suggested_small_category_id := nullif(v_custom_item ->> 'suggested_small_category_id', '')::uuid;
    if v_method = 'MANUAL_CONTEXT' then
      if v_unique_standard_count = 0 then
        raise exception using
          errcode = '23514',
          message = '직접 지정 분류는 같은 중분류의 표준 소분류를 함께 선택해야 합니다.';
      end if;
      v_suggested_small_category_id := null;
      v_confidence := 0;
    else
      if v_suggested_small_category_id is null then
        raise exception using errcode = '22004', message = '검증된 추천 표준 소분류를 선택해야 합니다.';
      end if;

      -- Never trust client-provided category, method, or confidence. Re-run the
      -- suggestion inside the transaction and accept the value only when it
      -- still belongs to the selected hierarchy.
      select suggestions.confidence
        into v_confidence
      from public.suggest_custom_small_category(
        v_input_value,
        p_large_category_id,
        p_middle_category_id
      ) as suggestions
      where suggestions.small_category_id = v_suggested_small_category_id
        and suggestions.classification_method = v_method
      order by suggestions.confidence desc
      limit 1;
      if not found then
        raise exception using
          errcode = '23514',
          message = '사용자 입력 소분류의 검증 결과가 현재 분류체계와 일치하지 않습니다. 다시 검증하세요.';
      end if;
    end if;
    v_status := case
      when v_method in ('EXACT_MASTER', 'ALIAS_EXACT', 'ALIAS_CONTAINS') then 'CONFIRMED'
      else 'PENDING_REVIEW'
    end;
    -- A manager's confirmation remains valid when a user reopens and saves an
    -- unchanged classification. It is never accepted merely from client input.
    if v_status = 'PENDING_REVIEW' and exists (
      select 1
      from public.project_custom_small_categories as existing_custom_small_categories
      where existing_custom_small_categories.project_id = v_project.id
        and existing_custom_small_categories.normalized_value = v_normalized_value
        and existing_custom_small_categories.validation_status = 'CONFIRMED'
    ) then
      v_status := 'CONFIRMED';
    end if;

    v_new_custom_small_categories := v_new_custom_small_categories || jsonb_build_array(jsonb_build_object(
      'input_value', v_input_value,
      'normalized_value', v_normalized_value,
      'suggested_small_category_id', v_suggested_small_category_id,
      'classification_method', v_method,
      'confidence', v_confidence,
      'validation_status', v_status
    ));
    v_custom_count := v_custom_count + 1;
  end loop;

  if v_unique_standard_count + v_custom_count = 0 then
    raise exception using errcode = '22004', message = '표준 또는 사용자 입력 소분류를 1개 이상 선택해야 합니다.';
  end if;

  select coalesce(array_agg(project_small_categories.small_category_id order by project_small_categories.small_category_id), array[]::uuid[])
    into v_old_standard_small_category_ids
  from public.project_small_categories as project_small_categories
  where project_small_categories.project_id = v_project.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'input_value', custom_small_categories.input_value,
    'normalized_value', custom_small_categories.normalized_value,
    'suggested_small_category_id', custom_small_categories.suggested_small_category_id,
    'classification_method', custom_small_categories.classification_method,
    'confidence', custom_small_categories.confidence,
    'validation_status', custom_small_categories.validation_status
  ) order by custom_small_categories.normalized_value), '[]'::jsonb)
    into v_old_custom_small_categories
  from public.project_custom_small_categories as custom_small_categories
  where custom_small_categories.project_id = v_project.id;

  select coalesce(array_agg(selected.id order by selected.id), array[]::uuid[])
    into v_new_standard_small_category_ids
  from unnest(coalesce(p_standard_small_category_ids, array[]::uuid[])) as selected(id);

  if v_project.large_category_id is not distinct from p_large_category_id
     and v_project.middle_category_id is not distinct from p_middle_category_id
     and v_project.business_type is not distinct from p_business_type
     and v_old_standard_small_category_ids is not distinct from v_new_standard_small_category_ids
     and v_old_custom_small_categories is not distinct from v_new_custom_small_categories then
    return query
    select v_project.id, v_project.project_code::text, v_project.large_category_id,
      v_project.middle_category_id, v_project.business_type, v_project.updated_at;
    return;
  end if;

  v_old_value := jsonb_build_object(
    'large_category_id', v_project.large_category_id,
    'middle_category_id', v_project.middle_category_id,
    'standard_small_category_ids', to_jsonb(v_old_standard_small_category_ids),
    'custom_small_categories', v_old_custom_small_categories,
    'business_type', v_project.business_type
  );

  -- Remove old links before changing the parent category. This keeps both
  -- assignment triggers strict while allowing this atomic replacement RPC.
  delete from public.project_small_categories where project_id = v_project.id;
  delete from public.project_custom_small_categories where project_id = v_project.id;

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
  from unnest(coalesce(p_standard_small_category_ids, array[]::uuid[])) as selected(id);

  insert into public.project_custom_small_categories (
    project_id,
    input_value,
    normalized_value,
    large_category_id,
    middle_category_id,
    suggested_small_category_id,
    classification_method,
    confidence,
    validation_status,
    created_by,
    created_at,
    updated_at
  )
  select
    v_project.id,
    custom_small_categories.input_value,
    custom_small_categories.normalized_value,
    p_large_category_id,
    p_middle_category_id,
    custom_small_categories.suggested_small_category_id,
    custom_small_categories.classification_method,
    custom_small_categories.confidence,
    custom_small_categories.validation_status,
    v_user_id,
    v_updated_at,
    v_updated_at
  from jsonb_to_recordset(v_new_custom_small_categories) as custom_small_categories(
    input_value text,
    normalized_value text,
    suggested_small_category_id uuid,
    classification_method varchar,
    confidence numeric,
    validation_status varchar
  );

  v_new_value := jsonb_build_object(
    'large_category_id', v_project.large_category_id,
    'middle_category_id', v_project.middle_category_id,
    'standard_small_category_ids', to_jsonb(v_new_standard_small_category_ids),
    'custom_small_categories', v_new_custom_small_categories,
    'business_type', v_project.business_type
  );

  insert into public.audit_logs (
    project_id, region_id, changed_by, action, field_name,
    old_value, new_value, changed_at, created_at, updated_at
  )
  values (
    v_project.id, v_project.region_id, v_user_id,
    'UPDATE_CLASSIFICATION', 'project_classification',
    v_old_value::text, v_new_value::text,
    v_updated_at, v_updated_at, v_updated_at
  );

  return query
  select v_project.id, v_project.project_code::text, v_project.large_category_id,
    v_project.middle_category_id, v_project.business_type, v_project.updated_at;
end;
$$;

create or replace function public.review_project_custom_small_category(
  p_custom_small_category_id uuid,
  p_action varchar,
  p_standard_small_category_name varchar default null,
  p_standard_small_category_code varchar default null
)
returns table (
  id uuid,
  validation_status varchar,
  promoted_small_category_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_role text;
  v_custom public.project_custom_small_categories%rowtype;
  v_project public.projects%rowtype;
  v_small public.small_categories%rowtype;
  v_action varchar := upper(btrim(p_action));
  v_standard_name varchar(100);
  v_standard_code varchar(64);
  v_now timestamptz := clock_timestamp();
begin
  if v_user_id is null then
    raise exception using errcode = '28000', message = '인증된 사용자만 검토할 수 있습니다.';
  end if;
  v_user_role := public.current_user_role()::text;
  if v_user_role is distinct from 'admin' then
    raise exception using errcode = '42501', message = '관리자만 사용자 입력 소분류를 검토할 수 있습니다.';
  end if;
  if v_action not in ('CONFIRM', 'REJECT', 'PROMOTE') then
    raise exception using errcode = '22023', message = '검토 작업이 올바르지 않습니다.';
  end if;

  select custom_small_categories.*
    into v_custom
  from public.project_custom_small_categories as custom_small_categories
  where custom_small_categories.id = p_custom_small_category_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = '검토할 사용자 입력 소분류를 찾을 수 없습니다.';
  end if;

  select projects.* into v_project
  from public.projects as projects
  where projects.id = v_custom.project_id
  for update;

  if v_action = 'CONFIRM' then
    update public.project_custom_small_categories
    set validation_status = 'CONFIRMED', reviewed_by = v_user_id,
      reviewed_at = v_now, updated_at = v_now
    where id = v_custom.id;

    insert into public.audit_logs (
      project_id, region_id, changed_by, action, field_name,
      old_value, new_value, changed_at, created_at, updated_at
    ) values (
      v_project.id, v_project.region_id, v_user_id,
      'REVIEW_CUSTOM_SMALL_CATEGORY', 'custom_small_category',
      v_custom.validation_status,
      'CONFIRMED', v_now, v_now, v_now
    );

    return query select v_custom.id, 'CONFIRMED'::varchar, null::uuid;
    return;
  end if;

  if v_action = 'REJECT' then
    update public.project_custom_small_categories
    set validation_status = 'REJECTED', reviewed_by = v_user_id,
      reviewed_at = v_now, updated_at = v_now
    where id = v_custom.id;

    insert into public.audit_logs (
      project_id, region_id, changed_by, action, field_name,
      old_value, new_value, changed_at, created_at, updated_at
    ) values (
      v_project.id, v_project.region_id, v_user_id,
      'REVIEW_CUSTOM_SMALL_CATEGORY', 'custom_small_category',
      v_custom.validation_status,
      'REJECTED', v_now, v_now, v_now
    );

    return query select v_custom.id, 'REJECTED'::varchar, null::uuid;
    return;
  end if;

  v_standard_name := coalesce(nullif(btrim(p_standard_small_category_name), ''), v_custom.input_value);
  if char_length(v_standard_name) < 2 or char_length(v_standard_name) > 100 then
    raise exception using errcode = '22023', message = '표준 소분류명은 2~100자로 입력하세요.';
  end if;
  v_standard_code := coalesce(
    nullif(upper(btrim(p_standard_small_category_code)), ''),
    'CUSTOM_' || replace(v_custom.id::text, '-', '')
  );
  if v_standard_code !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception using errcode = '22023', message = '표준 소분류 코드는 영문 대문자, 숫자, 밑줄로 입력하세요.';
  end if;

  select small_categories.* into v_small
  from public.small_categories as small_categories
  where small_categories.code = v_standard_code
  for update;
  if found then
    if v_small.large_category_id is distinct from v_custom.large_category_id
       or v_small.middle_category_id is distinct from v_custom.middle_category_id then
      raise exception using errcode = '23514', message = '이미 사용 중인 표준 소분류 코드는 다른 중분류에 속합니다.';
    end if;
  else
    select small_categories.* into v_small
    from public.small_categories as small_categories
    where small_categories.large_category_id = v_custom.large_category_id
      and small_categories.middle_category_id = v_custom.middle_category_id
      and small_categories.name = v_standard_name
    for update;

    if not found then
      insert into public.small_categories (
        code, name, large_category_id, middle_category_id, created_at, updated_at
      ) values (
        v_standard_code, v_standard_name,
        v_custom.large_category_id, v_custom.middle_category_id, v_now, v_now
      )
      returning * into v_small;
    end if;
  end if;

  insert into public.project_category_aliases (
    alias, normalized_alias, large_category_id, middle_category_id,
    small_category_id, created_at, updated_at
  ) values (
    v_custom.input_value, v_custom.normalized_value,
    v_custom.large_category_id, v_custom.middle_category_id,
    v_small.id, v_now, v_now
  )
  on conflict (normalized_alias, middle_category_id) do update
    set alias = excluded.alias,
      large_category_id = excluded.large_category_id,
      small_category_id = excluded.small_category_id,
      updated_at = excluded.updated_at;

  insert into public.project_small_categories (project_id, small_category_id, created_at)
  values (v_project.id, v_small.id, v_now)
  on conflict (project_id, small_category_id) do nothing;

  delete from public.project_custom_small_categories where id = v_custom.id;

  insert into public.audit_logs (
    project_id, region_id, changed_by, action, field_name,
    old_value, new_value, changed_at, created_at, updated_at
  ) values (
    v_project.id, v_project.region_id, v_user_id,
    'PROMOTE_CUSTOM_SMALL_CATEGORY', 'custom_small_category',
    jsonb_build_object('input_value', v_custom.input_value, 'status', v_custom.validation_status)::text,
    jsonb_build_object('small_category_id', v_small.id, 'code', v_small.code, 'name', v_small.name)::text,
    v_now, v_now, v_now
  );

  return query select v_custom.id, 'PROMOTED'::varchar, v_small.id;
end;
$$;

revoke all on function public.suggest_custom_small_category(text, uuid, uuid) from public;
revoke all on function public.suggest_custom_small_category(text, uuid, uuid) from anon;
grant execute on function public.suggest_custom_small_category(text, uuid, uuid) to authenticated;

revoke all on function public.update_project_classification_with_custom_small_categories(uuid, uuid, uuid, uuid[], jsonb, varchar) from public;
revoke all on function public.update_project_classification_with_custom_small_categories(uuid, uuid, uuid, uuid[], jsonb, varchar) from anon;
grant execute on function public.update_project_classification_with_custom_small_categories(uuid, uuid, uuid, uuid[], jsonb, varchar) to authenticated;

revoke all on function public.review_project_custom_small_category(uuid, varchar, varchar, varchar) from public;
revoke all on function public.review_project_custom_small_category(uuid, varchar, varchar, varchar) from anon;
grant execute on function public.review_project_custom_small_category(uuid, varchar, varchar, varchar) to authenticated;

notify pgrst, 'reload schema';

commit;
