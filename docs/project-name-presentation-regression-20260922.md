# 시험용 사업명 표시 재발 방지

- 대상: `TEST-RECHECK-20260915111205 부산 혼합 신규이관` 등 시험 실행 식별자가 포함된 사업명.
- 현재 테스트 사이트에서 상세 제목·현재 사업명·변경 사업명·예산조정 내역에 원문이 표시되는 것을 브라우저로 확인했다.
- 공통 표시 함수의 범용 제거 처리가 기존 TEST-UAT/OPS 한글 변환보다 먼저 실행되어 `[TEST-UAT-...]`를 `[]`로 만드는 기존 회귀도 재현했다.

## 수정

- 기존 한글 변환을 우선 적용하고, 날짜가 포함된 다른 TEST 실행 식별자는 사업명에서 제거한다.
- 대괄호, 식별자만 있는 이름, 삭제·보관·변경 안내 접두어, 반복 표시를 처리한다.
- 유사 사업 창의 안내 문구와 분류명도 공통 표시 함수를 사용한다.
- 정상 영문 사업명과 원문 검색 색인은 보존한다. 데이터베이스 값·재정금액 변경은 없다.
- `npm run test:presentation`을 추가하고 `prebuild`에 연결했다. 표시 회귀 검사가 실패하면 `npm run build`가 중단된다.
- 기존 작업 중이던 MyProjectsWorkspace·ConfirmationCenterShell 수정과 소스 검토 ZIP 삭제 상태는 유지했다.

## 검증

- 표시 회귀 검사: 17개 통과.
- `npm run build`: 성공. 컴파일·린트·타입 검사·18개 페이지 생성 완료.
- 전체 단위 검사: 239개 중 237개 통과. 아래 2개는 이번 변경 대상 밖의 기존 소스 구조를 가정하는 검사이며 해당 파일들은 HEAD 대비 변경이 없다.
  - `budgetChangeWorkflowContract.test.ts`: 조정 사유에 이전 `formatStoredUserText` 호출을 기대한다.
  - `passwordChangeContract.test.ts`: 공통 헤더에 직접 비밀번호 변경 버튼이 있을 것을 기대하지만 현재 사이드바로 이동되어 있다.
- 실제 ProjectBasicInfoSection·SimilarProjectDialog 컴포넌트를 서버 렌더링한 로컬 검증 화면에서 제목·입력값·후보명에 시험 코드가 없는 것을 확인했다. 이 검증은 배포된 앱의 저장 동작 검증이 아니다.
- 증거: `artifacts/presentation-render-check.png`, `artifacts/presentation-render-check.html`.
- 빌드 로그: `artifacts/presentation-build-check.log`.

## 배포 상태

- 테스트 대상: `https://declinefund-test.vercel.app`.
- 로컬 Vercel 연결: `declinefund-test-server`.
- Vercel 배포 조회가 `The specified token is not valid`로 실패하여 원격 배포를 진행하지 않았다.
- Vercel 재로그인 후 테스트 대상 연결을 재확인하고 수정본을 배포한 뒤 목록·유사 사업·상세 화면을 다시 검증해야 한다.
