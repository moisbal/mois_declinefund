# 지방소멸대응기금 TEST 브라우저 통합시험

이 디렉터리는 서비스 화면과 분리된 TEST 전용 관찰형 실행기입니다. 실행기는 정확히 아래 두 호스트만 허용하고, Production 프로젝트 참조가 환경에 섞이면 시작 전에 종료합니다.

- `https://declinefund-test.vercel.app`
- `https://reviewtestxxxxxxxxxx.supabase.co`

## 설치와 실행

저장소 루트에서 한 번만 설치합니다.

```powershell
npm --prefix test-automation install
```

조회 전용 점검:

```powershell
npm --prefix test-automation run test:read
```

지자체 3개·관리자 2개 계정의 로그인, 담당 지역, 주요 화면, 역할 권한, 내부 식별자 노출을 독립 세션으로 점검:

```powershell
npm --prefix test-automation run test:accounts
```

핵심 연결 시나리오(TEST 데이터 변경):

```powershell
npm --prefix test-automation run test:core -- --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

전체 변경 시험(핵심 연결, 기존사업 간 조정, 복수배분·재원 선확보, 반려·재신청, 사업정보, 소분류, 원장 집행):

```powershell
npm --prefix test-automation run test:all:mutate -- --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

특정 연도의 감액 원천 사업을 기준으로 전체 변경 시험을 실행하려면 `--source-project-id <TEST 사업 ID>`를 추가합니다. 핵심·기존사업 증액·복수배분 시나리오가 모두 같은 원천 사업의 연도와 지역을 사용합니다.

전체 조회 시험(연결 점검, 검색·필터·통계·분포도·권한·한글화·다운로드·입력 차단):

```powershell
npm --prefix test-automation run test:all:read-only -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

기존사업 A 감액 → 기존사업 B 증액(TEST 데이터 변경):

```powershell
npm --prefix test-automation run test:existing-transfer -- --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

복수배분·재원 선확보(TEST 데이터 변경):

```powershell
npm --prefix test-automation run test:split-funding-first -- --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

반려 사유 확인 → 보완 → 재신청(TEST 데이터 변경, 수신 확인 후 반려 종결):

```powershell
npm --prefix test-automation run test:rejection-resubmit -- --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

핵심 실행으로 만든 사업의 정보·분류·연계사업, 소분류 제안 처리, 원장 집행(TEST 데이터 변경):

```powershell
npm --prefix test-automation run test:project-metadata -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
npm --prefix test-automation run test:small-category-lifecycle -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
npm --prefix test-automation run test:native-execution -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

전체 기능 조회 시뮬레이션과 실패 직접영향 재시험:

```powershell
npm --prefix test-automation run test:coverage -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
npm --prefix test-automation run test:coverage:retry -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

추가 조회·차단 회귀시험(핵심 실행 ID 필요):

```powershell
npm --prefix test-automation run test:regression -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
npm --prefix test-automation run test:validation -- --reference-run-id <핵심 실행 ID> --run-id AUTO-INT-YYYYMMDD-HHMMSS
```

`--run-id`를 생략하면 새 실행 ID가 생성됩니다. 같은 ID의 요청이 이미 있으면 상태·출처·목적지·금액을 먼저 확인하며, 완료 건은 검증만 하고 거래를 다시 제출하거나 적용하지 않습니다. 자동 재개할 수 없는 상태나 거래 내용 불일치는 안전하게 중단합니다.

명령 예시 끝의 설명용 `...`을 터미널에 입력하면 안 됩니다. `<핵심 실행 ID>`와 `AUTO-INT-YYYYMMDD-HHMMSS`도 실제 값으로 바꾸거나, 새 실행이면 `--run-id` 전체를 생략합니다.

특정 시나리오 재실행:

```powershell
node test-automation/runner.mjs --mode read-only --scenario smoke --headed
node test-automation/runner.mjs --mode read-only --scenario account-matrix --headed
node test-automation/runner.mjs --mode mutate --scenario core --headed --confirm-test-write --run-id <기존 또는 새 실행 ID>
node test-automation/runner.mjs --mode mutate --scenario core --headed --confirm-test-write --run-id <완료 실행 ID> --from-step 12
node test-automation/runner.mjs --mode mutate --scenario existing-transfer --headed --confirm-test-write --run-id <기존 또는 새 실행 ID>
node test-automation/runner.mjs --mode mutate --scenario split-funding-first --headed --confirm-test-write --run-id <기존 또는 새 실행 ID>
node test-automation/runner.mjs --mode mutate --scenario rejection-resubmit --headed --confirm-test-write --run-id <기존 또는 새 실행 ID>
node test-automation/runner.mjs --mode mutate --scenario project-metadata --headed --confirm-test-write --reference-run-id <핵심 실행 ID> --run-id <기존 또는 새 실행 ID>
node test-automation/runner.mjs --mode mutate --scenario small-category-lifecycle --headed --confirm-test-write --reference-run-id <핵심 실행 ID> --run-id <기존 또는 새 실행 ID>
node test-automation/runner.mjs --mode mutate --scenario native-execution --headed --confirm-test-write --reference-run-id <핵심 실행 ID> --run-id <기존 또는 새 실행 ID>
```

로컬 화면에서 미배포 서비스 수정까지 검증할 때는 별도 터미널에서 TEST 미리보기를 시작한 뒤 각 명령에 `--base-url http://127.0.0.1:3010`을 추가합니다.

