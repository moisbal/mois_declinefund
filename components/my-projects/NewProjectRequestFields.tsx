"use client";

import { formatIntegerString, formatWonWithUnit } from '../../lib/amountFormat';
import { normalizeLedgerAmount } from '../../lib/financialLedger';
import {
  isProjectStatus,
  validateExecutionStatusReason,
  type ProjectStatus,
} from '../../lib/myProjectEdit';
import ProjectBusinessTypeOptions from './ProjectBusinessTypeOptions';
import ProjectExecutionStatusFields from './ProjectExecutionStatusFields';
import ProjectLifecycleOptions from './ProjectLifecycleOptions';

export type NewProjectRequestDraft = {
  fiscalYear: number;
  projectName: string;
  projectPeriod: string;
  projectStartYear: number | null;
  projectEndYear: number | null;
  businessType: 'HW' | 'SW' | 'COMPOSITE';
  status: ProjectStatus;
  executionStatusReason: string;
  requestedAmount: string;
};

type Props = {
  value: NewProjectRequestDraft;
  onChange: (value: NewProjectRequestDraft) => void;
  fiscalYearReadOnly?: boolean;
  amountReadOnly?: boolean;
  amountLabel?: string;
  amountHelp?: string;
  allowZeroAmount?: boolean;
  idPrefix?: string;
};

export function validateNewProjectRequestDraft(
  value: NewProjectRequestDraft,
  expectedFiscalYear?: number,
  allowZeroAmount = false,
) {
  if (expectedFiscalYear !== undefined && value.fiscalYear !== expectedFiscalYear) {
    return `차년도 신규사업의 사업연도는 ${expectedFiscalYear}년이어야 합니다.`;
  }
  if (!value.projectName.trim()) return '신규사업명을 입력해 주세요.';
  if (!value.projectPeriod.trim()) return '신규사업의 사업기간을 입력해 주세요.';
  if (value.projectStartYear === null || value.projectEndYear === null) {
    return '신규사업의 시작연도와 종료연도를 모두 입력해 주세요.';
  }
  if (!Number.isInteger(value.projectStartYear) || !Number.isInteger(value.projectEndYear)
      || value.projectStartYear < 2000 || value.projectStartYear > 2200
      || value.projectEndYear < 2000 || value.projectEndYear > 2200) {
    return '신규사업의 시작연도와 종료연도는 2000년부터 2200년 사이여야 합니다.';
  }
  if (value.projectStartYear > value.projectEndYear) {
    return '신규사업의 시작연도는 종료연도보다 늦을 수 없습니다.';
  }
  const periodYears = value.projectPeriod.match(/(?:19|20|21|22)\d{2}/g)?.map(Number) ?? [];
  if (periodYears.length > 0
      && (periodYears[0] !== value.projectStartYear
        || periodYears[periodYears.length - 1] !== value.projectEndYear)) {
    return '사업기간에 표시된 연도와 시작·종료연도가 일치해야 합니다.';
  }
  if (!isProjectStatus(value.status)) return '집행상태를 선택해 주세요.';
  const statusReasonError = validateExecutionStatusReason(value.status, value.executionStatusReason);
  if (statusReasonError) return statusReasonError;
  const amountPattern = allowZeroAmount ? /^\d+$/ : /^[1-9]\d*$/;
  if (!amountPattern.test(value.requestedAmount)) {
    return allowZeroAmount
      ? '신규사업 요청액은 0 이상의 원 단위 정수여야 합니다.'
      : '신규사업 배분액은 0보다 커야 합니다.';
  }
  return null;
}

export function getNewProjectSubmissionRequirements(
  value: NewProjectRequestDraft,
  hasFundingSource: boolean,
) {
  const requirements: string[] = [];
  const detailError = validateNewProjectRequestDraft(value, undefined, true);
  if (detailError) requirements.push(detailError);
  if (!hasFundingSource) {
    requirements.push('감액할 기존사업에서 이 초안을 목적지로 선택해 재원을 연결해 주세요.');
  }
  if (!/^[1-9]\d*$/.test(value.requestedAmount)) {
    requirements.push('재원 연결 후 승인할 배분액이 0원보다 커야 합니다.');
  }
  return [...new Set(requirements)];
}

export default function NewProjectRequestFields({
  value,
  onChange,
  fiscalYearReadOnly = false,
  amountReadOnly = false,
  amountLabel = '요청액',
  amountHelp,
  allowZeroAmount = false,
  idPrefix = 'new-project-request',
}: Props) {
  const update = <K extends keyof NewProjectRequestDraft>(key: K, next: NewProjectRequestDraft[K]) => {
    onChange({ ...value, [key]: next });
  };

  return <>
    <label className="financial-ledger-input"><span>사업연도</span><input type="number" min="2000" max="2200" value={value.fiscalYear} readOnly={fiscalYearReadOnly} onChange={(event) => update('fiscalYear', Number(event.target.value))} />{fiscalYearReadOnly && <small>출처 사업연도의 다음 연도로 자동 지정됩니다.</small>}</label>
    <label className="financial-ledger-input"><span>사업명</span><input value={value.projectName} maxLength={500} onChange={(event) => update('projectName', event.target.value)} /></label>
    <label className="financial-ledger-input"><span>사업기간</span><input value={value.projectPeriod} maxLength={200} placeholder={`${value.fiscalYear}.01~${value.fiscalYear}.12`} onChange={(event) => update('projectPeriod', event.target.value)} /></label>
    <fieldset className="financial-ledger-fieldset">
      <legend>신규사업 / 계속사업 <em>필수</em></legend>
      <ProjectLifecycleOptions
        fiscalYear={value.fiscalYear}
        projectStartYear={value.projectStartYear}
        onChange={(projectStartYear) => update('projectStartYear', projectStartYear)}
        name={`${idPrefix}-lifecycle`}
      />
    </fieldset>
    <label className="financial-ledger-input"><span>시작연도</span><input type="number" min="2000" max="2200" value={value.projectStartYear ?? ''} onChange={(event) => update('projectStartYear', event.target.value === '' ? null : Number(event.target.value))} /></label>
    <label className="financial-ledger-input"><span>종료연도</span><input type="number" min="2000" max="2200" value={value.projectEndYear ?? ''} onChange={(event) => update('projectEndYear', event.target.value === '' ? null : Number(event.target.value))} /></label>
    <fieldset className="financial-ledger-fieldset">
      <legend>사업유형 <em>필수</em></legend>
      <ProjectBusinessTypeOptions
        value={value.businessType}
        onChange={(businessType) => update('businessType', businessType)}
        name={`${idPrefix}-business-type`}
      />
    </fieldset>
    <ProjectExecutionStatusFields
      status={value.status}
      reason={value.executionStatusReason}
      onChange={(status, executionStatusReason) => onChange({ ...value, status, executionStatusReason })}
      fieldClassName="financial-ledger-input"
      namePrefix={`${idPrefix}-execution`}
    />
    <label className="financial-ledger-input"><span>{amountLabel} <small>(원 단위 입력)</small></span><div><input inputMode="numeric" value={formatIntegerString(value.requestedAmount)} readOnly={amountReadOnly} onChange={(event) => update('requestedAmount', normalizeLedgerAmount(event.target.value))} /><span>원</span></div><small>{amountHelp ?? (allowZeroAmount && value.requestedAmount === '0' ? '재원을 나중에 연결할 초안은 0원으로 저장할 수 있습니다.' : `화면 표시 ${formatWonWithUnit(value.requestedAmount)}`)}</small></label>
  </>;
}
