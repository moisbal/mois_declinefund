# Ledger Policy Delta 설계 요약

대상 파일은 `supabase/migrations/20260821000100_ledger_policy_delta.sql`이다. 이 문서는 정적 검토용 설계 설명이며 migration 실행·TEST schema 변경·runtime 활성화를 승인하지 않는다. 기존 `20260820000100_ledger_runtime_lineage_hardening.sql`은 수정하거나 선행 실행하지 않는다.

## 경계와 불변조건

- migration은 단일 transaction이며, 기존 Ledger/Cutover/Baseline 10개 테이블이 모두 0행이고 migration 18/19의 필수 함수 signature가 일치할 때만 진행된다.
- `projects`, `regions`, `profiles` 업무데이터를 수정하거나 삭제하지 않는다. `projects.alloc`, `projects.exec` 등 기존 값은 snapshot 후보를 만들 때만 읽는다.
- 완료 상태는 `environment_kind=UNBOUND`, `mode=DISABLED`, `bound_project_ref=NULL`이다. 운영 mode는 `DISABLED/RECONCILIATION/TEST` 3단계이고, 기준일은 `2026-08-31`, System Native 시작일은 `2026-09-01`로 고정한다.
- API role은 Ledger 테이블에 `SELECT`만 가진다. `INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER`는 없고, 쓰기는 검증된 `SECURITY DEFINER` RPC만 사용한다.
- 금액 거래는 `record_origin`, `evidence_id`, `request_fingerprint`를 가진다. `SYSTEM_NATIVE`는 2026-09-01 이후·TEST mode에서만, `LEGACY_EXCEL`은 RECONCILIATION 또는 TEST mode에서 2022-01-01~2026-08-31의 VERIFIED `LEGACY_RECONSTRUCTION` evidence가 있을 때만 materialize된다. DISABLED에서는 두 origin 모두 차단된다.

## 주요 object

| 영역 | object | 역할 |
|---|---|---|
| Runtime | `financial_ledger_runtime`, `financial_ledger_runtime_events` | TEST project ref binding, mode/date Gate, append-only 변경 이력 |
| Evidence | `ledger_evidence` | 목적 scope·지역·원천 시스템·파일명·SHA-256·sheet/row·기준일·batch·검증자 보존 |
| Funding lineage | `financial_project_lineages`, `financial_project_lineage_members` | 같은 지역의 연도별 project row와 member별 evidence를 명시 연결 |
| Legacy 복원 | `legacy_ledger_reconstruction_entries` | 수기 복원 event의 DRAFT→SUBMITTED→VERIFIED→APPLIED/REJECTED 상태 머신 |
| Maker-checker | `financial_ledger_change_requests` | carryover, adjustment, 모든 reversal의 요청·승인·적용 분리 |
| Baseline | 기존 `project_financial_baselines`, `project_baseline_corrections` 보강 | 명시적 분류와 correction maker-checker |
| 조회 | `financial_funding_cohort_execution`, `get_financial_funding_cohort_execution()` | cohort별 최초 재원·집행·잔액·집행률·대사 상태 |

## Evidence와 lineage

Evidence는 `LEGACY_RECONSTRUCTION`, `BASELINE`, `PROJECT_LINEAGE`, `NATIVE_TRANSACTION` scope를 가진다. Legacy/Baseline 기준일은 `2022-01-01~2026-08-31`, Project Lineage는 `2022-01-01` 이후로 상한이 없어 2027년 이후 계속사업 증빙을 허용하고, Native는 `2026-09-01` 이후만 허용한다. DRAFT의 원천 사실은 작성자(지자체 사용자는 자기 지역)가 전용 RPC로 수정할 수 있다. SUBMITTED 이후 원천 사실은 고정되고 VERIFIED/REJECTED 행은 완전 불변이다. 생성자와 최종 검증자는 같을 수 없다.

