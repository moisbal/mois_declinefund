"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { getLocalFundingSnapshotAction, saveNewProjectRequestAction } from '../../app/my-projects/funding-actions';
import {
  getNewProjectDeletionEligibilityAction,
  type NewProjectDeletionResult,
} from '../../app/my-projects/workspace-actions';
import { formatIntegerString, formatWonWithUnit } from '../../lib/amountFormat';
import { getCurrentSessionWithRetry, type UserProfile } from '../../lib/auth';
import { normalizeLedgerAmount } from '../../lib/financialLedger';
import { fundingRuntimeLabel, type NewProjectFundingSource, type NewProjectRequest } from '../../lib/fundingManagement';
import { formatProjectOption, formatStoredUserText, formatSystemTerm, formatUserFacingError, getProjectPresentation } from '../../lib/presentationLabels';
import NewProjectRequestFields, {
  getNewProjectSubmissionRequirements,
  validateNewProjectRequestDraft,
  type NewProjectRequestDraft,
} from './NewProjectRequestFields';
import NewProjectDeleteDialog from './NewProjectDeleteDialog';

type Props = {
  profile: UserProfile;
  onDeleted?: (result: NewProjectDeletionResult) => void | Promise<void>;
  onRequestUnavailable?: (message: string) => void;
};

