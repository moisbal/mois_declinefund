"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmExecutionAction,
  createOrSubmitTransferAction,
  getFinancialBudgetYearsAction,
  getTransferDestinationProjectsAction,
} from '../../app/my-projects/financial-actions';
import {
  getFundingRuntimeAction,
  getProjectFundingPositionAction,
} from '../../app/my-projects/funding-actions';
import { getCurrentSession } from '../../lib/auth';
import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import {
  normalizeLedgerAmount,
  type FinancialBudgetYear,
  type TransferDestinationProject,
} from '../../lib/financialLedger';
import {
  canUseNativeWorkflow,
  fundingRuntimeLabel,
  type FundingRuntime,
  type ProjectFundingPosition,
} from '../../lib/fundingManagement';
import { formatSystemTerm, formatUserFacingError } from '../../lib/presentationLabels';

type ProjectFinancialLedgerSectionProps = {
  projectId: string;
  sectionNumber?: number;
  onLedgerManagedChange: (isManaged: boolean) => void;
  onFundingPositionChange?: (position: ProjectFundingPosition) => void;
  embedded?: boolean;
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function LedgerAmountInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="financial-ledger-input">
      <span>{label}</span>
      <div>
        <input
          type="text"
          inputMode="numeric"
          value={formatIntegerString(value)}
          onChange={(event) => onChange(normalizeLedgerAmount(event.target.value))}
          aria-label={label}
        />
        <span>원</span>
      </div>
      <small>화면 표시 {formatWonAsManwonWithUnit(value)}</small>
    </label>
  );
}

