-- supabase/seed.sql
-- Seed data for quick testing of RLS and relationships

-- Regions (small sample including an ADMIN bucket)
insert into public.regions (code, name) values
  ('ADMIN', 'Administrator'),
  ('GW-A', '강원 A군'),
  ('JN-B', '전남 B군'),
  ('CB-C', '충북 C군')
on conflict (code) do nothing;

-- Example UUIDs for test accounts (replace with real auth user IDs in production)
-- Admin
insert into public.profiles (id, region_id, region_name, role, first_login)
values
  ('00000000-0000-0000-0000-000000000001','ADMIN','Administrator','admin',false)
on conflict (id) do nothing;

-- Local users for three example regions
insert into public.profiles (id, region_id, region_name, role, first_login)
values
  ('11111111-1111-1111-1111-111111111111','GW-A','강원 A군','local_user',true),
  ('22222222-2222-2222-2222-222222222222','JN-B','전남 B군','local_user',true),
  ('33333333-3333-3333-3333-333333333333','CB-C','충북 C군','local_user',true)
on conflict (id) do nothing;

-- Projects: create 20 projects distributed across regions
-- We'll create 8 for GW-A, 6 for JN-B, 6 for CB-C
with gen as (
  select 1 as n
)
insert into public.projects (project_id, region_id, year, sido, sigungu, project_name, category, total_budget, allocated_amount, executed_amount, execution_rate, start_year, end_year, status)
values
  ('GW-A-001','GW-A',2024,'강원','A군','강원 혁신사업 1','인프라',100000000,50000000,25000000,50.00,2024,2024,'active'),
  ('GW-A-002','GW-A',2024,'강원','A군','강원 복지사업 2','복지',80000000,40000000,20000000,50.00,2024,2025,'active'),
  ('GW-A-003','GW-A',2025,'강원','A군','강원 문화사업 3','문화',30000000,30000000,10000000,33.33,2025,2025,'planned'),
  ('GW-A-004','GW-A',2023,'강원','A군','강원 교육사업 4','교육',20000000,20000000,20000000,100.00,2023,2023,'completed'),
  ('GW-A-005','GW-A',2024,'강원','A군','강원 환경사업 5','환경',50000000,25000000,12500000,50.00,2024,2026,'active'),
  ('GW-A-006','GW-A',2024,'강원','A군','강원 교통사업 6','인프라',120000000,60000000,30000000,50.00,2024,2026,'active'),
  ('GW-A-007','GW-A',2024,'강원','A군','강원 보건사업 7','보건',40000000,20000000,10000000,50.00,2024,2025,'active'),
  ('GW-A-008','GW-A',2024,'강원','A군','강원 지역개발 8','개발',90000000,45000000,22500000,50.00,2024,2027,'active'),

  ('JN-B-001','JN-B',2024,'전남','B군','전남 혁신사업 1','인프라',70000000,35000000,17500000,50.00,2024,2024,'active'),
  ('JN-B-002','JN-B',2024,'전남','B군','전남 복지사업 2','복지',60000000,30000000,15000000,50.00,2024,2025,'active'),
  ('JN-B-003','JN-B',2024,'전남','B군','전남 교육사업 3','교육',25000000,12500000,6250000,50.00,2024,2025,'planned'),
  ('JN-B-004','JN-B',2023,'전남','B군','전남 환경사업 4','환경',45000000,22500000,11250000,50.00,2023,2024,'completed'),
  ('JN-B-005','JN-B',2025,'전남','B군','전남 문화사업 5','문화',35000000,17500000,8750000,50.00,2025,2025,'planned'),
  ('JN-B-006','JN-B',2024,'전남','B군','전남 보건사업 6','보건',30000000,15000000,7500000,50.00,2024,2025,'active'),

  ('CB-C-001','CB-C',2024,'충북','C군','충북 혁신사업 1','인프라',55000000,27500000,13750000,50.00,2024,2024,'active'),
  ('CB-C-002','CB-C',2024,'충북','C군','충북 복지사업 2','복지',42000000,21000000,10500000,50.00,2024,2025,'active'),
  ('CB-C-003','CB-C',2025,'충북','C군','충북 문화사업 3','문화',20000000,10000000,5000000,50.00,2025,2025,'planned'),
  ('CB-C-004','CB-C',2023,'충북','C군','충북 교육사업 4','교육',15000000,15000000,15000000,100.00,2023,2023,'completed'),
  ('CB-C-005','CB-C',2024,'충북','C군','충북 환경사업 5','환경',32000000,16000000,8000000,50.00,2024,2026,'active'),
  ('CB-C-006','CB-C',2024,'충북','C군','충북 보건사업 6','보건',28000000,14000000,7000000,50.00,2024,2025,'active')
on conflict (project_id) do nothing;

-- Sample audit logs (small set)
insert into public.audit_logs (project_id, region_id, changed_column, old_value, new_value, changed_by)
select p.id, p.region_id, 'status', 'planned', 'active', '11111111-1111-1111-1111-111111111111'
from public.projects p
where p.project_id in ('GW-A-001','JN-B-001','CB-C-001')
on conflict do nothing;
