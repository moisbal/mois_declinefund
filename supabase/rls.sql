-- supabase/rls.sql
-- Row Level Security policies for Declinefund Management

-- POLICIES NOTES:
-- - `auth.uid()` is used to identify the current authenticated user id.
-- - A user is considered `admin` when their `profiles.role = 'admin'`.

-- Enable RLS on tables
alter table public.profiles   enable row level security;
alter table public.projects   enable row level security;
alter table public.audit_logs enable row level security;

-- Helper: admin checker
-- (used inline in policies as an EXISTS subquery)

-- Profiles policies
-- Allow users to see and modify their own profile; admins can access any profile
create policy profiles_select_self_or_admin on public.profiles
  for select using (
    auth.uid() = id
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy profiles_insert_self_or_admin on public.profiles
  for insert with check (
    auth.uid() = id
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy profiles_update_self_or_admin on public.profiles
  for update using (
    auth.uid() = id
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  ) with check (
    auth.uid() = id
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy profiles_delete_admin_only on public.profiles
  for delete using (
    exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- Projects policies
-- local_user: can SELECT/INSERT/UPDATE/DELETE only for rows where their profile.region_id = projects.region_id
-- admin: full access

create policy projects_select_region_or_admin on public.projects
  for select using (
    exists(select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.region_id = public.projects.region_id))
  );

create policy projects_insert_region_or_admin on public.projects
  for insert with check (
    exists(select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.region_id = new.region_id))
  );

create policy projects_update_region_or_admin on public.projects
  for update using (
    exists(select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.region_id = public.projects.region_id))
  ) with check (
    exists(select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.region_id = new.region_id))
  );

create policy projects_delete_region_or_admin on public.projects
  for delete using (
    exists(select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.region_id = public.projects.region_id))
  );

-- Audit logs policies
-- local_user: can INSERT logs for their region and SELECT logs only for their region
-- admin: full access

create policy audit_logs_select_region_or_admin on public.audit_logs
  for select using (
    exists(select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or p.region_id = public.audit_logs.region_id))
  );

create policy audit_logs_insert_region_or_admin on public.audit_logs
  for insert with check (
    -- allow insert when the changed_by is the current user and region matches,
    -- or the user is admin
    (
      new.changed_by = auth.uid()
      and exists(select 1 from public.profiles p where p.id = auth.uid() and p.region_id = new.region_id)
    )
    or exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

create policy audit_logs_delete_admin_only on public.audit_logs
  for delete using (
    exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- Optionally, grant privileges to authenticated role to perform necessary operations through policies
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert on public.audit_logs to authenticated;
