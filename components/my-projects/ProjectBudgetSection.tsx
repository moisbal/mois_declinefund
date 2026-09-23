"use client";

import type { ReactNode } from 'react';
import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import {
  calculateProjectBudget,
  normalizeAmountInput,
  type MyProjectEditDraft,
} from '../../lib/myProjectEdit';

type ProjectBudgetSectionProps = {
  draft: Pick<MyProjectEditDraft, 'originalAlloc' | 'increaseAmount' | 'decreaseAmount' | 'exec'>;
  totalBudget: string | null;
  onChange: (changes: Partial<MyProjectEditDraft>) => void;
  ledgerManaged?: boolean;
  sectionNumber?: number;
  children?: ReactNode;
};

type EditableAmountKey = 'originalAlloc' | 'increaseAmount' | 'decreaseAmount' | 'exec';

function AmountInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="my-project-amount-input">
      <span>{label}</span>
      <div>
        <input
          type="text"
          inputMode="numeric"
          value={formatIntegerString(value)}
          onChange={(event) => onChange(normalizeAmountInput(event.target.value))}
          aria-label={label}
        />
        <span>원</span>
      </div>
    </label>
  );
}

export default function ProjectBudgetSection({
  draft,
  totalBudget,
  onChange,
  ledgerManaged = false,
  sectionNumber = 4,
  children,
}: ProjectBudgetSectionProps) {
  const calculated = calculateProjectBudget(draft);
  const values: Record<EditableAmountKey, string> = {
    originalAlloc: draft.originalAlloc,
    increaseAmount: draft.increaseAmount,
    decreaseAmount: draft.decreaseAmount,
    exec: draft.exec,
  };
  const labels: Record<EditableAmountKey, string> = {
    originalAlloc: '당초 배분액',
    increaseAmount: '증액액',
    decreaseAmount: '감액액',
    exec: '집행액',
  };

  return (
    <section className="my-project-section" aria-labelledby="my-project-budget-title">
      <div className="my-project-section-heading">
        <span className="my-project-section-number">{sectionNumber}</span>
        <div>
          <h2 id="my-project-budget-title">예산 및 집행</h2>
          <p>{ledgerManaged
            ? '당초 배분액과 증감액은 원장 기준값입니다. 집행액은 이 카드 아래 원 단위 입력에서 확정하고, 증감액은 예산 조정에서 처리합니다.'
            : '조정 후 배분액 = 당초 배분액 + 증액액 - 감액액, 미집행액 = 조정 후 배분액 - 집행액입니다.'}</p>
        </div>
      </div>

      <div className="my-project-budget-layout">
        <div className="my-project-budget-card">
          <h3>{ledgerManaged ? '예산 구성' : '사용자 입력'}</h3>
          <p>총사업비 <strong title={`${formatIntegerString(totalBudget ?? '0')}원`}>{formatWonAsManwonWithUnit(totalBudget ?? '0')}</strong>은 기존 자료값으로 유지됩니다.</p>
          {(Object.keys(values) as EditableAmountKey[]).map((key) => (
            ledgerManaged ? (
              <div className="my-project-amount-input" key={key}>
                <span>{labels[key]}</span>
                <div><strong title={`${formatIntegerString(values[key])}원`}>{formatWonAsManwonWithUnit(values[key])}</strong></div>
                {(key === 'increaseAmount' || key === 'decreaseAmount') && <small>아래 예산 조정 승인·적용 결과가 자동 합산됩니다.</small>}
                {key === 'exec' && <small>아래 집행액 입력에서 원 단위로 등록합니다.</small>}
              </div>
            ) : (
              key === 'increaseAmount' || key === 'decreaseAmount' ? (
                <div className="my-project-amount-input" key={key}>
                  <span>{labels[key]}</span>
                  <div><strong title={`${formatIntegerString(values[key])}원`}>{formatWonAsManwonWithUnit(values[key])}</strong></div>
                  <small>예산 조정에서 출처·목적지를 연결해 변경합니다.</small>
                </div>
              ) : <AmountInput
                key={key}
                label={labels[key]}
                value={values[key]}
                onChange={(value) => onChange({ [key]: value })}
              />
            )
          ))}
        </div>
        <div className="my-project-budget-card calculated">
          <h3>시스템 자동 계산</h3>
          <dl>
            <div>
              <dt>조정 후 배분액</dt>
              <dd>{formatIntegerString(calculated.adjustedAlloc.toString())}원</dd>
            </div>
            <div>
              <dt>미집행액</dt>
              <dd className={calculated.balance < BigInt(0) ? 'negative' : ''}>
                <span>{formatIntegerString(calculated.balance.toString())}원</span>
              </dd>
            </div>
            <div>
              <dt>집행률</dt>
              <dd>{calculated.rate.toFixed(2)}%</dd>
            </div>
          </dl>
        </div>
      </div>
      {children && <div className="my-project-budget-change-integrated">{children}</div>}
    </section>
  );
}
