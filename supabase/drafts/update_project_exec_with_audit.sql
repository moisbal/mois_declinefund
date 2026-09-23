-- DRAFT ONLY: DO NOT EXECUTE WITHOUT REVIEW AND APPROVAL.
-- Atomically updates projects.exec/rate and inserts the matching audit log.

begin;

create or replace function public.update_project_exec_with_audit(
  p_project_id uuid,
  p_new_exec bigint
)
returns table (
  id uuid,
  project_code text,
  exec bigint,
  rate numeric,
  alloc bigint,
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
  v_old_exec bigint;
  v_updated_at timestamptz := clock_timestamp();
  v_new_rate numeric;
begin
  if v_user_id is null then
    raise exception using
      errcode = '28000',
      message = '인증된 사용자만 집행액을 수정할 수 있습니다.';
  end if;

  if p_new_exec is null then
    raise exception using
      errcode = '22004',
      message = '집행액은 null일 수 없습니다.';
  end if;

  if p_new_exec < 0 then
    raise exception using
      errcode = '22003',
      message = '집행액은 0 이상이어야 합니다.';
  end if;

  v_user_role := public.current_user_role()::text;
  v_user_region_id := public.current_user_region_id();

  if v_user_role is null or v_user_role not in ('admin', 'local_user') then
    raise exception using
      errcode = '42501',
      message = '사업 수정 권한이 없습니다.';
  end if;

  if v_user_role = 'local_user' and v_user_region_id is null then
    raise exception using
      errcode = '42501',
      message = '지역 정보가 없는 사용자는 사업을 수정할 수 없습니다.';
  end if;

  select p.*
    into v_project
  from public.projects as p
  where p.id = p_project_id
    and p.project_code is not null
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = '수정할 사업을 찾을 수 없습니다.';
  end if;

  if v_user_role = 'local_user'
     and v_project.region_id is distinct from v_user_region_id then
    raise exception using
      errcode = '42501',
      message = '본인 지역의 사업만 수정할 수 있습니다.';
  end if;

  if v_project.alloc is null then
    raise exception using
      errcode = '22004',
      message = '배분액 정보가 없어 집행액을 수정할 수 없습니다.';
  end if;

  if p_new_exec > v_project.alloc then
    raise exception using
      errcode = '22003',
      message = '집행액은 배분액을 초과할 수 없습니다.';
  end if;

  -- Idempotent behavior: return the current row without an UPDATE or audit log.
  if v_project.exec is not distinct from p_new_exec then
    return query
    select
      v_project.id,
      v_project.project_code::text,
      v_project.exec,
      v_project.rate,
      v_project.alloc,
      v_project.updated_at;
    return;
  end if;

  v_old_exec := v_project.exec;

  v_new_rate := case
    when v_project.alloc > 0
      then (p_new_exec::numeric / v_project.alloc::numeric) * 100
    else 0::numeric
  end;

  update public.projects as p
  set
    exec = p_new_exec,
    rate = v_new_rate,
    updated_at = v_updated_at
  where p.id = v_project.id
  returning p.* into v_project;

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
    'UPDATE_EXEC',
    'exec',
    coalesce(v_old_exec::text, ''),
    p_new_exec::text,
    v_updated_at,
    v_updated_at,
    v_updated_at
  );

  return query
  select
    v_project.id,
    v_project.project_code::text,
    v_project.exec,
    v_project.rate,
    v_project.alloc,
    v_project.updated_at;
end;
$$;

revoke all on function public.update_project_exec_with_audit(uuid, bigint) from public;
revoke all on function public.update_project_exec_with_audit(uuid, bigint) from anon;
grant execute on function public.update_project_exec_with_audit(uuid, bigint) to authenticated;

commit;
