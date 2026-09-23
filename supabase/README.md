> 점검용 보존 문서: 아래는 초기 구조 기준의 과거 안내입니다. 현재 TEST DB와의 동일성 또는 아래 순서만으로 현재 DB가 재현됨을 보장하지 않습니다. 최신 업무 흐름과 실행 제한은 ../docs/SECURITY_PERFORMANCE_REVIEW.md를 우선 확인하세요. 계정·비밀번호는 모두 예시/자리표시자입니다.

Supabase SQL deployment for Declinefund Management
===============================================

Overview
--------
This folder contains SQL files to create the DB schema, Row Level Security (RLS) policies, and seed data used for local testing of the 지방소멸대응기금 사업관리 시스템.

Files
-----
- `schema.sql` – Creates tables: `regions`, `profiles`, `projects`, `audit_logs`, indexes and triggers.
- `rls.sql` – Enables Row Level Security and creates policies enforcing that `local_user` accounts can only access their own region's projects, while `admin` accounts can access everything.
- `seed.sql` – Inserts example regions, one admin profile and three local profiles, 20 projects and a few sample audit log entries for testing.

Execution order (recommended)
-----------------------------
1. In the Supabase SQL editor execute `schema.sql`.
2. Execute `rls.sql` to enable policies.
3. Execute `seed.sql` to populate sample data.

Notes about `profiles` and `auth.users`
--------------------------------------
- The `profiles.id` column is intended to match `auth.users.id` (Supabase Auth). The schema adds a NOT VALID foreign key to `auth.users` to indicate the relationship while allowing seeding before the Auth users are created. After creating real Auth users, you may want to validate the constraint with:

  alter table public.profiles validate constraint profiles_auth_users_fkey;

- For realistic login testing: create Auth users in Supabase (Auth → Users) with the UUIDs used in `seed.sql` (or update `profiles.id` to match the user id assigned by Auth). The seed uses example UUIDs; replace them with real values in production.

What each table is for
----------------------
- `regions(code, name)`: canonical region list. `code` is the region identifier used in `profiles.region_id` and `projects.region_id`.
- `profiles(id, region_id, role, ...)`: maps an authenticated user to a local region and a role (`admin` or `local_user`).
- `projects(...)`: main business data. `region_id` determines data ownership for RLS.
- `audit_logs(...)`: records every modification made to projects (who changed what and when).

RLS behavior summary
--------------------
- local_user:
  - SELECT only projects where `projects.region_id = profiles.region_id` for the logged-in profile.
  - INSERT/UPDATE/DELETE only allowed for rows with the same `region_id`.
  - Can insert audit log rows for their region (and must set `changed_by = auth.uid()`).
- admin:
  - Full SELECT/INSERT/UPDATE/DELETE access to `projects`, `profiles` and `audit_logs`.

Testing
-------
1. Run the three SQL files in the order described above.
2. In Supabase Auth create users with the UUIDs used in `seed.sql` (or sign up and then set `profiles.id` to match the created user id).
3. Try queries in the SQL editor using the `auth` context or via the application to verify that:
   - A `local_user` only sees projects for their region.
   - An `admin` sees all projects and audit logs.

Create test Auth users automatically (convenience)
-----------------------------------------------
If you have set `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your environment (for local testing, add them to `.env.local`), you can run the included Node script to create the Auth users and upsert matching `profiles` rows:

```bash
# from repo root
npm run create-test-users
```

The script `scripts/create_test_users.cjs` will attempt to create the following accounts (passwords shown are for local testing only):

- admin: `review-account-12@example.invalid` / `REPLACE_WITH_TEST_PASSWORD` (UUID `00000000-0000-0000-0000-000000000001`)
- 강원 A군 user: `review-account-13@example.invalid` / `REPLACE_WITH_TEST_PASSWORD` (UUID `11111111-1111-1111-1111-111111111111`)
- 전남 B군 user: `review-account-14@example.invalid` / `REPLACE_WITH_TEST_PASSWORD` (UUID `22222222-2222-2222-2222-222222222222`)
- 충북 C군 user: `review-account-15@example.invalid` / `REPLACE_WITH_TEST_PASSWORD` (UUID `33333333-3333-3333-3333-333333333333`)

After running the script, verify in Supabase Auth → Users that those users exist, and then test login flows or use the SQL editor simulating `auth.uid()` context to validate RLS.

Next steps
----------
- Integrate profile creation on first login (create `profiles` row for the user using server-side code if missing).
- Implement server-side checks and API endpoints to create audit log entries when projects are modified.
- Consider adding a `regions` management UI and seed the full list of 107 region codes.
