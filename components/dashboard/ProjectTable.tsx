"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UserProfile } from '../../lib/auth';
import {
  getProjectFilterOptionsForUser,
  getProjectsForUser,
  PROJECTS_PAGE_SIZE,
  updateProjectExec,
} from '../../lib/projects';
import type {
  ProjectClassificationUpdate,
  ProjectFilterOptions,
  ProjectFilters,
  ProjectWithRegion,
} from '../../lib/projects';
import { formatIntegerString, formatWonAsManwon } from '../../lib/amountFormat';
import { BUSINESS_TYPE_LABELS, type BusinessType } from '../../lib/projectClassification';
import {
  formatSystemTerm,
  formatUserFacingError,
  getProjectPresentation,
  sanitizeClassificationNameForDisplay,
} from '../../lib/presentationLabels';
import ProjectClassificationEditor from './ProjectClassificationEditor';

const EMPTY_FILTERS: ProjectFilters = {};
const EMPTY_FILTER_OPTIONS: ProjectFilterOptions = {
  yearCounts: {},
  sidos: [],
  sigungusBySido: {},
  regionTypes: [],
  categories: [],
};
const MAX_DB_BIGINT = BigInt('9223372036854775807');

function normalizeExecInput(value: string) {
  return value.replace(/[^0-9]/g, '');
}

function formatExecInput(value: string) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function toBigInt(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = normalizeExecInput(String(value));
  return normalized ? BigInt(normalized) : null;
}

function getCaretPosition(formattedValue: string, digitCount: number) {
  if (digitCount === 0) {
    return 0;
  }

  let digitsSeen = 0;
  for (let index = 0; index < formattedValue.length; index += 1) {
    if (/\d/.test(formattedValue[index])) {
      digitsSeen += 1;
      if (digitsSeen === digitCount) {
        return index + 1;
      }
    }
  }

  return formattedValue.length;
}

function getProjectDisplayName(project: ProjectWithRegion) {
  const rawName = project.detail_project_name?.trim()
    || project.fund_project_name?.trim()
    || project.project_name?.trim()
    || '-';
  return getProjectPresentation({
    fiscal_year: project.year,
    project_name: rawName,
    project_code: project.project_code,
    status: project.status,
  }).name;
}

function getBusinessTypeLabel(project: ProjectWithRegion) {
  return project.business_type ? BUSINESS_TYPE_LABELS[project.business_type] : '-';
}

type ProjectTableProps = {
  profile: UserProfile;
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string, projectCode: string) => void;
  onProjectSaved?: () => void;
  refreshVersion?: number;
};