Lineage는 자동 생성하지 않는다. 요청자가 member project UUID 배열과 같은 길이의 member evidence UUID 배열을 제출하면 각 member의 실제 `region_id/year`를 확인해 정규화된 member 행에 해당 연도 증빙을 저장한다. Lineage 본체에는 하나의 공용 `evidence_id`를 두지 않는다. DRAFT에서는 작성자/자기 지역이 reason과 member 추가·삭제·교체를 할 수 있지만 SUBMITTED 이후 본체와 member는 고정된다. 관리자는 모든 member의 `PROJECT_LINEAGE` evidence가 같은 지역의 VERIFIED인지 확인한 뒤 lineage를 VERIFIED로 바꾼다. 한 project는 두 VERIFIED lineage에 포함될 수 없다. `project_code`, 사업명, 유사도, fuzzy match는 연결 근거로 사용하지 않으며 사업명 자동변경·자동병합도 없다.

일반 carryover insert trigger는 source/destination이 같은 VERIFIED lineage에 속하고, 같은 지역이며, 바로 다음 회계연도인지 확인한다. lineage가 없거나 다르면 같은 지역이어도 거부한다.

## Legacy 수기 복원

`legacy_ledger_reconstruction_entries.event_type`은 다음 다섯 가지다.

- `ALLOCATION`: 실제 최초 배분 project와 연도를 사용하며 `fiscal_year=origin_fiscal_year`, `legacy_prior_carryover_count=0`을 강제한다.
- `EXECUTION`: funding entry와 project/year/금액/일자를 명시한다.
- `CARRYOVER`: source/destination project·연도, lineage, occurrence, MYEONGSI/SAGO를 모두 명시한다.
- `TRANSFER`: 같은 funding cohort·같은 연도의 source/destination을 명시한다.
- `ADJUSTMENT`: funding entry, adjustment type과 이유를 명시한다.

origin 사실은 funding `ALLOCATION` 한 곳에만 저장한다. `EXECUTION/CARRYOVER/TRANSFER/ADJUSTMENT`의 `origin_fiscal_year`와 `legacy_prior_carryover_count`는 table CHECK 및 create/update/verify/apply 검증에서 반드시 `NULL`이어야 하고, 이 두 값은 canonical fingerprint에서도 비-ALLOCATION payload에 포함하지 않는다. 비-ALLOCATION 처리 경로는 `funding_entry_id`가 가리키는 같은 지역 ALLOCATION에서 origin을 읽는다. 특히 carryover sequence는 `destination_fiscal_year - funding ALLOCATION.origin_fiscal_year`로 매 단계 다시 계산해 1회차 `MYEONGSI`, 2회차 `SAGO`만 허용한다.

local user는 자기 지역 DRAFT를 생성·편집·제출할 수 있다. admin은 maker와 다른 경우에만 VERIFY/REJECT/APPLY할 수 있다. APPLY는 최초연도 ALLOCATION을 기존 `project_budget_cohorts/project_budget_years`로 먼저 materialize한다. 이후 sequence 1 `MYEONGSI`, sequence 2 `SAGO` CARRYOVER를 연도순으로 APPLIED해야 다음 연도 wallet이 생긴다. 비-ALLOCATION event는 이미 존재하는 source wallet을 요구하므로 중간연도에서 history를 건너뛸 수 없다. 나머지 event는 그 ALLOCATION의 `applied_cohort_id`를 참조해 기존 transaction 테이블에 `LEGACY_EXCEL`로 확정한다. 입력값을 자동 유추하거나 `projects.exec`에서 거래를 합성하지 않는다.

Legacy CARRYOVER의 입력 `lineage_id`는 source/destination으로 다시 계산한 실제 VERIFIED lineage ID와 create/update/verify/apply 경로에서 같아야 한다. 같은 지역이거나 별도의 VERIFIED lineage라는 사실만으로는 통과하지 않는다.

## Runtime mode

| mode | Legacy materialize | System Native |
|---|---|---|
| `DISABLED` | 차단 | 차단 |
| `RECONCILIATION` | VERIFIED Legacy reconstruction APPLY 허용 | 차단 |
| `TEST` | Legacy 검수·APPLY 허용 | 2026-09-01 이후 허용 |

모든 금액 테이블의 origin trigger가 동일한 runtime Gate를 다시 호출하므로 RPC 내부 검사 누락만으로 mode를 우회할 수 없다.

