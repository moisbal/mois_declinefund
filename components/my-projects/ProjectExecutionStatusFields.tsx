"use client";

import {
  PROJECT_STATUS_REASON_LABELS,
  PROJECT_STATUS_REASON_PLACEHOLDERS,
  PROJECT_STATUS_VALUES,
  requiresExecutionStatusReason,
  type ProjectStatus,
} from '../../lib/myProjectEdit';

type ProjectExecutionStatusFieldsProps = {
  status: ProjectStatus;
  reason: string;
  onChange: (status: ProjectStatus, reason: string) => void;
  fieldClassName: string;
  namePrefix: string;
};

export default function ProjectExecutionStatusFields({
  status,
  reason,
  onChange,
  fieldClassName,
  namePrefix,
}: ProjectExecutionStatusFieldsProps) {
  const reasonRequired = requiresExecutionStatusReason(status);

  return (
    <div className="project-execution-status-layout">
      <label className={fieldClassName}>
        <span>집행상태 <em>필수</em></span>
        <select
          name={`${namePrefix}-status`}
          value={status}
          onChange={(event) => {
            const nextStatus = event.target.value as ProjectStatus;
            onChange(nextStatus, requiresExecutionStatusReason(nextStatus) ? reason : '');
          }}
        >
          {PROJECT_STATUS_VALUES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      {reasonRequired && (
        <label className={fieldClassName}>
          <span>{PROJECT_STATUS_REASON_LABELS[status]} <em>필수</em></span>
          <textarea
            name={`${namePrefix}-reason`}
            value={reason}
            onChange={(event) => onChange(status, event.target.value)}
            placeholder={PROJECT_STATUS_REASON_PLACEHOLDERS[status]}
            rows={3}
            maxLength={500}
            aria-describedby={`${namePrefix}-reason-help`}
            required
          />
          <small id={`${namePrefix}-reason-help`}>500자 이하</small>
        </label>
      )}
    </div>
  );
}
