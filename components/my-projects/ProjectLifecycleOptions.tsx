"use client";

type ProjectLifecycleOptionsProps = {
  fiscalYear: number | null;
  projectStartYear: number | null;
  onChange: (projectStartYear: number | null) => void;
  name: string;
};

export default function ProjectLifecycleOptions({
  fiscalYear,
  projectStartYear,
  onChange,
  name,
}: ProjectLifecycleOptionsProps) {
  const continuing = fiscalYear !== null && projectStartYear !== null && projectStartYear < fiscalYear;
  const disabled = fiscalYear === null;

  return (
    <div className="segmented-options project-lifecycle-options" role="radiogroup" aria-label="신규사업 또는 계속사업">
      <label className={projectStartYear !== null && !continuing ? 'selected' : undefined}>
        <input
          type="radio"
          name={name}
          checked={projectStartYear !== null && !continuing}
          onChange={() => onChange(fiscalYear)}
          disabled={disabled}
        />
        <span>신규사업</span>
      </label>
      <label className={continuing ? 'selected' : undefined}>
        <input
          type="radio"
          name={name}
          checked={continuing}
          onChange={() => onChange(
            projectStartYear !== null && fiscalYear !== null && projectStartYear < fiscalYear
              ? projectStartYear
              : fiscalYear !== null ? fiscalYear - 1 : null,
          )}
          disabled={disabled}
        />
        <span>계속사업</span>
      </label>
    </div>
  );
}