같은 idempotency key와 같은 canonical payload는 기존 staging/materialized 결과를 반환한다. amount/project/date/origin/evidence 등 payload가 달라 fingerprint가 바뀌면 오류다. APPLIED 행을 다시 적용해 중복 거래를 만들 수 없다.

## System Native와 maker-checker

관리자 최초 cohort 생성, 일반 execution, transfer 요청은 기존 RPC 이름을 보강해 사용한다. execution은 지자체가 자기 지역에서 직접 확정할 수 있으나 TEST runtime/date Gate, balance lock, audit, fingerprint를 통과해야 한다.

carryover, budget adjustment, execution/carryover/transfer/adjustment reversal은 `financial_ledger_change_requests`를 사용한다. 요청자와 승인자·적용자는 같을 수 없다. transfer는 기존 DRAFT/PENDING_APPROVAL 구조를 유지하고 `approve_transfer`에 self-approval 금지를 추가한다. 기존 즉시확정 carryover/adjustment/reversal RPC의 authenticated EXECUTE는 제거한다.

`financial_validate_change_request_payload(request_type, payload)`는 요청 INSERT 전에 공통 `amount>0`, 실제 ISO date, optional memo 타입/길이와 유형별 구조·기초 관계를 검증하면서 region을 확정한다.

| request type | CREATE 시 검증 |
|---|---|
| `CARRYOVER` | UUID source wallet/destination project 존재, 같은 region, 바로 다음 연도, 같은 VERIFIED lineage |
| `BUDGET_ADJUSTMENT` | UUID wallet 존재, `RETURN/EXTERNAL_DECREASE/CORRECTION_INCREASE/CORRECTION_DECREASE` 중 하나 |
| `EXECUTION_REVERSAL` | UUID original이 CONFIRMED/NORMAL execution이고 현재 미반전 금액 이내 |
| `CARRYOVER_REVERSAL` | UUID original이 CONFIRMED/NORMAL carryover이고 현재 미반전 금액 이내 |
| `TRANSFER_REVERSAL` | UUID original이 CONFIRMED/NORMAL transfer이고 현재 미반전 금액 이내 |
| `ADJUSTMENT_REVERSAL` | UUID original이 CONFIRMED/NORMAL adjustment이고 현재 미반전 금액 이내 |

알 수 없는 유형, 누락 필드, 잘못된 JSON 타입, malformed UUID/date/bigint는 CREATE에서 `22023` 또는 관계 위반 오류로 즉시 거부한다. APPROVE는 maker-checker만 수행한다. APPLY는 동일 helper를 최신 DB 상태로 다시 호출하고 저장된 region 일치 여부를 확인한 다음, 기존 분기별 row lock, lineage, available balance, 원거래 상태, 누적 reversal 한도를 다시 검증한다. CREATE 검증은 APPLY 재검증을 대체하지 않는다.

## Baseline과 Cutover

`financial_prepare_legacy_baselines()`는 명시적 관리자 호출 시 모든 project를 오직 `NEEDS_REVIEW` 후보로 snapshot한다. migration 자체는 Baseline 행을 만들지 않으며 자동 VERIFIED/EXCLUDED/ACTIVE 분류가 없다. 기존 `financial_verify_reconciled_legacy_baselines()` 이름은 호환성을 위해 남지만 이제 count만 반환하는 read-only report다.

분류 의미는 다음과 같다.

| 상태 | 의미 | Cutover 동작 |
|---|---|---|
| `NEEDS_REVIEW` | 미검토 후보 | confirm 차단 |
| `RECONCILED` | 금액 대사만 끝났고 최종 분류 전 | confirm 차단 |
| `HISTORICAL` | VERIFIED BASELINE evidence와 APPLIED Legacy reconstruction이 있고 Cutover 시점 cohort 회계잔액이 0인 과거 이력 | 과거 Ledger 이력을 보존하되 활성 wallet 연결·거래 생성 없음 |
| `EXCLUDED` | 테스트/오류/원장 비대상 등 이유를 명시한 제외 | reconstruction 없이 종료 가능, 거래 생성 없음 |
| `ACTIVE_AT_CUTOVER` | APPLIED Legacy reconstruction과 Cutover 시점 양수 회계잔액이 있는 활성 재원 | 기존 APPLIED current wallet 연결만 수행 |

