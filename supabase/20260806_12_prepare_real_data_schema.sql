-- Prepare Supabase schema for real fund project ingestion.
-- This migration only adds missing columns / indexes and does not delete or rename existing data.
-- It avoids creating duplicate meaning columns for amount fields.

-- Projects: add missing raw-data and transition fields.
alter table if exists public.projects
  add column if not exists project_code varchar;

alter table if exists public.projects
  add column if not exists region_type varchar,
  add column if not exists fund_project_name text,
  add column if not exists detail_project_name text,
  add column if not exists project_period text,
  add column if not exists project_start_year integer,
  add column if not exists project_end_year integer;

-- Ensure real amount columns use bigint.
alter table if exists public.projects
  alter column if exists allocated_amount type bigint using round(allocated_amount)::bigint,
  alter column if exists executed_amount type bigint using round(executed_amount)::bigint;

create unique index if not exists idx_projects_project_code on public.projects(project_code);
create index if not exists idx_projects_region_type on public.projects(region_type);
create index if not exists idx_projects_project_type on public.projects(project_type);
create index if not exists idx_projects_category on public.projects(category);
create index if not exists idx_projects_sido on public.projects(sido);
create index if not exists idx_projects_sigungu on public.projects(sigungu);
create index if not exists idx_projects_year on public.projects(year);

-- Regions: only add truly missing metadata fields.
alter table if exists public.regions
  add column if not exists is_head_office boolean default false;

create index if not exists idx_regions_sido_sigungu on public.regions(sido, sigungu);
create index if not exists idx_regions_region_type on public.regions(region_type);
create index if not exists idx_regions_display_name on public.regions(display_name);

-- Audit logs: support current app log fields if missing.
alter table if exists public.audit_logs
  add column if not exists action varchar;

create index if not exists idx_audit_logs_action on public.audit_logs(action);

notify pgrst, 'reload schema';