```powershell
node test-automation/build-clean-test-preview.cjs
node test-automation/start-clean-test-preview.cjs
```

기본값은 `.codex-tmp/localization-clean`의 빌드를 사용합니다. 현재 작업트리의 개발 서버가 꼭 필요한 경우에만 `--current`를 붙입니다. 두 스크립트는 정확한 TEST 프로젝트 확인을 통과한 뒤에만 로컬 서버의 `LEDGER_MODE=test`를 설정합니다.

## 자동화 범위와 안전 제외

- 지자체: 사업목록 검색·연도·상태 필터, 정렬, 상세 이동, 초안/진행/완료 요청, 사업정보·분류·연계사업, 예산조정, 소분류 제안, 원장 집행, 대시보드·분석·분포도
- 관리자: 예산조정 6개 업무 탭, 승인·반려·적용·처리이력, 사업변경 상세·XLSX, 소분류 신규승인·기존매핑·반려, 대시보드·분석·전국→시도→시군구 드릴다운, 관리자 설정 조회
- 공통: 역할 우회 차단, 새로고침·URL 상태 유지, 금액 차액 0원, DB 읽기 전용 대조, 내부 상태코드·시험 표식·영문 노출 검사
- 실제 변경 제외: 운영전환, 계정 일괄 생성과 초기 비밀번호 파일, 공유 계정 비밀번호 변경
- 현재 화면 미제공: 원장 재원이동·이월·정정 서버 동작은 코드에 있으나 사용자 화면이 없어 브라우저 시뮬레이션에서 실행하지 않습니다. 기존 예산조정 화면의 A→B 이동은 별도로 실제 검증합니다.

## 관찰과 중단

`--headed` 실행은 지자체와 관리자 Chrome을 역할별 독립 세션으로 띄우고 화면을 좌우 위치에 배치합니다. 이 방식은 백그라운드 페이지 조작이며 Windows 전면 창 전환을 보장하지 않습니다. 운영체제가 위치 인수를 무시하면 사용자가 두 창을 한 번 나란히 배치해야 합니다. 중요한 화면은 기본 2.5초 유지합니다(`--hold-ms 3000`처럼 변경 가능).

터미널에는 시나리오, 역할, 단계, 기대값, 실제값, PASS/FAIL/미실행을 한국어로 표시합니다. 결과와 화면 증거는 `test-automation/artifacts/<실행 ID>/`에 저장됩니다.

중단은 실행 터미널에서 `Ctrl+C`입니다. 중단 전에 이미 제출·승인·적용된 TEST 거래는 자동 취소되지 않습니다. 같은 실행 ID로 재실행하면 기존 상태 점검이 먼저 수행됩니다.

## 2026-09-09 최초 실제 실행

- 핵심 연결 `AUTO-INT-20260909-100000`: PASS 19 / FAIL 0
- 조회·한글화 회귀 `AUTO-INT-20260909-110000`: 지역 분포도 실제 화면 PASS, PASS 14 / FAIL 1(다음 입력 단계에서 비동기 선택창이 클릭을 가로막은 실행기 격리 오류)
- 실패 직접영향 재시험 `AUTO-INT-20260909-114000`: 감액 가능액 초과·미배분 차단 포함 PASS 7 / FAIL 0
- 기존사업 A→B `AUTO-INT-20260909-120000`: PASS 13 / FAIL 0
- 복수배분·재원 선확보 `AUTO-INT-20260909-130000`: PASS 13 / FAIL 0, 거래 차액 0원
- 반려·보완·재신청 `AUTO-INT-20260909-140000`: PASS 12 / FAIL 0, 적용 스냅샷 0건·금액 변동 0원
- 전체 기능 조회 `AUTO-INT-20260909-162000` 및 직접영향 재시험 `AUTO-INT-20260909-169000`: 조회 항목 전체 통과, 마지막 재시험 PASS 8 / FAIL 0
- 사업정보·분류·연계사업 `AUTO-INT-20260909-170000`: PASS 10 / FAIL 0, 사업명 복원·금액 차액 0원
- 소분류 승인·매핑·반려 `AUTO-INT-20260909-171000`: PASS 11 / FAIL 0
- 핵심 생성사업 후속 A→B `AUTO-INT-20260909-172100`: PASS 12 / FAIL 0, 100,000원·거래 차액 0원
- TEST 원장 집행 `AUTO-INT-20260909-172500`: PASS 10 / FAIL 0, 10,000원 확정·잔액 890,000원·양쪽 분석 차액 0원·중복 0건

회귀 실행에서 발견한 실행기 격리 오류는 비동기 선택창이 표시될 때까지 기다린 뒤 닫도록 수정했습니다. 서비스의 지역 분포도는 현재 필터 결과와 같은 행을 정수 원 단위로 집계해 표시하며, 실제 관리자 화면 증거를 저장했습니다.

## 계정과 보안

환경 파일은 저장소 루트의 `.env.ledger-test.local`, `.env.ledger-uat-credentials.local`만 읽습니다. 기본 역할은 `UAT_LOCAL_B`(부산 서구)와 `UAT_ADMIN_A`입니다. 비밀번호, 토큰, 쿠키는 출력·결과·화면 캡처에 기록하지 않습니다.