`HISTORICAL`은 `EXCLUDED`와 다르다. HISTORICAL과 ACTIVE 모두 VERIFIED `BASELINE` evidence 및 `legacy_funding_entry_id`가 필수다. funding entry는 같은 region의 최초 배분연도 APPLIED ALLOCATION이어야 하고, 해당 Baseline project/year까지 필요한 carryover 전체가 APPLIED여야 하며, APPLIED reconstruction으로 materialize된 wallet 경로가 있어야 한다. HISTORICAL은 전체 funding cohort의 현재 `accounting_balance=0`을 강제하며 Baseline에 활성 wallet을 연결하지 않는다. ACTIVE는 Cutover 연도의 resolved current wallet이 존재하고 `accounting_balance>0`이어야 한다. 잔액이 0인 행은 ACTIVE가 아니라 HISTORICAL로 분류해야 한다. Baseline 누적집행은 기존 CONFIRMED execution 합계와, 조정배분액-누적집행은 resolved wallet 회계잔액과 일치해야 한다. reconstruction 없이 최종 종료할 수 있는 분류는 명확한 제외 사유가 있는 EXCLUDED뿐이다.

Cutover confirm 전 모든 후보가 `HISTORICAL/EXCLUDED/ACTIVE_AT_CUTOVER` 중 하나여야 한다. `projects.alloc`, `projects.exec` 또는 Baseline 숫자의 일치만으로 HISTORICAL/ACTIVE를 자동 확정하지 않는다.

Cutover confirm은 cohort, wallet, execution을 INSERT하지 않는다. 위 APPLIED path와 잔액을 다시 검증하고 ACTIVE에만 기존 wallet ID를 `project_financial_baselines.ledger_budget_year_id`로 연결한 뒤 Cutover 상태만 확정한다. `projects.alloc`, `projects.exec`, Baseline 숫자로 누락 거래를 합성하는 우회 경로는 없다. 과거 흐름이 불완전하면 HISTORICAL/ACTIVE 분류 또는 confirm에서 실패한다. Cutover 생성자와 confirm admin은 달라야 한다.

Baseline correction은 request/submit/approve/reject/apply RPC와 기존 `project_baseline_corrections`를 사용한다. previous/proposed JSON, 이유, 요청·승인·적용 사용자를 기록한다. 이 delta의 apply는 Cutover confirm 전 Baseline 정정에 한정한다. confirm 후 회계금액 정정은 기존 확정 행을 직접 바꾸지 않고 별도 Ledger change/reversal 요청으로 처리해야 한다.

## Cohort 집행률

확정 cohort 한 건이 denominator 한 건이다.

- denominator: `project_budget_cohorts.initial_allocation`
- numerator: 해당 cohort wallet들에 materialize된 `CONFIRMED` execution 합계(REVERSAL은 차감)
- remaining: 같은 cohort 모든 wallet의 회계 balance 합계
- rate: `numerator / denominator * 100`; denominator가 0이면 NULL

System Native와 APPLIED Legacy는 같은 산식으로 합쳐진다. `projects.exec/alloc`은 조회식에 사용하지 않는다. 아직 APPLY되지 않은 Legacy ALLOCATION은 `cohort_id=NULL`, rate/잔액 NULL, `UNRECONCILED` 상태로만 노출된다.

## 적용 전 후속 검토

1. 별도 TEST clone에서 SQL parser/static contract를 다시 통과시킨다.
2. project ref 외부 Gate를 재확인한 뒤에만 service role로 runtime을 TEST에 binding하고, Legacy 검수 시 `RECONCILIATION` mode를 사용한다.
3. 최소 2명의 서로 다른 admin test identity로 evidence/lineage/Legacy/baseline/cutover maker-checker를 검증한다.
4. 3,898개 Baseline 후보 분류 기준과 evidence 보관정책을 업무 담당자가 승인한다.
5. transaction/rollback 검증 후에만 별도 승인 절차로 TEST migration 적용을 검토한다. Production 적용·활성화는 이 문서 범위 밖이다.
