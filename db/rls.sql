-- Row Level Security policies for decline fund dashboard

alter table profiles enable row level security;
alter table projects enable row level security;
alter table audit_logs enable row level security;

-- profiles: self access and admin all
create policy profiles_self_select on profiles for select using (
  id = auth.uid()
);

create policy profiles_admin_select on profiles for select using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy profiles_admin_update on profiles for update using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

-- projects: admin all, region own region only
create policy projects_admin_select on projects for select using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy projects_region_select on projects for select using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'local_user' and p.region_id = projects.region_id
  )
);

create policy projects_admin_update on projects for update using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy projects_region_update on projects for update using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'local_user' and p.region_id = projects.region_id
  )
);

create policy projects_admin_insert on projects for insert with check (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy projects_region_insert on projects for insert with check (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'local_user' and p.region_id = projects.region_id
  )
);

-- project_change_logs: admin all, region own region logs insert/select
create policy audit_admin_select on audit_logs for select using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy audit_region_select on audit_logs for select using (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'local_user'
      and exists (
        select 1 from projects pj where pj.id = audit_logs.project_id and pj.region_id = p.region_id
      )
  )
);

create policy audit_admin_insert on audit_logs for insert with check (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy audit_region_insert on audit_logs for insert with check (
  exists (
    select 1 from profiles p where p.id = auth.uid() and p.role = 'local_user'
      and audit_logs.changed_by = auth.uid()
      and exists (
        select 1 from projects pj where pj.id = audit_logs.project_id and pj.region_id = p.region_id
      )
  )
);
