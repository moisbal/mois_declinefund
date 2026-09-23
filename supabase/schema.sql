-- supabase/schema.sql
-- Schema for Declinefund Management: regions, profiles, projects, audit_logs

-- Extension for UUID generation
create extension if not exists "pgcrypto";

-- Regions table: canonical list of region codes/names
create table if not exists public.regions (
  code varchar primary key,
  name varchar not null,
  created_at timestamptz default now()
);

-- Profiles: links an authenticated user to a region and role
create table if not exists public.profiles (
  id uuid primary key,
  region_id varchar not null references public.regions(code) on delete set null,
  region_name varchar,
  role varchar not null default 'local_user', -- 'admin' | 'local_user'
  first_login boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Add (non-validated) foreign key relation to auth.users to indicate canonical link
-- NOTE: This constraint is added NOT VALID to allow seeding before creating auth.users rows.
alter table public.profiles
  add constraint profiles_auth_users_fkey
  foreign key (id) references auth.users(id) not valid;

-- Projects: fund projects managed per region
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_id varchar unique,
  region_id varchar not null references public.regions(code) on delete cascade,
  year integer,
  sido varchar,
  sigungu varchar,
  project_name text,
  category varchar,
  total_budget numeric(14,2) default 0,
  allocated_amount numeric(14,2) default 0,
  executed_amount numeric(14,2) default 0,
  execution_rate numeric(5,2) default 0,
  start_year integer,
  end_year integer,
  status varchar,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_projects_region_id on public.projects(region_id);
create index if not exists idx_projects_project_id on public.projects(project_id);

-- Audit logs for changes to projects
create table if not exists public.audit_logs (
  id bigserial primary key,
  project_id uuid references public.projects(id) on delete cascade,
  region_id varchar,
  changed_column varchar,
  old_value text,
  new_value text,
  changed_by uuid,
  created_at timestamptz default now()
);

create index if not exists idx_audit_logs_project_id on public.audit_logs(project_id);
create index if not exists idx_audit_logs_region_id on public.audit_logs(region_id);

-- Trigger helper to keep updated_at in sync (optional simple implementation)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
