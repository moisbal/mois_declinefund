-- supabase/20260806_10_align_audit_logs_schema.sql
-- Align public.audit_logs schema with the current app audit log usage.
-- This migration preserves existing data and does not remove any columns.

begin;

-- If the legacy column exists, preserve data by renaming it to the app-facing field_name.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'audit_logs'
      and column_name = 'changed_column'
  ) then
    alter table public.audit_logs rename column changed_column to field_name;
  end if;
end
$$;

alter table public.audit_logs
  add column if not exists project_id uuid references public.projects(id);

alter table public.audit_logs
  add column if not exists region_id varchar;

alter table public.audit_logs
  add column if not exists field_name text;

alter table public.audit_logs
  add column if not exists old_value text;

alter table public.audit_logs
  add column if not exists new_value text;

alter table public.audit_logs
  add column if not exists action text;

alter table public.audit_logs
  add column if not exists changed_by uuid;

alter table public.audit_logs
  add column if not exists created_at timestamptz default now();

alter table public.audit_logs
  add column if not exists changed_at timestamptz default now();

alter table public.audit_logs
  add column if not exists updated_at timestamptz default now();

alter table public.audit_logs
  alter column changed_at set default now();

alter table public.audit_logs
  alter column updated_at set default now();

-- Refresh PostgREST schema cache so the new/renamed columns are visible to the app.
notify pgrst, 'reload schema';

commit;
