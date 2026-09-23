"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  correctBudgetChangeDestinationAction,
  createBudgetChangeRequestAction,
  getBudgetChangeSnapshotAction,
  requestPendingNewProjectLinkAction,
  saveBudgetChangeDraftAction,
  searchBudgetChangeCandidatesAction,
  searchBudgetChangeNextYearCandidatesAction,
} from '../../app/my-projects/budget-change-actions';
import { getFinancialBudgetYearsAction } from '../../app/my-projects/financial-actions';
import { getLocalFundingSnapshotAction } from '../../app/my-projects/funding-actions';
import { formatIntegerString, formatWonWithUnit } from '../../lib/amountFormat';
import { getCurrentSessionWithRetry } from '../../lib/auth';
import {
  calculateBudgetChangeGap,
  calculateBudgetDestinationMaximum,
  calculatePendingBudgetChangeAmounts,
  getBudgetDestinationAddDisabledReason,
  getNextBudgetChangeFiscalYear,
  replaceBudgetDestination,
  validateBudgetChangeMaximumDecrease,
  type BudgetChangeCandidate,
  type BudgetChangeDestination,
  type BudgetChangeDestinationInput,
  type BudgetChangeProjectPosition,
  type BudgetChangeRequest,
  type PendingNewProjectFund,
  type AttachableNewProjectDraft,
} from '../../lib/budgetChanges';
import type { FinancialBudgetYear } from '../../lib/financialLedger';
import { normalizeLedgerAmount } from '../../lib/financialLedger';
import { fundingEventLabel, type FundingHistoryItem } from '../../lib/fundingManagement';
import { isProjectStatus } from '../../lib/myProjectEdit';
import { formatBudgetChangeReasonForDisplay, formatProjectOption, formatStoredUserText, formatSystemTerm, formatUserFacingError } from '../../lib/presentationLabels';
import NewProjectRequestFields, {
  validateNewProjectRequestDraft,
  type NewProjectRequestDraft,
} from './NewProjectRequestFields';

type Props = {
  projectId: string;
  /** 이전 편집 셸과의 호환용. 금액 계산은 Ledger position의 raw 원 값을 사용한다. */
  currentDecreaseAmount?: string;
  currentProjectYear?: number;
  currentProjectName?: string;
  onFundingPositionChange?: (position: {
    project_id: string;
    ledger_original_allocation: string;
    ledger_increase_amount: string;
    ledger_decrease_amount: string;
    ledger_adjusted_allocation: string;
    ledger_execution_amount: string;
    ledger_execution_rate: number;
    current_wallet_balance: string;
    projection_ready: boolean;
  }) => void;
};