export default function ProjectFinancialLedgerSection({
  projectId,
  sectionNumber = 6,
  onLedgerManagedChange,
  onFundingPositionChange,
  embedded = false,
}: ProjectFinancialLedgerSectionProps) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [wallets, setWallets] = useState<FinancialBudgetYear[]>([]);
  const [runtime, setRuntime] = useState<FundingRuntime | null>(null);
  const [sourceBudgetYearId, setSourceBudgetYearId] = useState('');
  const [destinationProjects, setDestinationProjects] = useState<TransferDestinationProject[]>([]);
  const [destinationProjectId, setDestinationProjectId] = useState('');
  const [executionAmount, setExecutionAmount] = useState('0');
  const [executionDate, setExecutionDate] = useState(today);
  const [executionMemo, setExecutionMemo] = useState('');
  const [transferAmount, setTransferAmount] = useState('0');
  const [transferDate, setTransferDate] = useState(today);
  const [transferReason, setTransferReason] = useState('');
  const [transferMemo, setTransferMemo] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [submitting, setSubmitting] = useState<'execution' | 'transfer' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.budget_year_id === sourceBudgetYearId) ?? null,
    [sourceBudgetYearId, wallets],
  );

  const loadWallets = useCallback(async (token: string) => {
    const [result, positionResult] = await Promise.all([
      getFinancialBudgetYearsAction({ accessToken: token }),
      getProjectFundingPositionAction({ accessToken: token, projectId }),
    ]);
    if ('error' in result) {
      throw new Error(result.error);
    }
    if ('error' in positionResult) {
      throw new Error(positionResult.error);
    }
    const projectWallets = result.data.filter((wallet) => wallet.project_id === projectId);
    setWallets(projectWallets);
    setSourceBudgetYearId((current) => (
      projectWallets.some((wallet) => wallet.budget_year_id === current)
        ? current
        : projectWallets[0]?.budget_year_id ?? ''
    ));
    onLedgerManagedChange(projectWallets.length > 0);
    if (positionResult.data.position) {
      onFundingPositionChange?.(positionResult.data.position);
    }
  }, [onFundingPositionChange, onLedgerManagedChange, projectId]);

  useEffect(() => {
    const initialize = async () => {
      try {
        const sessionResult = await getCurrentSession();
        const token = sessionResult.data.session?.access_token;
        if (!token) throw new Error('로그인 세션을 확인하지 못했습니다.');
        setAccessToken(token);
        const runtimeResult = await getFundingRuntimeAction({ accessToken: token });
        if ('error' in runtimeResult) throw new Error(runtimeResult.error);
        setRuntime(runtimeResult.data);
        await loadWallets(token);
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '재정원장을 불러오지 못했습니다.'));
      } finally {
        setLoading(false);
      }
    };
    void initialize();
  }, [loadWallets]);

  useEffect(() => {
    const loadDestinations = async () => {
      if (!accessToken || !sourceBudgetYearId) {
        setDestinationProjects([]);
        setDestinationProjectId('');
        return;
      }
      setLoadingDestinations(true);
      try {
        const result = await getTransferDestinationProjectsAction({
          accessToken,
          sourceBudgetYearId,
        });
        if ('error' in result) throw new Error(result.error);
        setDestinationProjects(result.data);
        setDestinationProjectId((current) => (
          result.data.some((project) => project.project_id === current)
            ? current
            : result.data[0]?.project_id ?? ''
        ));
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '이동 가능한 사업을 불러오지 못했습니다.'));
      } finally {
        setLoadingDestinations(false);
      }
    };
    void loadDestinations();
  }, [accessToken, sourceBudgetYearId]);

  const getIdempotencyKey = (operation: string, signature: string) => {
    const mapKey = `${operation}:${signature}`;
    const existing = idempotencyKeys.current.get(mapKey);
    if (existing) return { mapKey, key: existing };
    const key = crypto.randomUUID();
    idempotencyKeys.current.set(mapKey, key);
    return { mapKey, key };
  };

  const refresh = async () => {
    if (!accessToken) return;
    await loadWallets(accessToken);
  };

  const nativeExecutionEnabled = canUseNativeWorkflow(runtime, executionDate);
  const nativeTransferEnabled = canUseNativeWorkflow(runtime, transferDate);

  const submitExecution = async () => {
    if (!accessToken || !sourceBudgetYearId) return;
    const signature = [sourceBudgetYearId, executionAmount, executionDate, executionMemo.trim()].join('|');
    const { mapKey, key } = getIdempotencyKey('execution', signature);
    setSubmitting('execution');
    setError(null);
    setNotice(null);
    try {
      const result = await confirmExecutionAction({
        accessToken,
        budgetYearId: sourceBudgetYearId,
        amount: executionAmount,
        executionDate,
        memo: executionMemo,
        idempotencyKey: key,
      });
      if ('error' in result) throw new Error(result.error);
      idempotencyKeys.current.delete(mapKey);
      setExecutionAmount('0');
      setExecutionMemo('');
      setNotice(`집행이 ${formatSystemTerm(result.data.status)} 상태로 처리되었습니다.`);
      await refresh();
    } catch (submitError) {
      setError(formatUserFacingError(submitError, '집행을 확정하지 못했습니다. 같은 값으로 재시도하면 동일 요청키를 사용합니다.'));
    } finally {
      setSubmitting(null);
    }
  };

  const submitTransfer = async () => {
    if (!accessToken || !sourceBudgetYearId || !destinationProjectId) return;
    const signature = [
      sourceBudgetYearId,
      destinationProjectId,
      transferAmount,
      transferDate,
      transferReason.trim(),
      transferMemo.trim(),
    ].join('|');
    const { mapKey, key } = getIdempotencyKey('transfer', signature);
    setSubmitting('transfer');
    setError(null);
    setNotice(null);
    try {
      const result = await createOrSubmitTransferAction({
        accessToken,
        sourceBudgetYearId,
        destinationProjectId,
        amount: transferAmount,
        reasonCode: transferReason,
        memo: transferMemo,
        effectiveDate: transferDate,
        idempotencyKey: key,
        submit: true,
      });
      if ('error' in result) throw new Error(result.error);
      idempotencyKeys.current.delete(mapKey);
      setTransferAmount('0');
      setTransferReason('');
      setTransferMemo('');
      setNotice(`재원이동 요청이 ${formatSystemTerm(result.data.status)} 상태로 등록되었습니다.`);
      await refresh();
    } catch (submitError) {
      setError(formatUserFacingError(submitError, '재원이동을 등록하지 못했습니다. 같은 값으로 재시도하면 동일 요청키를 사용합니다.'));
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section className={embedded ? 'financial-ledger-section financial-ledger-section-embedded' : 'my-project-section financial-ledger-section'} aria-labelledby="financial-ledger-title">
      {embedded ? (
        <div className="financial-ledger-embedded-heading">
          <h3 id="financial-ledger-title">집행액 입력</h3>
          <p>원장 적용 사업도 이 영역에서 집행할 금액을 원 단위로 입력할 수 있습니다.</p>
        </div>
      ) : (
        <div className="my-project-section-heading">
          <span className="my-project-section-number">{sectionNumber}</span>
          <div>
            <h2 id="financial-ledger-title">재정원장</h2>
            <p>집행과 미집행액의 원 단위 근거를 확인합니다. 사업간 조정은 바로 위 예산 조정에서 처리합니다.</p>
          </div>
        </div>
      )}

      <div className={`funding-runtime-banner ${runtime?.mode === 'RECONCILIATION' ? 'legacy' : 'native'}`}>
        <strong>{fundingRuntimeLabel(runtime)}</strong>
        <span>{runtime?.mode === 'RECONCILIATION' ? '현재 과거자료 검수기간에는 집행 제출이 비활성화됩니다.' : '신규 운영거래 시작일 이전 효력일은 제출할 수 없습니다.'}</span>
      </div>

      {loading && <p className="financial-ledger-status">원장을 불러오는 중입니다...</p>}
      {!loading && wallets.length === 0 && (
        <div className="financial-ledger-empty">
          아직 이 사업에 생성된 원재원이 없습니다. 기준잔액 준비 또는 유효한 예산연결이 완료되면 표시됩니다.
        </div>
      )}
      {!loading && wallets.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="financial-ledger-table">
              <thead>
                <tr>
                  <th>원재원 / 회계연도</th>
                  <th>최초 배분</th>
                  <th className="num">현재 미집행액</th>
                  <th className="num">미완료 요청액</th>
                  <th className="num">조정 가능액</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((wallet) => (
                  <tr key={wallet.budget_year_id} className={wallet.budget_year_id === sourceBudgetYearId ? 'selected' : ''}>
                    <td>
                      <label className="financial-ledger-wallet-select">
                        <input
                          type="radio"
                          name="financial-source-wallet"
                          checked={wallet.budget_year_id === sourceBudgetYearId}
                          onChange={() => setSourceBudgetYearId(wallet.budget_year_id)}
                        />
                        <span>{wallet.origin_fiscal_year}년 최초재원 · {wallet.fiscal_year}년 위치</span>
                      </label>
                    </td>
                    <td>{formatWonAsManwonWithUnit(wallet.initial_allocation)}</td>
                    <td className="num"><strong title={`${formatIntegerString(wallet.accounting_balance)}원`}>{formatWonAsManwonWithUnit(wallet.accounting_balance)}</strong></td>
                    <td className="num" title={`${formatIntegerString(wallet.reserved_amount)}원`}>{formatWonAsManwonWithUnit(wallet.reserved_amount)}</td>
                    <td className="num"><strong title={`${formatIntegerString(wallet.available_to_commit)}원`}>{formatWonAsManwonWithUnit(wallet.available_to_commit)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedWallet && (
            <p className="financial-ledger-selected-summary">
              선택 재원 조정 가능액: <strong title={`${formatIntegerString(selectedWallet.available_to_commit)}원`}>{formatWonAsManwonWithUnit(selectedWallet.available_to_commit)}</strong>
              <span>({formatWonAsManwonWithUnit(selectedWallet.available_to_commit)})</span>
            </p>
          )}

          <div className="financial-ledger-actions">
            <form className="financial-ledger-form" onSubmit={(event) => { event.preventDefault(); void submitExecution(); }}>
              <h3>원장 집행 확정</h3>
              <LedgerAmountInput label="이번 집행액" value={executionAmount} onChange={setExecutionAmount} />
              <label className="financial-ledger-input">
                <span>집행일</span>
                <input type="date" value={executionDate} onChange={(event) => setExecutionDate(event.target.value)} />
              </label>
              <label className="financial-ledger-input">
                <span>메모 (선택)</span>
                <input value={executionMemo} maxLength={1000} onChange={(event) => setExecutionMemo(event.target.value)} />
              </label>
              <button type="submit" className="my-project-save-button" disabled={submitting !== null || !sourceBudgetYearId || !nativeExecutionEnabled}>
                {submitting === 'execution' ? '집행 확정 중...' : '집행 확정'}
              </button>
            </form>

          </div>
        </>
      )}

      {notice && <p className="financial-ledger-notice" role="status">{notice}</p>}
      {error && <p className="financial-ledger-error" role="alert">{error}</p>}
    </section>
  );
}