export default function NewProjectRequestPanel({ profile, onDeleted, onRequestUnavailable }: Props) {
  const currentYear = new Date().getFullYear();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [fundingSources, setFundingSources] = useState<NewProjectFundingSource[]>([]);
  const [requests, setRequests] = useState<NewProjectRequest[]>([]);
  const [sourceLotId, setSourceLotId] = useState('');
  const [requestId, setRequestId] = useState<string | undefined>();
  const [fiscalYear, setFiscalYear] = useState(currentYear);
  const [projectName, setProjectName] = useState('');
  const [projectPeriod, setProjectPeriod] = useState('');
  const [projectStartYear, setProjectStartYear] = useState<number | null>(currentYear);
  const [projectEndYear, setProjectEndYear] = useState<number | null>(currentYear);
  const [businessType, setBusinessType] = useState<'HW' | 'SW' | 'COMPOSITE'>('HW');
  const [status, setStatus] = useState<NewProjectRequestDraft['status']>('정상추진');
  const [executionStatusReason, setExecutionStatusReason] = useState('');
  const [requestedAmount, setRequestedAmount] = useState('0');
  const [linkedPendingFlow, setLinkedPendingFlow] = useState(false);
  const [runtimeLabel, setRuntimeLabel] = useState('운영 상태 확인 중');
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState<'draft' | 'submit' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string; year: number } | null>(null);
  const requestKey = useRef<string | null>(null);
  const onRequestUnavailableRef = useRef(onRequestUnavailable);

  useEffect(() => {
    onRequestUnavailableRef.current = onRequestUnavailable;
  }, [onRequestUnavailable]);

  const selectedSource = useMemo(
    () => fundingSources.find((source) => source.source_lot_id === sourceLotId) ?? null,
    [fundingSources, sourceLotId],
  );
  const projectDraft: NewProjectRequestDraft = {
    fiscalYear,
    projectName,
    projectPeriod,
    projectStartYear,
    projectEndYear,
    businessType,
    status,
    executionStatusReason,
    requestedAmount,
  };
  const submissionRequirements = getNewProjectSubmissionRequirements(projectDraft, Boolean(sourceLotId));
  const updateProjectDraft = (draft: NewProjectRequestDraft) => {
    setFiscalYear(draft.fiscalYear);
    setProjectName(draft.projectName);
    setProjectPeriod(draft.projectPeriod);
    setProjectStartYear(draft.projectStartYear);
    setProjectEndYear(draft.projectEndYear);
    setBusinessType(draft.businessType);
    setStatus(draft.status);
    setExecutionStatusReason(draft.executionStatusReason);
    setRequestedAmount(draft.requestedAmount);
  };

  const load = async (token: string, editingRequestId?: string) => {
    const result = await getLocalFundingSnapshotAction({
      accessToken: token,
      newProjectRequestId: editingRequestId,
    });
    if ('error' in result) throw new Error(result.error);
    const availableSources = result.data.newProjectFundingSources.filter(
      (source) => BigInt(source.remaining_amount) >= BigInt(source.amount),
    );
    setFundingSources(availableSources);
    setRequests(result.data.newProjectRequests);
    setRuntimeLabel(fundingRuntimeLabel(result.data.runtime));
    setSourceLotId((current) => availableSources.some((source) => source.source_lot_id === current) ? current : '');
    return { availableSources, requests: result.data.newProjectRequests };
  };

  useEffect(() => {
    void getCurrentSessionWithRetry().then(async (session) => {
      const token = session.data.session?.access_token;
      if (!token) return;
      setAccessToken(token);
      try {
        const params = new URLSearchParams(window.location.search);
        const linkedRequestId = params.get('requestId') ?? undefined;
        if (params.get('newProject') === '1') {
          const requestedYear = params.get('year');
          const year = requestedYear ? Number(requestedYear) : currentYear;
          setOpen(true);
          setLinkedPendingFlow(Boolean(params.get('sourceLotId')));
          setRequestId(linkedRequestId);
          setSourceLotId(params.get('sourceLotId') ?? '');
          setFiscalYear(year);
          setProjectName(params.get('name') ?? '');
          setProjectPeriod(`${year}.01~${year}.12`);
          setProjectStartYear(year);
          setProjectEndYear(year);
          setRequestedAmount(normalizeLedgerAmount(params.get('amount') ?? '0'));
        }
        const snapshot = await load(token, linkedRequestId);
        const linkedRequest = linkedRequestId
          ? snapshot.requests.find((request) => request.id === linkedRequestId)
          : undefined;
        if (linkedRequestId && !linkedRequest) {
          const eligibility = await getNewProjectDeletionEligibilityAction({
            accessToken: token,
            targetKind: 'DRAFT',
            targetId: linkedRequestId,
          });
          const message = 'error' in eligibility
            ? eligibility.error ?? '요청한 신규사업 초안에 접근할 수 없습니다.'
            : eligibility.data.reason ?? '요청한 신규사업 초안을 찾을 수 없습니다.';
          setRequestId(undefined);
          setDeleteTarget(null);
          setOpen(false);
          setError(message);
          onRequestUnavailableRef.current?.(message);
          return;
        }
        if (linkedRequest) {
          setRequestId(linkedRequest.id);
          setSourceLotId(linkedRequest.source_lot_id ?? params.get('sourceLotId') ?? '');
          setFiscalYear(linkedRequest.fiscal_year);
          setProjectName(linkedRequest.project_name);
          setProjectPeriod(linkedRequest.project_period ?? `${linkedRequest.fiscal_year}.01~${linkedRequest.fiscal_year}.12`);
          setProjectStartYear(linkedRequest.project_start_year ?? linkedRequest.fiscal_year);
          setProjectEndYear(linkedRequest.project_end_year ?? linkedRequest.fiscal_year);
          setBusinessType(linkedRequest.business_type ?? 'HW');
          setStatus(linkedRequest.project_status ?? '정상추진');
          setExecutionStatusReason(linkedRequest.execution_status_reason ?? '');
          setRequestedAmount(linkedRequest.requested_amount);
        }
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '신규사업 요청 정보를 불러오지 못했습니다.'));
      }
    });
  }, [currentYear]);

  const save = async (submit: boolean) => {
    if (!accessToken || !profile.region_id) return;
    setSubmitting(submit ? 'submit' : 'draft');
    setError(null);
    setNotice(null);
    try {
      const validation = validateNewProjectRequestDraft(projectDraft, undefined, !sourceLotId);
      if (validation) throw new Error(validation);
      if (submit && !sourceLotId) throw new Error('등록을 완료하려면 연결할 예산을 선택해 주세요.');
      if (projectStartYear === null || projectEndYear === null) {
        throw new Error('신규사업의 시작연도와 종료연도를 모두 입력해 주세요.');
      }
      requestKey.current ??= crypto.randomUUID();
      const result = await saveNewProjectRequestAction({
        accessToken,
        requestId,
        regionId: profile.region_id,
        sourceLotId: sourceLotId || undefined,
        fiscalYear,
        projectName,
        fundProjectName: projectName,
        detailProjectName: projectName,
        projectPeriod,
        projectStartYear,
        projectEndYear,
        status,
        executionStatusReason,
        businessType,
        requestedAmount,
        idempotencyKey: requestKey.current,
        submit,
      });
      if ('error' in result) throw new Error(result.error);
      requestKey.current = null;
      setNotice(submit
        ? '신규사업 등록과 예산연결을 완료했습니다. 같은 요청은 다시 반영되지 않습니다.'
        : sourceLotId
          ? '신규사업 요청을 연결 예산과 함께 임시저장했습니다.'
          : '재원 미연결 신규사업 초안을 임시저장했습니다. 예산조정에서 나중에 연결할 수 있습니다.');
      if (!submit) {
        setRequestId(result.data.request_id);
        setSavedDraft({ id: result.data.request_id, name: projectName.trim() });
        window.history.replaceState(null, '', `/my-projects?newProject=1&requestId=${result.data.request_id}`);
        await load(accessToken, result.data.request_id);
        return;
      }
      setSavedDraft(null);
      setProjectName('');
      setProjectPeriod('');
      setStatus('정상추진');
      setExecutionStatusReason('');
      setRequestedAmount('0');
      setLinkedPendingFlow(false);
      setRequestId(undefined);
      window.history.replaceState(null, '', '/my-projects');
      await load(accessToken);
    } catch (saveError) {
      setError(formatUserFacingError(saveError, '신규사업 요청을 저장하지 못했습니다.'));
    } finally {
      setSubmitting(null);
    }
  };

  const selectFundingSource = (nextSourceLotId: string) => {
    setSourceLotId(nextSourceLotId);
    const source = fundingSources.find((item) => item.source_lot_id === nextSourceLotId);
    if (!source) return;
    setFiscalYear(source.target_fiscal_year);
    setProjectName((current) => current || source.planned_project_name);
    setProjectPeriod((current) => current || `${source.target_fiscal_year}.01~${source.target_fiscal_year}.12`);
    setProjectStartYear(source.target_fiscal_year);
    setProjectEndYear(source.target_fiscal_year);
    setRequestedAmount(source.amount);
  };

  const editRequest = async (request: NewProjectRequest) => {
    if (!accessToken || request.source_budget_change_request_id) return;
    setRequestId(request.id);
    setSourceLotId(request.source_lot_id ?? '');
    setFiscalYear(request.fiscal_year);
    setProjectName(request.project_name);
    setProjectPeriod(request.project_period ?? '');
    setProjectStartYear(request.project_start_year ?? request.fiscal_year);
    setProjectEndYear(request.project_end_year ?? request.fiscal_year);
    setBusinessType(request.business_type ?? 'HW');
    setStatus(request.project_status ?? '정상추진');
    setExecutionStatusReason(request.execution_status_reason ?? '');
    setRequestedAmount(request.requested_amount);
    setLinkedPendingFlow(false);
    setOpen(true);
    setError(null);
    try {
      await load(accessToken, request.id);
    } catch (loadError) {
      setError(formatUserFacingError(loadError, '연결할 예산을 다시 불러오지 못했습니다.'));
    }
  };

  const handleDeleted = async (result: NewProjectDeletionResult) => {
    setDeleteTarget(null);
    setRequestId(undefined);
    setSavedDraft(null);
    setOpen(false);
    setProjectName('');
    setProjectPeriod('');
    setExecutionStatusReason('');
    setRequestedAmount('0');
    setSourceLotId('');
    setLinkedPendingFlow(false);
    setNotice(`${result.fiscal_year}년 ${result.project_name} 초안을 삭제했습니다. 공식 사업 수와 재정 금액은 변하지 않았습니다.`);
    window.history.replaceState(null, '', '/my-projects');
    if (accessToken) await load(accessToken);
    await onDeleted?.(result);
  };

  return (
    <section className="my-project-list-panel new-project-request-panel" id="new-project-request">
      <div className="new-project-request-heading">
        <div><p className="my-projects-eyebrow">{runtimeLabel}</p><h2>신규사업 등록</h2><p>필수 정보와 재원 검증을 통과하면 관리자 승인 없이 바로 등록됩니다.</p></div>
        <button type="button" className="my-project-save-button" onClick={() => { setRequestId(undefined); setSourceLotId(''); setStatus('정상추진'); setExecutionStatusReason(''); setLinkedPendingFlow(false); setSavedDraft(null); setOpen((current) => !current); }}>+ 신규사업 생성</button>
      </div>
      {open && (
        <div className="funding-workflow-grid">
          <div className="financial-ledger-form">
            <label className="financial-ledger-input"><span>연결할 예산</span><select value={sourceLotId} disabled={linkedPendingFlow} onChange={(event) => selectFundingSource(event.target.value)}><option value="">재원 없이 초안 작성</option>{fundingSources.map((source) => <option key={source.pending_fund_id} value={source.source_lot_id}>{formatProjectOption({ fiscal_year: source.target_fiscal_year, project_name: source.planned_project_name, status: 'DRAFT' })} · {formatWonWithUnit(source.amount)} · 출처 {formatProjectOption({ fiscal_year: source.source_fiscal_year, project_name: source.source_project_name, project_code: source.source_project_code, status: 'APPLIED' })}</option>)}</select></label>
            {fundingSources.length === 0 && <div className="financial-ledger-notice" role="status"><strong>현재 연결 가능한 대기재원이 없습니다.</strong><span>재원 없이 신규사업 초안을 임시저장할 수 있습니다. 이후 같은 지자체의 예산조정에서 이 초안을 차년도 목적지로 연결해 주세요.</span></div>}
            {selectedSource && <div className="financial-ledger-notice" role="status"><strong>{linkedPendingFlow ? '예산조정에서 자동 연결된 예정예산' : '선택한 예정예산'} · {formatWonWithUnit(selectedSource.amount)}</strong><span>출처 {formatProjectOption({ fiscal_year: selectedSource.source_fiscal_year, project_name: selectedSource.source_project_name, project_code: selectedSource.source_project_code, status: 'APPLIED' })} → 대상 {formatProjectOption({ fiscal_year: selectedSource.target_fiscal_year, project_name: selectedSource.planned_project_name, status: 'DRAFT' })} · 잔액 {formatWonWithUnit(selectedSource.remaining_amount)}</span></div>}
            {!selectedSource && fundingSources.length > 0 && <small>재원을 선택하지 않아도 초안은 저장할 수 있습니다. 등록 완료 전에는 반드시 연결할 예산이 필요합니다.</small>}
            <NewProjectRequestFields idPrefix="standalone-new-project" value={projectDraft} onChange={updateProjectDraft} fiscalYearReadOnly={Boolean(selectedSource)} amountReadOnly={Boolean(selectedSource)} allowZeroAmount={!selectedSource} amountHelp={selectedSource ? '선택한 예정예산과 같은 금액으로 자동 지정됩니다.' : undefined} />
          </div>
          <div className="financial-ledger-form">
            <p className="panel-sub">임시저장 단계에서는 재원이 없어도 됩니다. 완료 시 같은 지역·대상연도·금액의 대기재원을 원자적으로 한 번만 연결합니다.</p>
            {!sourceLotId && <div className="financial-ledger-notice"><strong>재원 미연결 초안</strong><span>임시저장만으로 공식 사업이나 예산에 반영되지 않습니다. 예산조정에서 재원을 연결한 뒤 등록을 완료할 수 있습니다.</span></div>}
            {submissionRequirements.length > 0 && <div className="financial-ledger-notice" role="status"><strong>등록 완료 전 확인</strong><ul>{submissionRequirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul></div>}
            <div className="funding-inline-actions"><button type="button" className="small-btn" disabled={submitting !== null} onClick={() => void save(false)}>{submitting === 'draft' ? '저장 중...' : sourceLotId ? '임시저장' : '사업만 임시저장'}</button><button type="button" className="my-project-save-button" disabled={submitting !== null || !sourceLotId || submissionRequirements.length > 0} onClick={() => void save(true)}>{submitting === 'submit' ? '등록·연결 중...' : '등록·예산연결 완료'}</button>{requestId && <button type="button" className="danger-outline-button" disabled={submitting !== null} onClick={() => setDeleteTarget({ id: requestId, name: projectName, year: fiscalYear })}>초안 삭제</button>}</div>
            {savedDraft && <div className="financial-ledger-notice" role="status"><strong>초안 저장 완료 · {savedDraft.name}</strong><span>입력한 사업정보는 그대로 유지됩니다. 목록에서 다시 열거나 감액할 기존사업을 선택해 재원을 연결할 수 있습니다.</span><div className="funding-inline-actions"><button type="button" className="small-btn" onClick={() => window.location.assign(`/my-projects?tab=projects&draft=${savedDraft.id}`)}>사업목록에서 보기</button><button type="button" className="small-btn" onClick={() => window.location.assign('/my-projects?tab=projects')}>재원 연결하기</button></div></div>}
          </div>
        </div>
      )}

      <h3 className="funding-subheading">내 요청</h3>
      {requests.length === 0 ? <div className="financial-ledger-empty">등록한 신규사업 요청이 없습니다.</div> : <div className="table-scroll"><table><thead><tr><th>상태</th><th>사업연도</th><th>사업명</th><th>집행상태 및 사유</th><th>재원 연결</th><th className="num">요청액</th><th>처리 결과</th><th>작업</th></tr></thead><tbody>{requests.map((request) => {
        const presentation = getProjectPresentation({ fiscal_year: request.fiscal_year, project_name: request.project_name, project_code: request.official_project_code, status: request.status });
        const fundingLabel = request.source_budget_change_request_id
          ? '예산조정 자동 연결'
          : request.source_lot_id
            ? '대기재원 연결'
            : '재원 미연결';
        const resultLabel = request.status === 'APPLIED'
          ? '사업 생성·재원 연결 완료'
          : request.status === 'REJECTED'
            ? '과거 관리자 반려 기록'
            : request.status === 'APPROVED'
              ? '직접 처리 재시도 필요'
              : request.status === 'SUBMITTED'
                ? '직접 처리 재시도 필요'
                : '임시저장';
        const executionStatus = formatSystemTerm(request.project_status, '상태 미입력');
        const executionLabel = request.execution_status_reason
          ? `${executionStatus} · ${formatStoredUserText(request.execution_status_reason, '사유 미입력')}`
          : executionStatus;
        return <tr key={request.id}><td>{formatSystemTerm(request.status)}</td><td>{request.fiscal_year}</td><td>{presentation.name}</td><td>{executionLabel}</td><td>{fundingLabel}</td><td className="num" title={`${formatIntegerString(request.requested_amount)}원`}>{formatWonWithUnit(request.requested_amount)}</td><td>{resultLabel}</td><td>{request.status === 'DRAFT' && !request.source_budget_change_request_id ? <div className="inline-actions"><button className="small-btn" type="button" onClick={() => void editRequest(request)}>초안 수정</button><button className="danger-outline-button" type="button" onClick={() => setDeleteTarget({ id: request.id, name: presentation.name, year: request.fiscal_year })}>삭제</button></div> : request.status === 'DRAFT' ? '예산조정에서 수정' : '-'}</td></tr>;
      })}</tbody></table></div>}
      {notice && <p className="financial-ledger-notice" role="status">{notice}</p>}
      {error && <p className="financial-ledger-error" role="alert">{error}</p>}
      {deleteTarget && accessToken && <NewProjectDeleteDialog
        accessToken={accessToken}
        targetKind="DRAFT"
        targetId={deleteTarget.id}
        fallbackName={deleteTarget.name}
        fallbackYear={deleteTarget.year}
        onCancel={() => setDeleteTarget(null)}
        onDeleted={handleDeleted}
      />}
    </section>
  );
}
