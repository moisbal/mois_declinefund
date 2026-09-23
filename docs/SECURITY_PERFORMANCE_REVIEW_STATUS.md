# 보안·성능 점검 전달본 검증 기록

기준일: 2026-09-23. 본 문서는 커밋 전 검증 기록이며 실제 업로드 결과와 SHA는 GitHub 점검 브랜치 및 최종 전달 보고에서 확인한다.

- 실제 프로젝트: C:\Users\pangkim17\declinefund_magnt
- 목적지: https://github.com/moisbal/mois_declinefund (private, 로컬 인증으로 admin/push/pull 권한 확인).
- 점검 브랜치: review/security-performance-20260923. 기존 main 및 업무 브랜치에 push하지 않는다.
- 기존 HEAD: 5ff4a776bc264c58ad8994916843feac15532cbd. 기존 로컬 브랜치/18개 커밋 이력과 작업 파일을 보존한다.
- 과거 이력을 포함하지 않는 독립 첫 커밋에 현재 소스 사본만 담는다. git init, 원격 덮어쓰기, 이력 재작성, 강제 push는 사용하지 않는다.
- 초기 물리 파일 총용량: 1,611,174,338 bytes. 업로드 파일은 약 4.4 MB이며 최종 정확한 파일 수·용량은 커밋 트리와 최종 보고를 기준으로 한다.
- 초기 추적 1025개, 미추적 6개, 제외 22935개. 어제 선별한 719개 경로는 로컬 파일을 보존하고 원래 index에서 추적 제외했다. 이 중 코드/문서 5개는 가명 사본으로 다시 포함한다. 원래 index를 전부 지우거나 원래 수정사항을 되돌리지 않았다.

## 안전 검사

기존 HEAD의 18개 커밋, 673개 blob(36,332,131 bytes)을 검사하여 비밀번호·업무자료가 있는 이력을 확인했다. 주요 경로는 scripts/create_test_users.cjs, supabase/README.md, data/fund_projects_raw.json 및 test-results의 DB 스냅샷이며 c89b7a0ee382/7ce402302fd8/5ff4a776bc26 이력에 관련 항목이 있다. 이 이력은 전송하지 않는다.

전송 사본의 모든 텍스트를 개인키, 토큰, JWT, 자격증명 포함 연결문자열, 하드코딩 비밀번호, 실제 로컬 환경값·계정정보·거래 UUID와 대조했다. SQL INSERT 후보는 합성 seed 또는 함수 내부 동적 처리를 확인했으며 실제 DB 추출물은 제외했다. 문서의 비밀번호 설명과 REPLACE_WITH 자리표시자는 실제 비밀값이 아니다. 자동 패턴 검사만으로 모든 종류의 비밀정보가 없음을 수학적으로 보장하지는 않는다. 전송 사본에는 바이너리가 없다.

## 자동 실행 확인

로컬 Git 인증으로 저장소 private 상태와 권한을 확인했다. 업로드 전 원격 refs, 워크플로, 웹훅, 배포 기록은 0개이고 Actions는 활성화 상태다. 로컬에도 .github/workflows가 없고 npm 설치 lifecycle에 배포/마이그레이션 자동 실행 명령이 없다.

GitHub App API는 403이었으나 로그인된 GitHub 관리 화면에서 Vercel 앱 설치를 확인했다. Vercel Regional Budget Mngt 팀의 declinefund-test-server와 declinefund-demo 모두 Git 설정에 저장소 미연결이 명시되어 있고 Deploy Hook도 없다. Netlify 앱/웹훅/로컬 설정은 발견되지 않았다. 관리 설정만 조회했으며 서비스, Auth, DB에는 접속하지 않았다. 확인한 설정상 이 push로 자동 배포/DB 작업이 시작되는 경로는 없다. 이후 연결 변경 시 재검토한다.

## 검증 및 미확인 사항

- 실행 소스/import/npm 코드 경로 누락 0개, SQL 65개 정의 보존, 소스 구문 오류 0개.
- TypeScript 타입 검사 통과, 별칭 단위검사 3개 통과.
- 기존 전체 단위검사 239개 중 237개 통과, 2개 실패. passwordChangeContract와 budgetChangeWorkflowContract의 기존 소스 계약 실패로 기능 변경 없이 보존했다. 실패를 해결했다고 보고하지 않는다.
- TEST DB와 정적 SQL 동일성, 실제 계정별 RLS 실행, 배포 소스 동일성은 미확인. 응답시간은 미측정. 추가 TEST 접근권한/메타데이터/가린 서버 로그가 필요하다.
- Production, DB 데이터/RLS/Auth/운영전환/환경변수 변경, 수동 배포, 별칭 갱신, PR 병합은 하지 않는다.

## 초기 폴더별 물리 용량

| 폴더 | 파일 수 | bytes |
|---|---:|---:|
| .codex-tmp | 13379 | 487201638 |
| (root) | 22 | 363209 |
| .git | 1402 | 22511352 |
| .next | 331 | 404292526 |
| .vercel | 2 | 648 |
| app | 28 | 267714 |
| artifacts | 11 | 888281 |
| components | 42 | 485267 |
| data | 7 | 2606423 |
| db | 3 | 6976 |
| docs | 3 | 27923 |
| exports | 3 | 7144211 |
| graphify-out | 243 | 18678991 |
| lib | 35 | 235219 |
| node_modules | 20482 | 346385482 |
| reports | 1 | 9705 |
| scripts | 84 | 1015399 |
| supabase | 65 | 1557947 |
| test-automation | 1466 | 238645852 |
| test-results | 1078 | 78596549 |
| tests | 33 | 239262 |
| types | 1 | 13764 |

[점검 안내서](SECURITY_PERFORMANCE_REVIEW.md) · [포함 파일 및 재현 범위](SECURITY_PERFORMANCE_REVIEW_COVERAGE.md)
