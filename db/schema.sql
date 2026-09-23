-- Supabase table schema for decline fund dashboard

create extension if not exists "uuid-ossp";

create table regions (
  id uuid primary key default uuid_generate_v4(),
  region_code text unique,
  sido text not null,
  sigungu text not null,
  region_type text,
  display_name text,
  population int,
  elderly_rate numeric,
  net_migration_2025 int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table profiles (
  id uuid primary key,
  email text,
  login_id text unique,
  name text,
  role text not null check (role in ('admin', 'local_user')),
  region_id uuid references regions(id),
  region_name text,
  first_login boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table projects (
  id uuid primary key default uuid_generate_v4(),
  project_id text unique not null,
  region_id uuid references regions(id) not null,
  year int,
  sido text,
  sigungu text,
  project_name text,
  project_type text,
  total_budget bigint,
  alloc bigint,
  exec bigint,
  rate numeric,
  period text,
  status text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table audit_logs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) not null,
  region_id uuid references regions(id),
  field_name text,
  old_value text,
  new_value text,
  changed_by uuid references profiles(id) not null,
  changed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