export default function ProjectTable({
  profile,
  selectedProjectId,
  onSelectProject,
  onProjectSaved,
  refreshVersion = 0,
}: ProjectTableProps) {
  const [projects, setProjects] = useState<ProjectWithRegion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [draftFilters, setDraftFilters] = useState<ProjectFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ProjectFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [filterOptions, setFilterOptions] = useState<ProjectFilterOptions>(EMPTY_FILTER_OPTIONS);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(true);
  const [filterOptionsError, setFilterOptionsError] = useState<string | null>(null);
  const [classificationProjectId, setClassificationProjectId] = useState<string | null>(null);
  const loadRequestId = useRef(0);
  const hasLoadedProjects = useRef(false);

  const loadProjects = useCallback(async () => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const result = await getProjectsForUser(profile, {
        ...filters,
        page,
        pageSize: PROJECTS_PAGE_SIZE,
      });
      if (requestId === loadRequestId.current) {
        setProjects(result.data);
        setTotalCount(result.count ?? 0);
        hasLoadedProjects.current = true;
      }
    } catch (err) {
      if (requestId === loadRequestId.current) {
        const refreshError = formatUserFacingError(err, '최신 사업 목록을 불러오지 못했습니다.');
        if (hasLoadedProjects.current) {
          setMessage(`${refreshError} 화면의 기존 값은 유지되며 저장 요청을 다시 전송하지 않았습니다.`);
        } else {
          setError(refreshError);
        }
      }
    } finally {
      if (requestId === loadRequestId.current) {
        setLoading(false);
      }
    }
  }, [filters, page, profile]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshVersion]);

  useEffect(() => {
    let cancelled = false;

    const loadFilterOptions = async () => {
      setFilterOptionsLoading(true);
      setFilterOptionsError(null);
      try {
        const options = await getProjectFilterOptionsForUser(profile);
        if (!cancelled) {
          setFilterOptions(options);
        }
      } catch (err) {
        if (!cancelled) {
          setFilterOptions(EMPTY_FILTER_OPTIONS);
          setFilterOptionsError(formatUserFacingError(err, '필터 목록을 불러오지 못했습니다.'));
        }
      } finally {
        if (!cancelled) {
          setFilterOptionsLoading(false);
        }
      }
    };

    loadFilterOptions();
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PROJECTS_PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const rows = projects;

  const yearOptions = useMemo(() => {
    return Object.entries(filterOptions.yearCounts)
      .map(([year, count]) => ({ year: Number(year), count }))
      .sort((a, b) => a.year - b.year);
  }, [filterOptions.yearCounts]);

  const classificationProject = useMemo(() => (
    projects.find((project) => project.id === classificationProjectId) ?? null
  ), [classificationProjectId, projects]);

  const sigunguOptions = useMemo(() => (
    draftFilters.sido ? filterOptions.sigungusBySido[draftFilters.sido] ?? [] : []
  ), [draftFilters.sido, filterOptions.sigungusBySido]);

  useEffect(() => {
    setClassificationProjectId((currentProjectId) => (
      currentProjectId && !projects.some((project) => project.id === currentProjectId)
        ? null
        : currentProjectId
    ));
  }, [projects]);

  const handleChange = (projectId: string, input: HTMLInputElement) => {
    const digitCountBeforeCaret = normalizeExecInput(
      input.value.slice(0, input.selectionStart ?? input.value.length),
    ).length;
    const normalizedValue = normalizeExecInput(input.value);

    setEditing((prev) => ({ ...prev, [projectId]: normalizedValue }));

    requestAnimationFrame(() => {
      if (document.activeElement !== input) {
        return;
      }
      const caretPosition = getCaretPosition(formatExecInput(normalizedValue), digitCountBeforeCaret);
      input.setSelectionRange(caretPosition, caretPosition);
    });
  };

  const handleSave = async (project: ProjectWithRegion) => {
    if (project.ledger_managed) {
      setMessage('재정원장 적용 사업의 집행액은 사업 상세의 재원관리 절차에서 변경하세요.');
      return;
    }
    const rawExec = editing[project.id] ?? project.exec_text ?? '';
    if (!rawExec.trim()) {
      setMessage('집행액을 입력하세요. 빈 값은 저장할 수 없습니다.');
      return;
    }

    if (!/^\d+$/.test(rawExec)) {
      setMessage('집행액은 유효한 숫자로 입력하세요.');
      return;
    }
    const newExec = BigInt(rawExec);
    if (newExec < BigInt(0)) {
      setMessage('집행액은 0 이상이어야 합니다.');
      return;
    }
    if (newExec > MAX_DB_BIGINT) {
      setMessage('집행액이 시스템에서 처리할 수 있는 범위를 초과했습니다.');
      return;
    }
    if (project.alloc === null || project.alloc === undefined) {
      setMessage('배분액 정보가 없어 집행액을 저장할 수 없습니다.');
      return;
    }
    const allocatedAmount = toBigInt(project.alloc_text);
    if (allocatedAmount === null) {
      setMessage('배분액 정보가 없어 집행액을 저장할 수 없습니다.');
      return;
    }
    if (newExec > allocatedAmount) {
      setMessage('집행액은 배분액을 초과할 수 없습니다.');
      return;
    }
    if (newExec === toBigInt(project.exec_text)) {
      setMessage('변경 내용이 없습니다.');
      return;
    }

    setSaving((prev) => ({ ...prev, [project.id]: true }));
    try {
      const updated = await updateProjectExec(project.id, rawExec, profile.id, profile);
      setProjects((prev) => prev.map((item) => (
        item.id === project.id ? { ...item, ...updated, exec_text: rawExec } : item
      )));
      setEditing((prev) => {
        const next = { ...prev };
        delete next[project.id];
        return next;
      });
      setMessage(`${getProjectDisplayName(project)} 사업이 저장되었습니다.`);
      onProjectSaved?.();
    } catch (err) {
      setMessage(formatUserFacingError(err, '저장 중 오류가 발생했습니다.'));
    } finally {
      setSaving((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  const beginExecEdit = (project: ProjectWithRegion) => {
    if (project.ledger_managed) {
      setMessage('재정원장 적용 사업의 집행액은 사업 상세의 재원관리 절차에서 변경하세요.');
      return;
    }
    setEditing((current) => ({ ...current, [project.id]: project.exec_text ?? '0' }));
  };

  const cancelExecEdit = (projectId: string) => {
    setEditing((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  };

  const handleClassificationSaved = (updated: ProjectClassificationUpdate) => {
    const updatedProject = projects.find((project) => project.id === updated.id);
    setProjects((current) => current.map((project) => (
      project.id === updated.id ? { ...project, ...updated } : project
    )));
    setClassificationProjectId(null);
    setMessage(`${updatedProject ? getProjectDisplayName({ ...updatedProject, ...updated }) : '선택한 사업'}의 분류가 저장되었습니다.`);
    onProjectSaved?.();
  };

  if (loading && !hasLoadedProjects.current) {
    return <div className="panel">사업 목록을 불러오는 중입니다...</div>;
  }

  if (error) {
    return <div className="panel error-message">{error}</div>;
  }

  return (
    <div className="panel">
      <div className="section-title">사업 목록</div>
      <p className="panel-sub">권한에 따라 본인 지역 또는 전체 사업을 확인하고, 집행액을 수정할 수 있습니다.</p>
      <form
        className="project-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (loading) return;
          setLoading(true);
          setFilters({ ...draftFilters, query: searchQuery.trim() || undefined });
          setPage(1);
        }}
      >
        <label>
          연도
          <select
            value={draftFilters.year ?? ''}
            onChange={(event) => setDraftFilters((current) => ({
              ...current,
              year: event.target.value ? Number(event.target.value) : undefined,
            }))}
          >
            <option value="">{filterOptionsLoading ? '목록 불러오는 중...' : '전체'}</option>
            {yearOptions.map(({ year, count }) => (
              <option key={year} value={year}>{year} ({count.toLocaleString('ko-KR')}건)</option>
            ))}
          </select>
        </label>
        <label>
          시도
          <select
            value={draftFilters.sido ?? ''}
            onChange={(event) => setDraftFilters((current) => ({
              ...current,
              sido: event.target.value || undefined,
              sigungu: undefined,
            }))}
            disabled={filterOptionsLoading}
          >
            <option value="">{filterOptionsLoading ? '목록 불러오는 중...' : '전체 시도'}</option>
            {filterOptions.sidos.map((sido) => <option key={sido} value={sido}>{sido}</option>)}
          </select>
        </label>
        <label>
          시군구
          <select
            value={draftFilters.sigungu ?? ''}
            onChange={(event) => setDraftFilters((current) => ({ ...current, sigungu: event.target.value || undefined }))}
            disabled={!draftFilters.sido || filterOptionsLoading}
          >
            <option value="">
              {!draftFilters.sido ? '시도를 먼저 선택하세요' : filterOptionsLoading ? '목록 불러오는 중...' : '전체 시군구'}
            </option>
            {sigunguOptions.map((sigungu) => <option key={sigungu} value={sigungu}>{sigungu}</option>)}
          </select>
        </label>
        <label>
          지역구분
          <select
            value={draftFilters.region_type ?? ''}
            onChange={(event) => setDraftFilters((current) => ({ ...current, region_type: event.target.value || undefined }))}
            disabled={filterOptionsLoading}
          >
            <option value="">{filterOptionsLoading ? '목록 불러오는 중...' : '전체 지역구분'}</option>
            {filterOptions.regionTypes.map((regionType) => (
              <option key={regionType} value={regionType}>{regionType}</option>
            ))}
          </select>
        </label>
        <label>
          기존 대분류
          <select
            value={draftFilters.category ?? ''}
            onChange={(event) => setDraftFilters((current) => ({ ...current, category: event.target.value || undefined }))}
            disabled={filterOptionsLoading}
          >
            <option value="">{filterOptionsLoading ? '목록 불러오는 중...' : '전체 대분류'}</option>
            {filterOptions.categories.map((category) => <option key={category} value={category}>{sanitizeClassificationNameForDisplay(category)}</option>)}
          </select>
        </label>
        <label>
          사업유형
          <select
            value={draftFilters.business_type ?? ''}
            onChange={(event) => setDraftFilters((current) => ({
              ...current,
              business_type: event.target.value ? event.target.value as BusinessType : undefined,
            }))}
          >
            <option value="">전체</option>
            <option value="HW">{BUSINESS_TYPE_LABELS.HW}</option>
            <option value="SW">{BUSINESS_TYPE_LABELS.SW}</option>
            <option value="COMPOSITE">{BUSINESS_TYPE_LABELS.COMPOSITE}</option>
          </select>
        </label>
        <div className="filter-actions">
          <button className="small-btn" type="submit" disabled={loading}>{loading ? '조회 중...' : '조회'}</button>
          <button
            className="small-btn"
            type="button"
            onClick={() => {
              setDraftFilters(EMPTY_FILTERS);
              setFilters(EMPTY_FILTERS);
              setSearchQuery('');
              setPage(1);
            }}
          >
            초기화
          </button>
        </div>
      </form>
      {filterOptionsError && <div className="error-message filter-options-error">{filterOptionsError}</div>}
      <div className="table-controls">
        <input
          type="search"
          placeholder="전체 사업에서 사업명 검색"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (loading) return;
              setLoading(true);
              setFilters({ ...draftFilters, query: searchQuery.trim() || undefined });
              setPage(1);
            }
          }}
          style={{ marginBottom: 12, padding: '10px 14px', width: '100%', maxWidth: 320, borderRadius: 12, border: '1px solid #dfe3eb' }}
        />
        <button type="button" className="small-btn" onClick={() => { if (loading) return; setLoading(true); setFilters({ ...draftFilters, query: searchQuery.trim() || undefined }); setPage(1); }} disabled={loading}>
          {loading ? '검색 중...' : '전체 목록 검색'}
        </button>
      </div>
      {message && <div className="toast-message">{message}</div>}
      <div className="table-scroll dashboard-project-table-scroll">
        <table>
          <thead>
            <tr>
              <th>사업명</th>
              <th>연도</th>
              <th>지역</th>
              <th>기존 대분류</th>
              <th>사업유형</th>
              <th className="num">총사업비(만원)</th>
              <th className="num">배분액(만원)</th>
              <th className="num">집행액(만원)</th>
              <th>집행률</th>
              <th>상태</th>
              <th>분류</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((project) => (
              <Fragment key={project.id}>
                <tr
                  className={[
                    project.id === selectedProjectId ? 'selected-row' : '',
                    project.id === classificationProjectId ? 'classification-editing-row-trigger' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => onSelectProject?.(project.id, project.project_code ?? '')}
                >
                <td>{getProjectDisplayName(project)}</td>
                <td>{project.year}</td>
                <td>{project.regions?.display_name ?? '미정'}</td>
                <td>{sanitizeClassificationNameForDisplay(project.category, '-')}</td>
                <td>{getBusinessTypeLabel(project)}</td>
                <td
                  className="num amount-display"
                  title={`${formatIntegerString(project.total_budget_text ?? '0')}원`}
                >
                  {formatWonAsManwon(project.total_budget_text ?? '0')}
                </td>
                <td
                  className="num amount-display"
                  title={`${formatIntegerString(project.alloc_text ?? '0')}원`}
                >
                  {formatWonAsManwon(project.alloc_text ?? '0')}
                </td>
                <td className="num amount-display execution-amount-cell">
                  <div className="execution-amount-with-action">
                    <span title={`${formatIntegerString(project.exec_text ?? '0')}원`}>
                      {formatWonAsManwon(project.exec_text ?? '0')}
                    </span>
                    <button
                      className="table-action-button execution-edit-button"
                      type="button"
                      disabled={project.ledger_managed || saving[project.id]}
                      title={project.ledger_managed ? '재정원장 적용 사업은 사업 상세의 재원관리 절차에서 변경합니다.' : undefined}
                      aria-label={`${getProjectDisplayName(project)} 집행액 수정`}
                      aria-expanded={Object.prototype.hasOwnProperty.call(editing, project.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (Object.prototype.hasOwnProperty.call(editing, project.id)) cancelExecEdit(project.id);
                        else beginExecEdit(project);
                      }}
                    >{project.ledger_managed ? '원장에서 관리' : Object.prototype.hasOwnProperty.call(editing, project.id) ? '수정 닫기' : '집행액 수정'}</button>
                  </div>
                </td>
                <td className="num">{(project.rate ?? 0).toFixed(1)}%</td>
                <td>{formatSystemTerm(project.status)}</td>
                <td>
                  <button
                    className="table-action-button classification-action-button"
                    type="button"
                    aria-label={`${getProjectDisplayName(project)} 분류 수정`}
                    aria-expanded={project.id === classificationProjectId}
                    onClick={(event) => {
                      event.stopPropagation();
                      setClassificationProjectId((currentProjectId) => (
                        currentProjectId === project.id ? null : project.id
                      ));
                    }}
                  >
                    {project.id === classificationProjectId ? '닫기' : '수정'}
                  </button>
                </td>
                </tr>
                {Object.prototype.hasOwnProperty.call(editing, project.id) && (
                  <tr className="execution-editor-row">
                    <td colSpan={11}>
                      <section className="execution-editor-panel" aria-label={`${getProjectDisplayName(project)} 집행액 수정`}>
                        <div className="execution-editor-context">
                          <strong>{getProjectDisplayName(project)}</strong>
                          <span>{project.year}년 · 현재 누적 집행액 {formatIntegerString(project.exec_text ?? '0')}원</span>
                        </div>
                        <label className="exec-amount-editor" onClick={(event) => event.stopPropagation()}>
                          <span>변경 후 누적 집행액(원)</span>
                          <input
                            className="exec-amount-input"
                            type="text"
                            inputMode="numeric"
                            aria-label={`${getProjectDisplayName(project)} 변경 후 누적 집행액(원)`}
                            value={formatExecInput(editing[project.id] ?? '')}
                            onChange={(event) => handleChange(project.id, event.currentTarget)}
                          />
                          <small>증감액이 아니라 저장 후의 누적 집행액을 원 단위로 입력합니다.</small>
                        </label>
                        <div className="inline-actions">
                          <button
                            className="small-btn"
                            type="button"
                            disabled={saving[project.id]}
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleSave(project);
                            }}
                          >{saving[project.id] ? '저장 중...' : '집행액 저장'}</button>
                          <button
                            className="small-btn"
                            type="button"
                            disabled={saving[project.id]}
                            onClick={(event) => {
                              event.stopPropagation();
                              cancelExecEdit(project.id);
                            }}
                          >취소</button>
                        </div>
                      </section>
                    </td>
                  </tr>
                )}
                {project.id === classificationProjectId && classificationProject && (
                  <tr className="classification-editor-row">
                    <td colSpan={11}>
                      <ProjectClassificationEditor
                        profile={profile}
                        project={classificationProject}
                        onClose={() => setClassificationProjectId(null)}
                        onSaved={handleClassificationSaved}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={11} className="empty-state">조건에 맞는 사업이 없습니다.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pagination" aria-label="사업 목록 페이지 이동">
        <span className="pagination-summary">
          전체 {totalCount.toLocaleString('ko-KR')}건 · {page.toLocaleString('ko-KR')} / {totalPages.toLocaleString('ko-KR')} 페이지
        </span>
        <div className="pagination-buttons">
          <button className="small-btn" type="button" onClick={() => setPage(1)} disabled={page === 1}>
            처음
          </button>
          <button className="small-btn" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>
            이전
          </button>
          <button className="small-btn" type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages}>
            다음
          </button>
          <button className="small-btn" type="button" onClick={() => setPage(totalPages)} disabled={page === totalPages}>
            마지막
          </button>
        </div>
      </div>
    </div>
  );
}
