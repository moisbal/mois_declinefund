"use client";

import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPE_VALUES,
  type BusinessType,
} from '../../lib/projectClassification';

type ProjectBusinessTypeOptionsProps = {
  value: BusinessType | null;
  onChange: (value: BusinessType) => void;
  name: string;
};

const descriptions: Record<BusinessType, string> = {
  HW: '시설·건축·물리적 인프라 중심',
  SW: '프로그램·서비스·운영 중심',
  COMPOSITE: '시설과 프로그램을 함께 추진',
};

export default function ProjectBusinessTypeOptions({
  value,
  onChange,
  name,
}: ProjectBusinessTypeOptionsProps) {
  return (
    <div className="my-project-business-type-options" role="radiogroup" aria-label="사업유형">
      {BUSINESS_TYPE_VALUES.map((businessType) => (
        <label key={businessType} className={value === businessType ? 'selected' : ''}>
          <input
            type="radio"
            name={name}
            checked={value === businessType}
            onChange={() => onChange(businessType)}
          />
          <span className="my-project-business-type-copy">
            <strong>{BUSINESS_TYPE_LABELS[businessType]}</strong>
            <small>{descriptions[businessType]}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
