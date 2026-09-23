"use client";

import type { BusinessType } from '../../lib/projectClassification';
import ProjectBusinessTypeOptions from './ProjectBusinessTypeOptions';

type ProjectBusinessTypeSectionProps = {
  value: BusinessType | null;
  onChange: (value: BusinessType) => void;
};

export default function ProjectBusinessTypeSection({
  value,
  onChange,
}: ProjectBusinessTypeSectionProps) {
  return (
    <section className="my-project-section" aria-labelledby="my-project-business-type-title">
      <div className="my-project-section-heading">
        <span className="my-project-section-number">3</span>
        <div>
          <h2 id="my-project-business-type-title">사업유형</h2>
          <p>사업의 성격에 가장 가까운 유형을 하나 선택해 주세요.</p>
        </div>
      </div>
      <ProjectBusinessTypeOptions value={value} onChange={onChange} name="my-project-business-type" />
    </section>
  );
}
