-- 테스트용 시드 데이터

insert into regions (id, region_code, sido, sigungu, region_type, display_name, population, elderly_rate, net_migration_2025)
values
  ('11111111-1111-1111-1111-111111111111', 'RN001', '강원', 'A군', '감소', '강원 A군', 45000, 25.4, -520),
  ('22222222-2222-2222-2222-222222222222', 'RN002', '전남', 'B군', '관심', '전남 B군', 38000, 24.1, -430),
  ('33333333-3333-3333-3333-333333333333', 'RN003', '충북', 'C군', '감소', '충북 C군', 41000, 26.0, -380);

insert into profiles (id, email, login_id, name, role, region_id, region_name, first_login, created_at, updated_at)
values
  ('aaaa1111-aaaa-1111-aaaa-111111111111', 'admin@declinefund.local', 'admin', '행안부 관리자', 'admin', null, null, false, now(), now()),
  ('bbbb2222-bbbb-2222-bbbb-222222222222', 'kangwon-a@declinefund.local', 'kangwon-a', '강원 A군 담당자', 'local_user', '11111111-1111-1111-1111-111111111111', '강원 A군', true, now(), now()),
  ('cccc3333-cccc-3333-cccc-333333333333', 'jeonnam-b@declinefund.local', 'jeonnam-b', '전남 B군 담당자', 'local_user', '22222222-2222-2222-2222-222222222222', '전남 B군', true, now(), now()),
  ('dddd4444-dddd-4444-dddd-444444444444', 'chungbuk-c@declinefund.local', 'chungbuk-c', '충북 C군 담당자', 'local_user', '33333333-3333-3333-3333-333333333333', '충북 C군', true, now(), now());

insert into projects (project_id, region_id, year, sido, sigungu, project_name, project_type, total_budget, alloc, exec, rate, period, status, created_at, updated_at)
values
  ('P001', '11111111-1111-1111-1111-111111111111', 2025, '강원', 'A군', '마을공동체 활성화', '생활SOC', 120000000, 100000000, 42000000, 42.0, '2025-03 ~ 2025-12', '진행중', now(), now()),
  ('P002', '11111111-1111-1111-1111-111111111111', 2025, '강원', 'A군', '청년 일자리 창출', '일자리', 95000000, 90000000, 87000000, 96.7, '2025-04 ~ 2025-11', '진행중', now(), now()),
  ('P003', '22222222-2222-2222-2222-222222222222', 2025, '전남', 'B군', '지역 특화 관광 개발', '관광', 73000000, 71000000, 56000000, 78.9, '2025-02 ~ 2025-10', '진행중', now(), now()),
  ('P004', '33333333-3333-3333-3333-333333333333', 2025, '충북', 'C군', '농촌 생활 인프라 개선', '인프라', 82000000, 82000000, 81000000, 98.8, '2025-01 ~ 2025-09', '완료', now(), now());
