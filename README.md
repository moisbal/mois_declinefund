# 지방소멸대응기금 사업관리 시스템

## 개요
Next.js와 Supabase Auth/RLS 기반으로 구현된 지방소멸대응기금 사업관리 시스템입니다. 지자체 담당자는 본인 지역 사업만 조회/수정 가능하며, 관리자 계정은 전체 데이터를 관리할 수 있습니다.

## 프로젝트 구조
- `app/`: Next.js App Router 페이지
- `components/`: 로그인, 대시보드, 관리자 UI 컴포넌트
- `lib/`: Supabase 클라이언트, 인증, 프로젝트/감사 로그 서비스
- `db/`: SQL 스키마 및 시드 데이터
- `scripts/`: 운영/테스트용 시드 스크립트

## 로컬 실행 방법
1. 프로젝트 루트에서 환경변수 설정
   - `.env.local` 파일 생성
   - `.env.example` 내용을 참고하여 다음 값 설정
     - `NEXT_PUBLIC_SUPABASE_URL`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
2. 의존성 설치
   - `npm install`
3. 개발 서버 실행
   - `npm run dev`
4. 빌드 확인
   - `npm run build`
   - `npm run start`

## Supabase 설정 방법
1. Supabase 프로젝트 생성
2. Database > SQL Editor에서 `db/schema.sql` 실행
3. Database > SQL Editor에서 `db/rls.sql` 실행
4. `SUPABASE_SERVICE_ROLE_KEY`를 Supabase 프로젝트의 서비스 역할 키로 `.env.local`에 설정
5. Supabase Auth에서 이메일/비밀번호 로그인 활성화

## SQL 실행 순서
1. `db/schema.sql` 실행
2. `db/rls.sql` 실행
3. `db/seed.sql` 실행 (테스트 데이터 입력)

## 테스트 계정
- 관리자
  - 이메일: `admin@declinefund.local`
  - 초기 비밀번호: Supabase에서 설정 필요
- 지자체
  - 이메일: `kangwon-a@declinefund.local`
  - 이메일: `jeonnam-b@declinefund.local`
  - 이메일: `chungbuk-c@declinefund.local`
  - 초기 비밀번호: Supabase Auth 또는 관리자 계정 생성 시 발급

## 107개 지자체 계정 생성 방법
1. 관리자 계정으로 로그인
2. 관리자 페이지에서 `지자체 계정 일괄 생성` 클릭
3. 초기 비밀번호 CSV 다운로드

## 초기 비밀번호 생성 방식
- 14자 이상
- 대문자, 소문자, 숫자, 특수문자 혼합
- region명이나 login_id와 무관한 랜덤 생성

## Vercel 배포 방법
1. GitHub에 저장소 업로드
2. Vercel에서 새 프로젝트 생성
3. 환경변수 추가
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. `npm run build` 확인 후 배포

## 아직 사람이 직접 처리해야 할 작업
- 실제 Supabase 프로젝트 생성 및 환경변수 적용
- Supabase Auth에서 관리자 계정 초기 비밀번호 설정
- 107개 지자체용 `regions` 데이터를 실제 Excel에서 DB로 마이그레이션
- `profiles`와 `auth.users` 동기화 점검

## 보안 주의사항
- `.env.local`에 서비스 역할 키를 절대 공개하지 마십시오
- 초기 비밀번호 파일은 안전한 경로로 보관하십시오
- 사용자 비밀번호는 DB에 평문 저장하지 않습니다