type DraftLine = BudgetChangeDestinationInput & {
  key: string;
  newProjectDraftCompleted?: boolean;
  registeredProjectCode?: string | null;
};
type NewProjectEditor = {
  lineKey: string;
  draft: NewProjectRequestDraft;
};
type BudgetDestinationCorrectionEditor = {
  request: BudgetChangeRequest;
  line: BudgetChangeDestination;
  candidates: BudgetChangeCandidate[];
  replacementProjectId: string;
  reason: string;
  effectiveDate: string;
};
type Runtime = {
  environment_kind: 'TEST';
  mode: 'DISABLED' | 'RECONCILIATION' | 'TEST';
  baseline_as_of: string;
  native_start_date: string;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function newLine(
  type: DraftLine['destination_type'] = 'EXISTING_PROJECT',
  plannedProjectYear = new Date().getFullYear() + 1,
): DraftLine {
  return {
    key: crypto.randomUUID(),
    destination_type: type,
    destination_project_id: '',
    planned_project_name: '',
    planned_project_year: plannedProjectYear,
    planned_project_start_year: plannedProjectYear,
    planned_project_end_year: plannedProjectYear,
    planned_project_status: '정상추진',
    amount: '0',
    note: '',
    newProjectDraftCompleted: false,
  };
}

function AmountInput({ label, value, maximum, onChange }: {
  label: string;
  value: string;
  maximum?: string;
  onChange: (value: string) => void;
}) {
  const exceedsMaximum = maximum != null && /^\d+$/.test(value) && BigInt(value) > BigInt(maximum);
  return <label className="financial-ledger-input">
    <span>{label}</span>
    <div>
      <input
        inputMode="numeric"
        value={formatIntegerString(value)}
        aria-invalid={exceedsMaximum}
        onChange={(event) => onChange(normalizeLedgerAmount(event.target.value))}
      />
      <span>원</span>
    </div>
    <small>화면 표시 {formatWonWithUnit(value)}{maximum != null && <> · 최대 {formatWonWithUnit(maximum)}</>}</small>
    {exceedsMaximum && <span className="financial-ledger-error" role="alert">이 목적지에는 최대 {formatWonWithUnit(maximum)}까지 배분할 수 있습니다.</span>}
  </label>;
}

function requestDestinationLabel(request: BudgetChangeRequest) {
  return request.destinations.map((line) => `${formatProjectOption({
    fiscal_year: line.destination_type === 'EXISTING_PROJECT' ? request.fiscal_year : line.planned_project_year,
    project_name: line.current_destination_project_name
      ?? (line.destination_type === 'EXISTING_PROJECT'
        ? line.destination_project_name
        : line.materialized_project_name ?? line.planned_project_name),
    project_code: line.current_destination_project_code
      ?? (line.destination_type === 'EXISTING_PROJECT'
        ? line.destination_project_code
        : line.materialized_project_code ?? line.official_project_code),
    status: line.destination_type === 'EXISTING_PROJECT' ? 'APPLIED' : line.new_project_request_status,
  })}${(line.correction_count ?? 0) > 0 ? ' (목적지 변경됨)' : ''} +${formatIntegerString(line.amount)}원`)
    .join(' / ');
}

export default function ProjectFundingManagementSection({
  projectId,
  currentProjectYear,
  currentProjectName,
  onFundingPositionChange,
}: Props) {
  const router = useRouter();
  const nextProjectYear = getNextBudgetChangeFiscalYear(currentProjectYear);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [position, setPosition] = useState<BudgetChangeProjectPosition | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [autoApprovalEnabled, setAutoApprovalEnabled] = useState(false);
  const [ledgerReady, setLedgerReady] = useState(false);
  const [wallets, setWallets] = useState<FinancialBudgetYear[]>([]);
  const [requests, setRequests] = useState<BudgetChangeRequest[]>([]);
  const [pendingFunds, setPendingFunds] = useState<PendingNewProjectFund[]>([]);
  const [legacyHistory, setLegacyHistory] = useState<FundingHistoryItem[]>([]);
  const [candidates, setCandidates] = useState<BudgetChangeCandidate[]>([]);
  const [nextYearCandidates, setNextYearCandidates] = useState<BudgetChangeCandidate[]>([]);
  const [draftNewProjectRequests, setDraftNewProjectRequests] = useState<AttachableNewProjectDraft[]>([]);
  const [search, setSearch] = useState('');
  const [candidateYear, setCandidateYear] = useState<number | null>(null);
  const [mode, setMode] = useState<'DECREASE' | 'INCREASE' | null>(null);
  const [draftRevisionId, setDraftRevisionId] = useState<string | null>(null);
  const [selectedSourceProjectId, setSelectedSourceProjectId] = useState('');
  const [totalAmount, setTotalAmount] = useState('0');
  const [lines, setLines] = useState<DraftLine[]>([newLine('EXISTING_PROJECT', nextProjectYear)]);
  const [reason, setReason] = useState('사업간 예산조정');
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [selectedRequest, setSelectedRequest] = useState<BudgetChangeRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newProjectEditor, setNewProjectEditor] = useState<NewProjectEditor | null>(null);
  const [newProjectEditorError, setNewProjectEditorError] = useState<string | null>(null);
  const [savingNewProjectDraft, setSavingNewProjectDraft] = useState(false);
  const [correctionEditor, setCorrectionEditor] = useState<BudgetDestinationCorrectionEditor | null>(null);
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const submitLockRef = useRef(false);

  const load = useCallback(async (token: string) => {
    const [snapshot, walletResult, oldSnapshot] = await Promise.all([
      getBudgetChangeSnapshotAction({ accessToken: token, projectId }),
      getFinancialBudgetYearsAction({ accessToken: token }),
      getLocalFundingSnapshotAction({ accessToken: token, projectId }),
    ]);
    if ('error' in snapshot) throw new Error(snapshot.error);
    if ('error' in walletResult) throw new Error(walletResult.error);
    if ('error' in oldSnapshot) throw new Error(oldSnapshot.error);
    setPosition(snapshot.data.position);
    setRuntime(snapshot.data.runtime);
    setAutoApprovalEnabled(snapshot.data.autoApprovalEnabled);
    setEffectiveDate((value) => value < snapshot.data.runtime.native_start_date
      ? snapshot.data.runtime.native_start_date
      : value);
    setRequests(snapshot.data.requests);
    setPendingFunds(snapshot.data.pending);
    setDraftNewProjectRequests(snapshot.data.draftNewProjectRequests);
    setLegacyHistory(oldSnapshot.data.history.filter((item) =>
      ['RETURN', 'MYEONGSI', 'SAGO', 'CARRYOVER', 'UNALLOCATED_RETURN'].includes(item.event_type)));
    const projectWallets = walletResult.data.filter((wallet) => wallet.project_id === projectId);
    const fundingPosition = oldSnapshot.data.positions.find((item) => item.project_id === projectId);
    const projectionReady = Boolean(fundingPosition?.projection_ready && projectWallets.length > 0);
    setLedgerReady(projectionReady);
    setWallets(projectWallets);
    onFundingPositionChange?.({
      project_id: snapshot.data.position.project_id,
      ledger_original_allocation: snapshot.data.position.original_allocation,
      ledger_increase_amount: snapshot.data.position.increase_amount,
      ledger_decrease_amount: snapshot.data.position.decrease_amount,
      ledger_adjusted_allocation: snapshot.data.position.adjusted_allocation,
      ledger_execution_amount: snapshot.data.position.execution_amount,
      ledger_execution_rate: snapshot.data.position.execution_rate,
      current_wallet_balance: snapshot.data.position.unexecuted_amount,
      projection_ready: projectionReady,
    });
  }, [onFundingPositionChange, projectId]);

  useEffect(() => {
    void (async () => {
      try {
        const session = await getCurrentSessionWithRetry();
        const token = session.data.session?.access_token;
        if (!token) throw new Error('로그인 세션이 만료되었습니다.');
        setAccessToken(token);
        await load(token);
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '사업변경 정보를 불러오지 못했습니다.'));
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  useEffect(() => {
    if (!accessToken) return;
    const intervalId = window.setInterval(() => {
      void load(accessToken).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [accessToken, load]);

  const searchCandidates = useCallback(async () => {
    if (!accessToken || !mode) return;
    const existingResult = await searchBudgetChangeCandidatesAction({
      accessToken,
      anchorProjectId: projectId,
      search,
      requireAvailable: mode === 'INCREASE',
    });
    const nextYearResult = mode === 'DECREASE'
      ? await searchBudgetChangeNextYearCandidatesAction({ accessToken, anchorProjectId: projectId, search })
      : { data: [] as BudgetChangeCandidate[] };
    if ('error' in existingResult || 'error' in nextYearResult) {
      setError(formatUserFacingError(
        ('error' in existingResult ? existingResult.error : nextYearResult.error),
        '사업 검색 결과를 불러오지 못했습니다.',
      ));
      return;
    }
    setCandidates(existingResult.data);
    setNextYearCandidates(nextYearResult.data);
  }, [accessToken, mode, projectId, search]);

  useEffect(() => {
    if (accessToken && mode) void searchCandidates();
  }, [accessToken, mode, searchCandidates]);

  const gap = useMemo(() => calculateBudgetChangeGap(
    totalAmount,
    mode === 'INCREASE' ? [{ amount: totalAmount }] : lines,
  ), [lines, mode, totalAmount]);
  const pendingAmounts = useMemo(
    () => calculatePendingBudgetChangeAmounts(projectId, requests),
    [projectId, requests],
  );

  const candidateYears = useMemo(
    () => [...new Set(candidates.map((candidate) => candidate.fiscal_year))].sort((a, b) => b - a),
    [candidates],
  );
  const visibleCandidates = useMemo(
    () => candidateYear === null
      ? candidates
      : candidates.filter((candidate) => candidate.fiscal_year === candidateYear),
    [candidateYear, candidates],
  );

  const changeTags = useMemo(() => requests.flatMap((request) => {
    if (request.status !== 'APPLIED') return [];
    const tags: Array<{ key: string; label: string; detail: string; request: BudgetChangeRequest }> = [];
    if (request.source_project_id === projectId) {
      tags.push({
        key: `${request.id}-out`,
        label: `사업간 예산조정 -${formatIntegerString(request.total_amount)}원`,
        detail: `${requestDestinationLabel(request)}로 이전 · ${request.effective_date}`,
        request,
      });
    }
    request.destinations.forEach((line) => {
      const currentDestinationId = line.current_destination_project_id
        ?? line.materialized_project_id
        ?? line.destination_project_id;
      if (currentDestinationId === projectId) {
        tags.push({
          key: `${request.id}-${line.line_id}-in`,
          label: `사업간 예산조정 +${formatIntegerString(line.amount)}원`,
          detail: `${formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code, status: 'APPLIED' })}에서 이전 · ${request.effective_date}`,
          request,
        });
      }
    });
    return tags;
  }), [projectId, requests]);

  const writeEnabled = runtime?.mode === 'TEST' && position?.valid_execution === true;
  const pendingLinkEnabled = runtime?.mode === 'TEST' && ledgerReady;
  const selectedSourceCandidate = mode === 'INCREASE'
    ? candidates.find((candidate) => candidate.project_id === selectedSourceProjectId) ?? null
    : null;
  const requestedAmount = /^\d+$/.test(totalAmount) ? BigInt(totalAmount) : BigInt(0);
  const availableAmount = mode === 'INCREASE'
    ? BigInt(selectedSourceCandidate?.available_amount ?? '0')
    : BigInt(position?.unexecuted_amount ?? '0');
  const maximumDecreaseError = mode === 'DECREASE'
    ? validateBudgetChangeMaximumDecrease(totalAmount, position?.unexecuted_amount ?? '0')
    : null;
  const destinationRequiredValuesReady = (line: DraftLine) => {
    const amountReady = /^\d+$/.test(line.amount) && BigInt(line.amount) > BigInt(0)
      && BigInt(line.amount) <= BigInt(calculateBudgetDestinationMaximum(totalAmount, lines, line.key));
    return amountReady && (line.destination_type === 'EXISTING_PROJECT'
      ? Boolean(line.destination_project_id)
      : Boolean(line.planned_project_name?.trim())
        && Number(line.planned_project_year) === nextProjectYear
        && (line.create_unlinked_funding === true
          || line.note?.startsWith('REGISTERED_NEXT_YEAR_PROJECT:')
          || Boolean(line.existing_new_project_request_id)
          || line.newProjectDraftCompleted === true));
  };
  const destinationsReady = mode === 'INCREASE'
    ? selectedSourceCandidate !== null
    : lines.length > 0 && lines.every(destinationRequiredValuesReady);
  const addDestinationDisabledReason = getBudgetDestinationAddDisabledReason({
    totalAmount,
    destinations: lines,
    destinationCount: lines.length,
    editable: writeEnabled && !submitting,
    hasFatalDestinationError: lines.some((line) => !destinationRequiredValuesReady(line)),
  });
  const submitEnabled = writeEnabled && requestedAmount > BigInt(0)
    && requestedAmount <= availableAmount && !maximumDecreaseError && gap.balanced && destinationsReady
    && reason.trim().length > 0;

  const resetForm = (nextMode: 'DECREASE' | 'INCREASE') => {
    setDraftRevisionId(crypto.randomUUID());
    setMode(nextMode);
    setTotalAmount('0');
    setLines([newLine('EXISTING_PROJECT', nextProjectYear)]);
    setSelectedSourceProjectId('');
    setCandidateYear(null);
    setReason(nextMode === 'DECREASE' ? '사업간 예산조정' : '출처 지정 예산 증액');
    setError(null);
    setNotice(null);
    setNewProjectEditor(null);
    setNewProjectEditorError(null);
  };

  const openNewProjectEditor = (line: DraftLine) => {
    const fiscalYear = nextProjectYear;
    setNewProjectEditor({
      lineKey: line.key,
      draft: {
        fiscalYear,
        projectName: line.planned_project_name ?? '',
        projectPeriod: line.planned_project_period ?? `${fiscalYear}.01~${fiscalYear}.12`,
        projectStartYear: line.planned_project_start_year ?? fiscalYear,
        projectEndYear: line.planned_project_end_year ?? fiscalYear,
        businessType: line.planned_business_type ?? 'HW',
        status: isProjectStatus(line.planned_project_status) ? line.planned_project_status : '정상추진',
        executionStatusReason: line.planned_execution_status_reason ?? '',
        requestedAmount: line.amount,
      },
    });
    setNewProjectEditorError(null);
  };

  const saveNewProjectEditor = async () => {
    if (!newProjectEditor) return;
    const expectedFiscalYear = nextProjectYear;
    const validation = validateNewProjectRequestDraft(newProjectEditor.draft, expectedFiscalYear);
    if (validation) {
      setNewProjectEditorError(validation);
      return;
    }
    if (newProjectEditor.draft.projectStartYear === null
        || newProjectEditor.draft.projectEndYear === null) {
      setNewProjectEditorError('신규사업의 시작연도와 종료연도를 모두 입력해 주세요.');
      return;
    }
    if (!accessToken || !draftRevisionId || mode !== 'DECREASE') {
      setNewProjectEditorError('예산조정 작성본을 다시 열어 주세요.');
      return;
    }
    const { draft, lineKey } = newProjectEditor;
    const projectStartYear = draft.projectStartYear!;
    const projectEndYear = draft.projectEndYear!;
    const completedLine = (item: DraftLine): DraftLine => ({
      ...item,
      destination_project_id: '',
      create_unlinked_funding: false,
      existing_new_project_request_id: undefined,
      planned_project_name: draft.projectName.trim(),
      planned_project_year: draft.fiscalYear,
      planned_fund_project_name: draft.projectName.trim(),
      planned_detail_project_name: draft.projectName.trim(),
      planned_project_period: draft.projectPeriod.trim(),
      planned_project_start_year: projectStartYear,
      planned_project_end_year: projectEndYear,
      planned_project_status: draft.status,
      planned_execution_status_reason: draft.executionStatusReason.trim() || undefined,
      planned_business_type: draft.businessType,
      amount: draft.requestedAmount,
      note: '',
      newProjectDraftCompleted: true,
    });
    const nextLines = lines.map((item) => item.key === lineKey ? completedLine(item) : item);
    const sourceWallet = wallets.find((wallet) => BigInt(wallet.available_to_commit) >= requestedAmount)?.budget_year_id;
    const destinations = nextLines.map(({ key: _key, newProjectDraftCompleted: _completed, registeredProjectCode: _registeredCode, ...line }) => line);
    setSavingNewProjectDraft(true);
    setNewProjectEditorError(null);
    try {
      const result = await saveBudgetChangeDraftAction({
        accessToken,
        sourceProjectId: projectId,
        sourceBudgetYearId: sourceWallet ?? null,
        totalAmount,
        destinations,
        effectiveDate,
        reason,
        idempotencyKey: draftRevisionId,
      });
      if ('error' in result) throw new Error(result.error);
      setLines(nextLines);
      setNewProjectEditor(null);
      setNotice('신규사업 임시저장을 현재 예산조정 목적지에 연결했습니다. 완료 시 두 요청이 한 번에 처리됩니다.');
      await load(accessToken);
    } catch (saveError) {
      setNewProjectEditorError(formatUserFacingError(saveError, '신규사업 임시저장을 완료하지 못했습니다.'));
    } finally {
      setSavingNewProjectDraft(false);
    }
  };

  const submit = async () => {
    if (!accessToken || submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (!writeEnabled) throw new Error('신규 운영거래 기능이 활성화된 뒤 예산 조정을 제출할 수 있습니다.');
      const sourceCandidate = mode === 'INCREASE'
        ? candidates.find((candidate) => candidate.project_id === selectedSourceProjectId)
        : null;
      const sourceWallet = mode === 'INCREASE'
        ? sourceCandidate?.source_budget_year_id
        : wallets.find((wallet) => BigInt(wallet.available_to_commit) >= requestedAmount)?.budget_year_id;
      const sourceProjectId = mode === 'INCREASE' ? sourceCandidate?.project_id : projectId;
      if (!sourceProjectId) throw new Error('증액액의 출처 사업을 선택해 주세요.');
      if (!draftRevisionId) throw new Error('예산조정 작성본을 다시 열어 주세요.');
      if (maximumDecreaseError) throw new Error(maximumDecreaseError);
      if (mode === 'DECREASE' && wallets.length > 0 && !sourceWallet) {
        throw new Error('한 재원에서 감액액을 충당할 수 없습니다. 감액액을 현재 미집행액 이하로 입력해 주세요.');
      }
      if (sourceCandidate && BigInt(sourceCandidate.available_amount) < requestedAmount) {
        throw new Error('선택한 출처 사업의 조정 가능액보다 큰 금액은 증액할 수 없습니다.');
      }
      const destinations: BudgetChangeDestinationInput[] = mode === 'INCREASE'
        ? [{ destination_type: 'EXISTING_PROJECT', destination_project_id: projectId, amount: totalAmount, note: 'INCREASE_TARGET' }]
        : lines.map(({ key: _key, newProjectDraftCompleted: _completed, registeredProjectCode: _registeredCode, ...line }) => line);
      const result = await createBudgetChangeRequestAction({
        accessToken,
        sourceProjectId,
        sourceBudgetYearId: sourceWallet ?? null,
        totalAmount,
        destinations,
        effectiveDate,
        reason,
        idempotencyKey: draftRevisionId,
      });
      if ('error' in result) throw new Error(result.error);
      setNotice(result.data.status === 'APPLIED'
        ? '출처 감액과 목적지 증액을 승인 없이 한 번만 반영했습니다.'
        : '직접 처리를 완료하지 못했습니다. 입력정보와 재원 상태를 확인한 뒤 다시 시도해 주세요.');
      setMode(null);
      setDraftRevisionId(null);
      await load(accessToken);
    } catch (submitError) {
      setError(formatUserFacingError(submitError, '예산 조정 요청을 제출하지 못했습니다.'));
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  const openDestinationCorrection = async (
    request: BudgetChangeRequest,
    line: BudgetChangeDestination,
  ) => {
    if (!accessToken || !line.correction_allowed) return;
    setCorrectionLoading(true);
    setCorrectionError(null);
    try {
      const result = line.destination_type === 'EXISTING_PROJECT'
        ? await searchBudgetChangeCandidatesAction({
          accessToken,
          anchorProjectId: request.source_project_id,
          year: request.fiscal_year,
          requireAvailable: false,
        })
        : await searchBudgetChangeNextYearCandidatesAction({
          accessToken,
          anchorProjectId: request.source_project_id,
        });
      if ('error' in result) throw new Error(result.error);
      const currentDestinationId = line.current_destination_project_id
        ?? line.materialized_project_id
        ?? line.destination_project_id
        ?? null;
      const availableCandidates = result.data.filter((candidate) =>
        candidate.project_id !== currentDestinationId
        && candidate.project_id !== request.source_project_id);
      setCorrectionEditor({
        request,
        line,
        candidates: availableCandidates,
        replacementProjectId: '',
        reason: '예산이관 목적지 변경',
        effectiveDate: today(),
      });
      setSelectedRequest(null);
    } catch (candidateError) {
      setCorrectionError(formatUserFacingError(candidateError, '변경 가능한 사업을 불러오지 못했습니다.'));
    } finally {
      setCorrectionLoading(false);
    }
  };

  const submitDestinationCorrection = async () => {
    if (!accessToken || !correctionEditor || correctionSubmitting) return;
    if (!correctionEditor.replacementProjectId) {
      setCorrectionError('새 목적지 사업을 선택해 주세요.');
      return;
    }
    if (!correctionEditor.reason.trim()) {
      setCorrectionError('변경 사유를 입력해 주세요.');
      return;
    }
    setCorrectionSubmitting(true);
    setCorrectionError(null);
    setError(null);
    setNotice(null);
    try {
      const result = await correctBudgetChangeDestinationAction({
        accessToken,
        lineId: correctionEditor.line.line_id,
        replacementProjectId: correctionEditor.replacementProjectId,
        reason: correctionEditor.reason,
        effectiveDate: correctionEditor.effectiveDate,
        idempotencyKey: crypto.randomUUID(),
      });
      if ('error' in result) throw new Error(result.error);
      setCorrectionEditor(null);
      setSelectedRequest(null);
      setNotice('기존 목적지 이관을 취소하고 새 목적지로 예산을 다시 이관했습니다. 두 거래는 정정 이력으로 함께 보존됩니다.');
      await load(accessToken);
    } catch (correctionSubmitError) {
      setCorrectionError(formatUserFacingError(
        correctionSubmitError,
        '예산이관 목적지를 변경하지 못했습니다.',
      ));
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  const linkPending = async (pending: PendingNewProjectFund) => {
    if (!accessToken) return;
    if (!pendingLinkEnabled) {
      setError('재정원장 기준잔액과 출처 재원이 준비된 뒤 예정재원을 연결할 수 있습니다.');
      return;
    }
    setLinkingId(pending.id);
    setError(null);
    setNotice(null);
    try {
      const result = await requestPendingNewProjectLinkAction({
        accessToken,
        pendingFundId: pending.id,
        destinationProjectId: projectId,
        idempotencyKey: crypto.randomUUID(),
      });
      if ('error' in result) throw new Error(result.error);
      setNotice(result.data.status === 'APPLIED'
        ? '신규사업 예정재원을 승인 없이 이 사업 예산에 한 번만 반영했습니다.'
        : '예정재원 직접 연결을 완료하지 못했습니다. 재원과 사업연도를 확인해 주세요.');
      await load(accessToken);
    } catch (linkError) {
      setError(formatUserFacingError(linkError, '예정재원 연결을 요청하지 못했습니다.'));
    } finally {
      setLinkingId(null);
    }
  };

  const createProjectForPending = (pending: PendingNewProjectFund) => {
    const params = new URLSearchParams({
      newProject: '1',
      sourceLotId: pending.source_lot_id,
      year: String(pending.planned_project_year),
      name: pending.planned_project_name,
      amount: pending.amount,
    });
    if (pending.new_project_request_id) params.set('requestId', pending.new_project_request_id);
    router.push(`/my-projects?${params.toString()}#new-project-request`);
  };

  if (loading) return <section className="my-project-section"><p className="financial-ledger-status">예산 조정 정보를 불러오는 중입니다...</p></section>;

  return <div className="funding-management-section" aria-labelledby="funding-management-title">
    <div className="admin-project-review-heading budget-change-integrated-heading">
      <div>
        <h3 id="funding-management-title">사업변경</h3>
        <p className="panel-sub">감액은 받을 사업을, 증액은 돈을 가져올 출처 사업을 반드시 연결합니다. 같은 지역·같은 사업연도의 기존사업과 차년도 신규사업만 선택할 수 있습니다.</p>
      </div>
    </div>

    {position && !position.valid_execution && <div className="error-message" role="alert">집행액이 조정 후 배분액을 초과했습니다. 추가 예산 조정 전에 금액을 확인해 주세요.</div>}
    {runtime?.mode !== 'TEST' && <div className="financial-ledger-notice">현재는 과거자료 검수 단계입니다. 기존 이력은 조회할 수 있으며, 신규 운영거래 기능이 활성화된 뒤 예산 조정을 제출할 수 있습니다.</div>}
    {runtime?.mode === 'TEST' && autoApprovalEnabled && <div className="financial-ledger-notice budget-change-auto-approval-notice" role="status">
      <strong>승인 없는 직접 처리 적용 중</strong>
      <span>신규·기존사업 예산연결과 필요한 신규사업 등록은 필수 검증 후 제출 트랜잭션에서 함께 완료됩니다.</span>
    </div>}
    {runtime?.mode === 'TEST' && !ledgerReady && <div className="financial-ledger-notice" role="status">
      <strong>기준재원 자동 연결 준비</strong>
      <span>현재 사업의 배분액·집행액은 그대로 유지됩니다. 증액·감액 요청을 제출하면 이 거래에 필요한 기준재원만 내부적으로 자동 연결됩니다.</span>
    </div>}

    {position && <div className="funding-kpi-grid" aria-label="공식금액과 임시저장금액">
      <article><span>확정 증액액</span><strong>{formatWonWithUnit(position.increase_amount)}</strong><small>적용완료 금액</small></article>
      <article><span>확정 감액액</span><strong>{formatWonWithUnit(position.decrease_amount)}</strong><small>적용완료 금액</small></article>
      <article><span>미완료 증액액</span><strong>{formatWonWithUnit(pendingAmounts.requestedIncrease)}</strong><small>임시저장·처리 재시도, 공식금액 미반영</small></article>
      <article><span>미완료 감액액</span><strong>{formatWonWithUnit(pendingAmounts.requestedDecrease)}</strong><small>임시저장·처리 재시도, 공식금액 미반영</small></article>
    </div>}

    <div className="analytics-actions budget-change-actions">
      <button type="button" className="my-project-save-button" onClick={() => resetForm('DECREASE')} disabled={!writeEnabled}>감액액 입력 및 배분</button>
      <button type="button" className="my-project-save-button" onClick={() => resetForm('INCREASE')} disabled={!writeEnabled}>증액액 입력 및 출처 선택</button>
      <button type="button" className="small-btn" onClick={() => document.getElementById(`budget-change-history-${projectId}`)?.scrollIntoView({ behavior: 'smooth' })}>사업변경 내역 보기</button>
    </div>

    {changeTags.length > 0 && <div className="budget-change-tag-list" aria-label="적용된 사업간 예산조정">
      {changeTags.map((tag) => <button type="button" className="budget-change-tag" key={tag.key} onClick={() => setSelectedRequest(tag.request)}><strong>{tag.label}</strong><span>{tag.detail}</span></button>)}
    </div>}

    {mode && <div className="financial-ledger-form budget-change-form">
      <div className="admin-project-review-heading">
        <div>
          <h3>{mode === 'DECREASE' ? '감액 재원 배분' : '증액 재원 출처 선택'}</h3>
          <p className="panel-sub">{mode === 'DECREASE'
            ? `감액되는 ${formatWonWithUnit(totalAmount)}을 받을 기존사업 또는 신규사업을 선택해 주세요.`
            : `증액되는 ${formatWonWithUnit(totalAmount)}의 출처 사업을 선택해 주세요.`}</p>
        </div>
        <button type="button" className="small-btn" onClick={() => setMode(null)}>닫기</button>
      </div>

      <AmountInput label={mode === 'DECREASE' ? '요청 감액액' : '요청 증액액'} value={totalAmount} onChange={setTotalAmount} />
      {mode === 'DECREASE' ? <>
        <div className="financial-ledger-notice" role="status">
          <strong>현재 미집행액: {formatWonWithUnit(position?.unexecuted_amount ?? '0')}</strong>
          <span>출처: {currentProjectYear}년 · {currentProjectName ?? '현재 사업'} · 최대 감액 가능액은 현재 미집행액과 동일합니다.</span>
        </div>
        {maximumDecreaseError && <div className="error-message" role="alert">{maximumDecreaseError}</div>}
      </> : <p className="panel-sub">선택한 출처 사업은 같은 지자체·같은 사업연도 사업으로 제한됩니다.</p>}
      <label className="financial-ledger-input"><span>적용일</span><input type="date" min={runtime?.native_start_date} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>
      <label className="financial-ledger-input"><span>조정 사유</span><textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></label>

      <div className="budget-change-search-row">
        <label><span>사업명 검색</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="부분일치 검색" /></label>
        <label><span>사업연도</span><select value={candidateYear ?? ''} onChange={(event) => setCandidateYear(event.target.value ? Number(event.target.value) : null)}><option value="">당해연도</option>{candidateYears.map((year) => <option key={year} value={year}>{year}년</option>)}</select></label>
        <button type="button" className="small-btn" onClick={() => void searchCandidates()}>검색</button>
      </div>

      {mode === 'INCREASE' && <label className="financial-ledger-input"><span>출처 사업</span><select value={selectedSourceProjectId} onChange={(event) => setSelectedSourceProjectId(event.target.value)}><option value="">출처 사업을 선택해 주세요</option>{visibleCandidates.map((candidate) => <option key={candidate.project_id} value={candidate.project_id}>{formatProjectOption(candidate)} · 조정 가능 {formatWonWithUnit(candidate.available_amount)}</option>)}</select></label>}

      {mode === 'DECREASE' && <div className="budget-change-destination-list">
        {lines.map((line, index) => {
          const maximum = calculateBudgetDestinationMaximum(totalAmount, lines, line.key);
          return <article className="budget-change-destination-card" key={line.key}>
          <div className="admin-project-review-heading"><h4>목적지 {index + 1}</h4><button type="button" className="small-btn" onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} disabled={lines.length === 1}>삭제</button></div>
          <label className="financial-ledger-input"><span>배분 유형</span><select value={line.destination_type} onChange={(event) => {
            const replacement = { ...newLine(event.target.value as DraftLine['destination_type'], nextProjectYear), key: line.key };
            setLines((current) => replaceBudgetDestination(current, line.key, replacement));
          }}><option value="EXISTING_PROJECT">당해연도 기존사업</option><option value="PENDING_NEW_PROJECT">차년도 신규사업</option></select></label>
          {line.destination_type === 'EXISTING_PROJECT' ? <>
            <label className="financial-ledger-input"><span>배분할 사업</span><select value={line.destination_project_id} onChange={(event) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, destination_project_id: event.target.value } : item))}><option value="">사업을 선택해 주세요</option>{visibleCandidates.map((candidate) => <option key={candidate.project_id} value={candidate.project_id}>{formatProjectOption(candidate)}</option>)}</select></label>
            <AmountInput label="배분액" value={line.amount} maximum={maximum} onChange={(value) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, amount: value } : item))} />
          </> : <>
            <label className="financial-ledger-input"><span>신규사업 연결 방식</span><select value={line.create_unlinked_funding ? 'FUNDING_ONLY' : 'CREATE_NOW'} onChange={(event) => {
              const fundingOnly = event.target.value === 'FUNDING_ONLY';
              const replacement: DraftLine = {
                ...newLine('PENDING_NEW_PROJECT', nextProjectYear),
                key: line.key,
                create_unlinked_funding: fundingOnly,
              };
              setLines((current) => replaceBudgetDestination(current, line.key, replacement));
            }}><option value="CREATE_NOW">기존에 신청·생성한 신규사업 연결</option><option value="FUNDING_ONLY">예정재원 먼저 확보(사업은 나중에 작성)</option></select></label>
            {line.create_unlinked_funding ? <>
              <label className="financial-ledger-input"><span>예정 신규사업명</span><input value={line.planned_project_name ?? ''} maxLength={200} onChange={(event) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, planned_project_name: event.target.value } : item))} placeholder="차년도에 작성할 신규사업명" /></label>
              <label className="financial-ledger-input"><span>예정 사업연도</span><input value={`${line.planned_project_year}년`} readOnly /></label>
              <AmountInput label="확보할 예정예산" value={line.amount} maximum={maximum} onChange={(value) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, amount: value } : item))} />
              <div className="financial-ledger-notice" role="status"><strong>예정재원과 최소정보 신규사업 초안을 함께 확보합니다.</strong><span>출처 {currentProjectYear}년 · {currentProjectName ?? '현재 사업'} → 대상 {line.planned_project_year}년 · 임시저장 후 필수정보를 채워 완료하면 사업 등록과 예산연결이 승인 없이 함께 처리됩니다.</span></div>
            </> : <>
              <label className="financial-ledger-input"><span>기존에 작성한 신규사업 초안</span><select value={line.existing_new_project_request_id ?? ''} onChange={(event) => {
                const selected = draftNewProjectRequests.find((draft) => draft.id === event.target.value);
                setLines((current) => current.map((item) => item.key === line.key ? selected ? {
                  ...item,
                  create_unlinked_funding: false,
                  existing_new_project_request_id: selected.id,
                  note: '',
                  planned_project_name: selected.project_name,
                  planned_project_year: selected.fiscal_year,
                  planned_fund_project_name: selected.fund_project_name ?? undefined,
                  planned_detail_project_name: selected.detail_project_name ?? selected.project_name,
                  planned_project_period: selected.project_period ?? undefined,
                  planned_project_start_year: selected.project_start_year ?? selected.fiscal_year,
                  planned_project_end_year: selected.project_end_year ?? selected.fiscal_year,
                  planned_project_status: selected.project_status ?? '정상추진',
                  planned_execution_status_reason: selected.execution_status_reason ?? undefined,
                  planned_business_type: selected.business_type ?? 'HW',
                  planned_large_category_id: selected.large_category_id ?? undefined,
                  planned_middle_category_id: selected.middle_category_id ?? undefined,
                  amount: selected.requested_amount,
                  registeredProjectCode: null,
                  newProjectDraftCompleted: true,
                } : {
                  ...newLine('PENDING_NEW_PROJECT', nextProjectYear),
                  key: item.key,
                } : item));
              }}><option value="">독립 초안을 선택해 주세요</option>{draftNewProjectRequests.map((draft) => <option key={draft.id} value={draft.id}>{formatProjectOption({ fiscal_year: draft.fiscal_year, project_name: draft.project_name, status: draft.status })} · 현재 요청액 {formatIntegerString(draft.requested_amount)}원</option>)}</select></label>
              {draftNewProjectRequests.length === 0 && <small>같은 지자체·다음연도의 재원 미연결 초안이 없습니다.</small>}
              <label className="financial-ledger-input"><span>이미 등록된 차년도 사업</span><select value={line.note?.startsWith('REGISTERED_NEXT_YEAR_PROJECT:') ? line.note.slice('REGISTERED_NEXT_YEAR_PROJECT:'.length) : ''} onChange={(event) => {
                const selected = nextYearCandidates.find((candidate) => candidate.project_id === event.target.value);
                setLines((current) => current.map((item) => item.key === line.key ? {
                  ...item,
                  create_unlinked_funding: false,
                  existing_new_project_request_id: undefined,
                  note: selected ? `REGISTERED_NEXT_YEAR_PROJECT:${selected.project_id}` : '',
                  planned_project_name: selected?.project_name ?? '',
                  planned_project_year: nextProjectYear,
                  registeredProjectCode: selected?.project_code ?? null,
                  newProjectDraftCompleted: false,
                } : item));
              }}><option value="">차년도 등록사업을 선택해 주세요</option>{nextYearCandidates.map((candidate) => <option key={candidate.project_id} value={candidate.project_id}>{formatProjectOption(candidate)}</option>)}</select></label>
              {line.existing_new_project_request_id
                ? <div className="financial-ledger-notice" role="status"><strong>{formatProjectOption({ fiscal_year: line.planned_project_year, project_name: line.planned_project_name, status: 'DRAFT' })}</strong><span>기존 재원 미연결 초안을 이 예산조정에 연결합니다. 완료 시 신규사업 등록과 예산연결이 한 트랜잭션에서 처리됩니다.</span></div>
                : line.note?.startsWith('REGISTERED_NEXT_YEAR_PROJECT:')
                ? <div className="financial-ledger-notice" role="status"><strong>{formatProjectOption({ fiscal_year: line.planned_project_year, project_name: line.planned_project_name, project_code: line.registeredProjectCode, status: 'APPLIED' })}</strong><span>이미 등록된 차년도 사업을 목적지로 연결합니다.</span></div>
                : line.newProjectDraftCompleted
                  ? <div className="financial-ledger-notice" role="status"><strong>{formatProjectOption({ fiscal_year: line.planned_project_year, project_name: line.planned_project_name, status: 'DRAFT' })}</strong><span>신규사업 임시저장 연결 완료 · 배분액 {formatWonWithUnit(line.amount)} · 완료 시 같은 트랜잭션에서 함께 직접 처리됩니다.</span><button type="button" className="small-btn" onClick={() => openNewProjectEditor(line)}>신규사업 임시저장 수정</button></div>
                  : <div className="financial-ledger-notice"><strong>등록된 사업이 없나요?</strong><span>기존 신규사업 생성 입력 양식에서 필요한 정보를 작성하면 현재 목적지에 그대로 연결됩니다.</span><button type="button" className="my-project-save-button" onClick={() => openNewProjectEditor(line)}>신규사업 생성</button></div>}
              {(Boolean(line.existing_new_project_request_id) || line.note?.startsWith('REGISTERED_NEXT_YEAR_PROJECT:')) && <AmountInput label="배분액" value={line.amount} maximum={maximum} onChange={(value) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, amount: value } : item))} />}
            </>}
          </>}
        </article>})}
        <div className="analytics-actions"><button type="button" className="small-btn" onClick={() => setLines((current) => [...current, newLine('EXISTING_PROJECT', nextProjectYear)])} disabled={addDestinationDisabledReason !== null}>기존사업 목적지 추가</button><button type="button" className="small-btn" onClick={() => setLines((current) => [...current, newLine('PENDING_NEW_PROJECT', nextProjectYear)])} disabled={addDestinationDisabledReason !== null}>차년도 신규사업 추가</button></div>
        {addDestinationDisabledReason && <p className="panel-sub" role="status">{addDestinationDisabledReason}</p>}
      </div>}

      <div className={`budget-change-gap ${gap.balanced ? 'balanced' : 'unbalanced'}`}>
        <span>감액 요청액 {formatWonWithUnit(gap.total)}</span>
        <span>목적지 배분 합계 {formatWonWithUnit(gap.allocated)}</span>
        <strong>아직 배분할 금액 {formatWonWithUnit(gap.gap)}</strong>
      </div>
      {mode === 'DECREASE' && BigInt(gap.gap) > BigInt(0) && <div className="error-message" role="alert">{formatWonWithUnit(gap.gap)}을 추가 배분해야 반영할 수 있습니다. 기존사업 또는 차년도 신규사업을 추가해 주세요.</div>}
      {mode === 'DECREASE' && BigInt(gap.gap) < BigInt(0) && <div className="error-message" role="alert">목적지 배분 합계가 감액 요청액보다 {formatWonWithUnit((-BigInt(gap.gap)).toString())} 많습니다. 배분액을 조정해 주세요.</div>}
      {mode === 'DECREASE' && gap.balanced && <div className="success-message" role="status">감액 요청액 전액을 배분했습니다.</div>}
      <button type="button" className="my-project-save-button" onClick={() => void submit()} disabled={submitting || !submitEnabled} aria-busy={submitting}>{submitting ? '반영 중...' : mode === 'DECREASE' ? '감액 및 배분 완료' : '출처 감액 및 증액 완료'}</button>
    </div>}

    {newProjectEditor && <div className="similar-project-dialog-backdrop" role="presentation" onClick={() => setNewProjectEditor(null)}>
      <section className="similar-project-dialog budget-change-detail-dialog" role="dialog" aria-modal="true" aria-label="차년도 신규사업 생성" onClick={(event) => event.stopPropagation()}>
        <div className="admin-project-review-heading"><div><h3>차년도 신규사업 생성</h3><p>기존 신규사업 생성 입력 양식과 같은 항목을 사용합니다. 작성 완료 후 현재 예산조정으로 돌아갑니다.</p></div><button type="button" className="small-btn" onClick={() => setNewProjectEditor(null)}>닫기</button></div>
        <div className="financial-ledger-form">
          <NewProjectRequestFields
            idPrefix={`budget-new-project-${newProjectEditor.lineKey}`}
            value={newProjectEditor.draft}
            onChange={(draft) => setNewProjectEditor((current) => current ? { ...current, draft } : current)}
            fiscalYearReadOnly
            amountLabel="배분액"
          />
        </div>
        <div className="financial-ledger-notice"><strong>연결 예정 예산 · {formatWonWithUnit(newProjectEditor.draft.requestedAmount)}</strong><span>출처 {currentProjectYear}년 · {currentProjectName ?? '현재 사업'} → 대상 {newProjectEditor.draft.fiscalYear}년 · 임시저장만으로는 반영되지 않으며 완료 시 신규사업 등록과 예산연결이 함께 처리됩니다.</span></div>
        {newProjectEditorError && <div className="error-message" role="alert">{newProjectEditorError}</div>}
        <div className="funding-inline-actions"><button type="button" className="small-btn" onClick={() => setNewProjectEditor(null)} disabled={savingNewProjectDraft}>취소</button><button type="button" className="my-project-save-button" onClick={() => void saveNewProjectEditor()} disabled={savingNewProjectDraft}>{savingNewProjectDraft ? '임시저장 중...' : '신규사업 임시저장 및 목적지 연결'}</button></div>
      </section>
    </div>}

    {error && <div className="error-message" role="alert">{error}</div>}
    {notice && <div className="success-message" role="status">{notice}</div>}

    <div className="funding-history-block" id={`budget-change-history-${projectId}`}>
      <h3 className="funding-subheading">사업변경 내역</h3>
      {requests.length === 0 ? <div className="financial-ledger-empty">예산 조정 내역이 없습니다.</div> : <div className="budget-change-history-list">
        {requests.map((request) => <button type="button" className="budget-change-history-item" key={request.id} onClick={() => setSelectedRequest(request)}>
          <span>{request.effective_date}</span>
          <strong>{formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code, status: 'APPLIED' })} → {requestDestinationLabel(request)}</strong>
          <span>{formatWonWithUnit(request.total_amount)} · 사업간 예산조정 · {formatSystemTerm(request.status)}</span>
        </button>)}
      </div>}
    </div>

    {pendingFunds.length > 0 && <div className="funding-history-block">
      <h3 className="funding-subheading">미연결 신규사업 예정재원</h3>
      <div className="budget-change-pending-grid">{pendingFunds.map((pending) => <article key={pending.id}>
        <span>{pending.planned_project_year} · 신규사업 예정</span>
        <strong>{formatProjectOption({ fiscal_year: pending.planned_project_year, project_name: pending.linked_project_name ?? pending.planned_project_name, project_code: pending.linked_project_code, status: pending.status === 'WAITING' ? 'SUBMITTED' : 'APPLIED' })}</strong>
        <b>{formatWonWithUnit(pending.amount)}</b>
        <small>출처: {formatProjectOption({ fiscal_year: pending.fiscal_year, project_name: pending.source_project_name, project_code: pending.source_project_code, status: 'APPLIED' })}</small>
        <button type="button" className="my-project-save-button" disabled={!pending.source_lot_id} onClick={() => createProjectForPending(pending)}>신규사업 생성 및 연결</button>
        {Number(currentProjectYear) === Number(pending.planned_project_year)
          ? <button type="button" className="small-btn" disabled={!pendingLinkEnabled || linkingId !== null} onClick={() => void linkPending(pending)}>{linkingId === pending.id ? '요청 중...' : '이 사업에 연결'}</button>
          : <small>예정연도가 같은 사업에서 연결할 수 있습니다.</small>}
      </article>)}</div>
    </div>}

    {legacyHistory.length > 0 && <details className="funding-history-block legacy-funding-history">
      <summary>과거 재원변동 이력</summary>
      <p className="panel-sub">기존 반환·이월 기록은 감사 목적으로만 보존되며 새 거래를 만들 수 없습니다.</p>
      <div className="table-scroll"><table className="funding-history-table"><thead><tr><th>일자</th><th>구분</th><th className="num">금액(원)</th><th>상태</th></tr></thead><tbody>{legacyHistory.map((item) => <tr key={`${item.event_type}-${item.event_id}`}><td>{item.effective_date ?? item.created_at.slice(0, 10)}</td><td>{fundingEventLabel(item.event_type)}</td><td className="num">{formatWonWithUnit(item.amount)}</td><td>과거자료 · 읽기 전용</td></tr>)}</tbody></table></div>
    </details>}

    {selectedRequest && <div className="similar-project-dialog-backdrop" role="presentation" onClick={() => setSelectedRequest(null)}>
      <section className="similar-project-dialog budget-change-detail-dialog" role="dialog" aria-modal="true" aria-label="예산 조정 상세" onClick={(event) => event.stopPropagation()}>
        <div className="admin-project-review-heading"><div><h3>예산 조정 상세</h3><p>{selectedRequest.effective_date} · {formatSystemTerm(selectedRequest.status)}</p></div><button type="button" className="small-btn" onClick={() => setSelectedRequest(null)}>닫기</button></div>
        <dl><div><dt>출처 사업</dt><dd>{formatProjectOption({ fiscal_year: selectedRequest.fiscal_year, project_name: selectedRequest.source_project_name, project_code: selectedRequest.source_project_code, status: 'APPLIED' })}</dd></div><div><dt>감액액</dt><dd>{formatWonWithUnit(selectedRequest.total_amount)}</dd></div><div><dt>조정 사유</dt><dd>{formatBudgetChangeReasonForDisplay(selectedRequest)}</dd></div></dl>
        <h4>목적지</h4>
        <ul className="budget-change-correctable-destinations">{selectedRequest.destinations.map((line) => {
          const currentName = line.current_destination_project_name
            ?? (line.destination_type === 'EXISTING_PROJECT'
              ? line.destination_project_name
              : line.materialized_project_name ?? line.planned_project_name);
          const currentCode = line.current_destination_project_code
            ?? (line.destination_type === 'EXISTING_PROJECT'
              ? line.destination_project_code
              : line.materialized_project_code ?? line.official_project_code);
          const currentId = line.current_destination_project_id
            ?? line.materialized_project_id
            ?? line.destination_project_id;
          return <li key={line.line_id}>
            <div>
              <strong>{formatProjectOption({
                fiscal_year: line.destination_type === 'EXISTING_PROJECT'
                  ? selectedRequest.fiscal_year
                  : line.planned_project_year,
                project_name: currentName,
                project_code: currentCode,
                status: line.destination_type === 'EXISTING_PROJECT'
                  ? 'APPLIED'
                  : line.new_project_request_status,
              })}</strong>
              <span>{line.destination_type === 'PENDING_NEW_PROJECT'
                ? line.note?.startsWith('REGISTERED_NEXT_YEAR_PROJECT:')
                  ? '등록된 신규사업'
                  : '신규사업 예정'
                : '기존사업'} · {formatWonWithUnit(line.amount)}</span>
              {(line.correction_count ?? 0) > 0 && <small>목적지 변경 {line.correction_count}회 · 최근 사유: {formatStoredUserText(line.last_correction_reason, '사유 미입력')}</small>}
              {!line.correction_allowed && selectedRequest.status === 'APPLIED' && currentId && <small className="financial-ledger-error">{line.correction_block_reason}</small>}
            </div>
            {selectedRequest.status === 'APPLIED' && currentId && <button
              type="button"
              className="small-btn"
              disabled={!line.correction_allowed || correctionLoading}
              title={line.correction_block_reason ?? '기존 이관을 취소하고 새 사업으로 다시 이관합니다.'}
              onClick={() => void openDestinationCorrection(selectedRequest, line)}
            >{correctionLoading ? '확인 중...' : '목적지 변경'}</button>}
          </li>;
        })}</ul>
        {correctionError && <div className="error-message" role="alert">{correctionError}</div>}
        <strong>차액 0원</strong>
      </section>
    </div>}

    {correctionEditor && <div className="similar-project-dialog-backdrop" role="presentation" onClick={() => setCorrectionEditor(null)}>
      <section className="similar-project-dialog budget-change-detail-dialog budget-change-correction-dialog" role="dialog" aria-modal="true" aria-label="예산이관 목적지 변경" onClick={(event) => event.stopPropagation()}>
        <div className="admin-project-review-heading">
          <div><h3>예산이관 목적지 변경</h3><p>기존 이관은 취소 원장으로 남기고 새 목적지에 같은 금액을 다시 이관합니다.</p></div>
          <button type="button" className="small-btn" onClick={() => setCorrectionEditor(null)} disabled={correctionSubmitting}>닫기</button>
        </div>
        <div className="financial-ledger-notice" role="status">
          <strong>변경 금액 · {formatWonWithUnit(correctionEditor.line.amount)}</strong>
          <span>현재 목적지: {formatProjectOption({
            fiscal_year: correctionEditor.line.destination_type === 'EXISTING_PROJECT'
              ? correctionEditor.request.fiscal_year
              : correctionEditor.line.planned_project_year,
            project_name: correctionEditor.line.current_destination_project_name,
            project_code: correctionEditor.line.current_destination_project_code,
            status: 'APPLIED',
          })}</span>
        </div>
        <div className="financial-ledger-form">
          <label className="financial-ledger-input"><span>새 목적지 사업</span><select value={correctionEditor.replacementProjectId} onChange={(event) => setCorrectionEditor((current) => current ? { ...current, replacementProjectId: event.target.value } : current)}>
            <option value="">사업을 선택해 주세요</option>
            {correctionEditor.candidates.map((candidate) => <option key={candidate.project_id} value={candidate.project_id}>{formatProjectOption(candidate)}</option>)}
          </select></label>
          {correctionEditor.candidates.length === 0 && <small className="financial-ledger-error">같은 지자체·사업연도의 다른 등록 사업이 없습니다.</small>}
          <label className="financial-ledger-input"><span>변경일</span><input type="date" min={runtime?.native_start_date} value={correctionEditor.effectiveDate} onChange={(event) => setCorrectionEditor((current) => current ? { ...current, effectiveDate: event.target.value } : current)} /></label>
          <label className="financial-ledger-input"><span>변경 사유</span><textarea maxLength={1000} value={correctionEditor.reason} onChange={(event) => setCorrectionEditor((current) => current ? { ...current, reason: event.target.value } : current)} /></label>
        </div>
        <div className="financial-ledger-notice budget-change-correction-warning">
          <strong>변경 전 확인</strong>
          <span>현재 목적지에서 이관액을 이미 집행하거나 다른 곳으로 사용했다면 원장 보호를 위해 변경되지 않습니다.</span>
        </div>
        {correctionError && <div className="error-message" role="alert">{correctionError}</div>}
        <div className="funding-inline-actions">
          <button type="button" className="small-btn" onClick={() => setCorrectionEditor(null)} disabled={correctionSubmitting}>취소</button>
          <button type="button" className="my-project-save-button" onClick={() => void submitDestinationCorrection()} disabled={correctionSubmitting || !correctionEditor.replacementProjectId || correctionEditor.candidates.length === 0}>{correctionSubmitting ? '변경 중...' : '기존 이관 취소 후 새 목적지로 변경'}</button>
        </div>
      </section>
    </div>}
  </div>;
}
