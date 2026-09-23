"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '../common/Header';
import { getCurrentSessionWithRetry, getProfileByUserId, type UserProfile } from '../../lib/auth';
import { getProjectCategoryMaster, getProjectClassification } from '../../lib/projects';
import {
  getMyProjectDetail,
  getMyProjectDisplayName,
  saveMyProject,
  toRelatedProjectDrafts,
  type MyProjectDetail,
} from '../../lib/myProjects';
import { formatSystemTerm, formatUserFacingError } from '../../lib/presentationLabels';
import {
  emptyProjectClassificationDraft,
  validateProjectClassification,
  type ProjectCategoryMaster,
  type ProjectClassificationDraft,
} from '../../lib/projectClassification';
import {
  emptyProjectNameChangeDraft,
  validateProjectNameChange,
  type SimilarityRelationship,
} from '../../lib/projectChange';
import {
  getSimilarProjectCandidates,
  recordProjectSimilarityDecision,
  type SimilarProjectCandidate,
} from '../../lib/projectChanges';
import {
  countMyProjectDraftChanges,
  deriveOriginalAllocation,
  isProjectStatus,
  validateMyProjectEditDraft,
  type MyProjectEditDraft,
} from '../../lib/myProjectEdit';
import ProjectBasicInfoSection from './ProjectBasicInfoSection';
import ProjectClassificationSection from './ProjectClassificationSection';
import ProjectBusinessTypeSection from './ProjectBusinessTypeSection';
import ProjectBudgetSection from './ProjectBudgetSection';
import ProjectFinancialLedgerSection from './ProjectFinancialLedgerSection';
import ProjectFundingManagementSection from './ProjectFundingManagementSection';
import ProjectRelatedProjectsSection from './ProjectRelatedProjectsSection';
import SimilarProjectDialog from './SimilarProjectDialog';
import ProjectChangeHistoryPanel from './ProjectChangeHistoryPanel';
import { PageHeader, SectionNav, StatusBadge, StickyActionBar } from '../common/WorkUi';
import {
  getNewProjectDeletionEligibilityAction,
  type NewProjectDeletionEligibility,
} from '../../app/my-projects/workspace-actions';
import NewProjectDeleteDialog from './NewProjectDeleteDialog';

type MyProjectEditShellProps = {
  projectId: string;
};

function getStatusClass(status: string | null) {
  if (status === '완료') return 'complete';
  if (status === '지연' || status === '추진곤란') return 'warning';
  return 'normal';
}

function createEditDraft(project: MyProjectDetail, relatedProjects: MyProjectEditDraft['relatedProjects']): MyProjectEditDraft {
  const originalAlloc = deriveOriginalAllocation({
    originalAlloc: project.original_alloc_text,
    adjustedAlloc: project.alloc_text,
    increaseAmount: project.increase_amount_text,
    decreaseAmount: project.decrease_amount_text,
  });
  return {
    detailProjectName: getMyProjectDisplayName(project),
    nameChange: emptyProjectNameChangeDraft(),
    projectPeriod: project.project_period ?? project.period ?? '',
    projectStartYear: project.project_start_year ?? project.year,
    status: isProjectStatus(project.status) ? project.status : '정상추진',
    executionStatusReason: project.execution_status_reason ?? '',
    originalAlloc,
    increaseAmount: project.increase_amount_text ?? '0',
    decreaseAmount: project.decrease_amount_text ?? '0',
    exec: project.exec_text ?? '0',
    classification: emptyProjectClassificationDraft(),
    relatedProjects,
  };
}

export default function MyProjectEditShell({ projectId }: MyProjectEditShellProps) {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [project, setProject] = useState<MyProjectDetail | null>(null);
  const [master, setMaster] = useState<ProjectCategoryMaster | null>(null);
  const [draft, setDraft] = useState<MyProjectEditDraft | null>(null);
  const [classification, setClassification] = useState<ProjectClassificationDraft>(emptyProjectClassificationDraft);
  const [relatedProjectsEnabled, setRelatedProjectsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState<'DRAFT' | 'SAVE' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [ledgerManaged, setLedgerManaged] = useState(false);
  const [similarCandidates, setSimilarCandidates] = useState<SimilarProjectCandidate[]>([]);
  const [similarityName, setSimilarityName] = useState('');
  const [pendingSaveMode, setPendingSaveMode] = useState<'DRAFT' | 'SAVE' | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [deletionEligibility, setDeletionEligibility] = useState<NewProjectDeletionEligibility | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const financialLedgerEnabled = process.env.NEXT_PUBLIC_FINANCIAL_LEDGER_UI === 'true';
  const budgetSectionNumber = 4;
  const relatedProjectsSectionNumber = 5;

  useEffect(() => {
    const initialize = async () => {
      const sessionResult = await getCurrentSessionWithRetry();
      const session = sessionResult.data.session;
      if (!session?.user) {
        router.replace('/');
        return;
      }

      try {
        const profileData = await getProfileByUserId(session.user.id);
        if (!profileData) {
          router.replace('/');
          return;
        }
        if (profileData.first_login) {
          router.replace('/password-reset');
          return;
        }
        if (profileData.role !== 'local_user' || !profileData.region_id) {
          router.replace('/dashboard');
          return;
        }

        setAccessToken(session.access_token);

        const detail = await getMyProjectDetail(profileData, projectId);
        const [categoryMaster, projectClassification, deletionResult] = await Promise.all([
          getProjectCategoryMaster(),
          getProjectClassification(projectId),
          getNewProjectDeletionEligibilityAction({
            accessToken: session.access_token,
            targetKind: 'PROJECT',
            targetId: projectId,
          }),
        ]);
        const relatedProjects = toRelatedProjectDrafts(detail.relatedProjects);
        setProfile(profileData);
        setProject(detail.project);
        setMaster(categoryMaster);
        if (!('error' in deletionResult)) setDeletionEligibility(deletionResult.data);
        const initialDraft = createEditDraft(detail.project, relatedProjects);
        setDraft(initialDraft);
        setClassification(projectClassification);
        setRelatedProjectsEnabled(relatedProjects.length > 0);
        setSavedSnapshot(JSON.stringify({
          draft: initialDraft,
          classification: projectClassification,
          relatedProjectsEnabled: relatedProjects.length > 0,
        }));
        setLastSavedAt(detail.project.updated_at);
        const currentName = getMyProjectDisplayName(detail.project);
        try {
          const candidates = await getSimilarProjectCandidates(projectId, currentName);
          if (candidates.some((candidate) => candidate.shouldPrompt)) {
            setSimilarityName(currentName);
            setSimilarCandidates(candidates);
          }
        } catch {
          // Similarity guidance must never block the base metadata screen.
        }
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '사업 정보를 불러오지 못했습니다.'));
      } finally {
        setLoading(false);
      }
    };

    void initialize();
  }, [projectId, router]);

  const visibleDraft = useMemo(() => {
    if (!draft) {
      return null;
    }
    return relatedProjectsEnabled ? draft : { ...draft, relatedProjects: [] };
  }, [draft, relatedProjectsEnabled]);

  const currentSnapshot = useMemo(() => JSON.stringify({
    draft: visibleDraft,
    classification,
    relatedProjectsEnabled,
  }), [classification, relatedProjectsEnabled, visibleDraft]);
  const dirtyCount = useMemo(() => {
    if (!savedSnapshot || !visibleDraft) return 0;
    try {
      const saved = JSON.parse(savedSnapshot) as {
        draft: MyProjectEditDraft;
        classification: ProjectClassificationDraft;
        relatedProjectsEnabled: boolean;
      };
      let count = countMyProjectDraftChanges(visibleDraft, saved.draft, ledgerManaged);
      if (JSON.stringify(classification) !== JSON.stringify(saved.classification)) count += 1;
      if (relatedProjectsEnabled !== saved.relatedProjectsEnabled) count += 1;
      return count;
    } catch {
      return currentSnapshot === savedSnapshot ? 0 : 1;
    }
  }, [classification, currentSnapshot, ledgerManaged, relatedProjectsEnabled, savedSnapshot, visibleDraft]);

  const updateDraft = (changes: Partial<MyProjectEditDraft>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
    setError(null);
  };

  const applyFundingPosition = useCallback((position: {
    ledger_original_allocation: string;
    ledger_increase_amount: string;
    ledger_decrease_amount: string;
    ledger_execution_amount: string;
    projection_ready: boolean;
  }) => {
    setLedgerManaged(position.projection_ready);
    if (!position.projection_ready) return;

    setDraft((current) => current ? {
      ...current,
      originalAlloc: position.ledger_original_allocation,
      increaseAmount: position.ledger_increase_amount,
      decreaseAmount: position.ledger_decrease_amount,
      exec: position.ledger_execution_amount,
    } : current);
  }, []);

  const persist = async (saveMode: 'DRAFT' | 'SAVE', similarityCandidate = false) => {
    if (!profile || !project || !master || !visibleDraft) {
      return;
    }

    const formError = validateMyProjectEditDraft(visibleDraft, project.year);
    if (formError) {
      setError(formError);
      return;
    }
    const currentName = getMyProjectDisplayName(project);
    const nameChangeError = validateProjectNameChange(
      currentName,
      visibleDraft.detailProjectName,
      visibleDraft.nameChange,
    );
    if (nameChangeError) {
      setError(nameChangeError);
      return;
    }
    const classificationError = validateProjectClassification(master, classification);
    if (classificationError) {
      setError(classificationError);
      return;
    }

    setSavingMode(saveMode);
    setError(null);
    try {
      const currentDisplayName = getMyProjectDisplayName(project).trim();
      const currentRawDetailName = project.detail_project_name?.trim() ?? '';
      const preservesPresentationOnlyName = currentRawDetailName.length > 0
        && currentRawDetailName !== currentDisplayName
        && visibleDraft.detailProjectName.trim() === currentDisplayName;
      const persistedDraft = preservesPresentationOnlyName
        ? { ...visibleDraft, detailProjectName: currentRawDetailName }
        : visibleDraft;
      const saved = await saveMyProject(
        profile,
        projectId,
        persistedDraft,
        classification,
        saveMode,
        similarityCandidate,
      );
      setLastSavedAt(saved.updated_at);
      setProject((current) => current ? {
        ...current,
        detail_project_name: persistedDraft.detailProjectName,
        project_period: visibleDraft.projectPeriod,
        project_start_year: visibleDraft.projectStartYear,
        status: visibleDraft.status,
        execution_status_reason: visibleDraft.status === '지연' || visibleDraft.status === '추진곤란'
          ? visibleDraft.executionStatusReason.trim()
          : null,
        ...(saved.ledgerManaged ? {} : {
          original_alloc_text: visibleDraft.originalAlloc,
          increase_amount_text: visibleDraft.increaseAmount,
          decrease_amount_text: visibleDraft.decreaseAmount,
          alloc_text: String(saved.alloc),
          exec_text: String(saved.exec),
          rate: saved.rate,
        }),
        updated_at: saved.updated_at,
      } : current);
      setDraft((current) => current ? { ...current, nameChange: emptyProjectNameChangeDraft() } : current);
      setSavedSnapshot(JSON.stringify({
        draft: { ...visibleDraft, nameChange: emptyProjectNameChangeDraft() },
        classification,
        relatedProjectsEnabled,
      }));
    } catch (saveError) {
      setError(formatUserFacingError(saveError, '사업 정보를 저장하지 못했습니다.'));
    } finally {
      setSavingMode(null);
    }
  };

  const save = async (saveMode: 'DRAFT' | 'SAVE') => {
    if (!project || !visibleDraft) return;
    const currentName = getMyProjectDisplayName(project);
    if (visibleDraft.detailProjectName.trim() !== currentName.trim()) {
      try {
        const candidates = await getSimilarProjectCandidates(projectId, visibleDraft.detailProjectName);
        if (candidates.length > 0 && candidates.some((candidate) => candidate.shouldPrompt)) {
          setSimilarityName(visibleDraft.detailProjectName.trim());
          setSimilarCandidates(candidates);
          setPendingSaveMode(saveMode);
          return;
        }
        await persist(saveMode, candidates.length > 0);
        return;
      } catch (candidateError) {
        setError(formatUserFacingError(candidateError, '유사사업 후보를 확인하지 못했습니다.'));
        return;
      }
    }
    await persist(saveMode, false);
  };

  const decideSimilarity = async (
    relationshipType: SimilarityRelationship,
    candidate: SimilarProjectCandidate | null,
  ) => {
    const candidateSetHash = similarCandidates[0]?.candidateSetHash;
    if (!candidateSetHash || !project) return;
    try {
      await recordProjectSimilarityDecision({
        projectId,
        sourceProjectName: similarityName,
        candidateSetHash,
        candidateProjectId: candidate?.candidateProjectId ?? null,
        similarity: candidate?.similarityScore ?? null,
        relationshipType,
      });
      const saveMode = pendingSaveMode;
      setSimilarCandidates([]);
      setPendingSaveMode(null);
      if (saveMode) await persist(saveMode, true);
    } catch (decisionError) {
      setError(formatUserFacingError(decisionError, '유사사업 관계 판단을 저장하지 못했습니다.'));
    }
  };

  if (loading) {
    return <div className="loading-shell">사업 입력 화면을 준비하는 중입니다...</div>;
  }
  if (!profile || !project || !master || !draft) {
    return (
      <div className="loading-shell">
        <div>{error || '사업을 찾을 수 없거나 접근 권한이 없습니다.'}</div>
        <button type="button" className="small-btn" onClick={() => router.replace('/my-projects')}>내 사업 목록으로</button>
      </div>
    );
  }

  return (
    <div className="dashboard-shell my-project-edit-shell">
      <Header title="내 사업 관리" />
      <main className="my-project-edit-main" aria-busy={savingMode !== null}>
        <PageHeader
          eyebrow={`${project.year ?? '-'}년 사업`}
          title={getMyProjectDisplayName(project)}
          description="사업정보, 분류, 예산·집행, 변경·연계 이력을 한 화면에서 관리합니다."
          meta={<StatusBadge label={formatSystemTerm(draft.status)} tone={getStatusClass(draft.status) === 'warning' ? 'warning' : getStatusClass(draft.status) === 'complete' ? 'info' : 'success'} />}
          actions={<>
            {deletionEligibility && !deletionEligibility.reason?.includes('Legacy') && <button
              type="button"
              className="danger-outline-button"
              onClick={() => setDeleteDialogOpen(true)}
              aria-label={`${getMyProjectDisplayName(project)} 신규사업 삭제`}
            >신규사업 삭제</button>}
            <button
              type="button"
              className="my-project-back-button"
              onClick={() => router.push('/my-projects')}
              aria-label="내 사업 목록으로 돌아가기"
            >
              <span aria-hidden="true">←</span>
              <span>목록으로</span>
            </button>
          </>}
        />
        <SectionNav items={[
          { href: '#project-basic', label: '기본정보' },
          { href: '#project-classification', label: '사업분류' },
          { href: '#project-budget', label: '예산·집행' },
          { href: '#project-change', label: '예산조정' },
          { href: '#project-related', label: '연계사업' },
          { href: '#project-history', label: '변경이력' },
        ]} />

        <div id="project-basic"><ProjectBasicInfoSection
          draft={draft}
          currentProjectName={getMyProjectDisplayName(project)}
          projectYear={project.year}
          onChange={updateDraft}
        /></div>
        <div id="project-classification"><ProjectClassificationSection
          projectId={projectId}
          master={master}
          draft={classification}
          onChange={(nextClassification) => {
            setClassification(nextClassification);
            setError(null);
          }}
        /></div>
        <ProjectBusinessTypeSection
          value={classification.businessType}
          onChange={(businessType) => {
            setClassification((current) => ({ ...current, businessType }));
            setError(null);
          }}
        />
        <div id="project-budget"><ProjectBudgetSection
          draft={draft}
          totalBudget={project.total_budget_text}
          onChange={updateDraft}
          ledgerManaged={ledgerManaged}
          sectionNumber={budgetSectionNumber}
        >
          {financialLedgerEnabled && (
            <ProjectFinancialLedgerSection
              projectId={projectId}
              onLedgerManagedChange={setLedgerManaged}
              onFundingPositionChange={applyFundingPosition}
              embedded
            />
          )}
          {financialLedgerEnabled && (
            <div id="project-change"><ProjectFundingManagementSection
              projectId={projectId}
              currentProjectYear={project.year ?? undefined}
              currentProjectName={getMyProjectDisplayName(project)}
              onFundingPositionChange={applyFundingPosition}
            /></div>
          )}
        </ProjectBudgetSection></div>
        <div id="project-related"><ProjectRelatedProjectsSection
          enabled={relatedProjectsEnabled}
          rows={draft.relatedProjects}
          onEnabledChange={setRelatedProjectsEnabled}
          onRowsChange={(relatedProjects) => updateDraft({ relatedProjects })}
          sectionNumber={relatedProjectsSectionNumber}
        /></div>
        <div id="project-history"><ProjectChangeHistoryPanel projectId={projectId} sectionNumber={6} /></div>

        {error && <div className="my-project-save-error" role="alert">{error}</div>}
      </main>

      <StickyActionBar
        status={<><strong>{savingMode ? '저장 중' : dirtyCount > 0 ? `미저장 변경 ${dirtyCount}건` : '모든 변경 저장됨'}</strong><span>마지막 저장 {lastSavedAt ? new Date(lastSavedAt).toLocaleString('ko-KR') : '-'}</span></>}
        actions={<>
          <button type="button" className="small-btn" onClick={() => void save('DRAFT')} disabled={savingMode !== null}>임시저장</button>
          <button type="button" className="my-project-save-button" onClick={() => void save('SAVE')} disabled={savingMode !== null}>저장</button>
        </>}
      />
      {deleteDialogOpen && accessToken && deletionEligibility && <NewProjectDeleteDialog
        accessToken={accessToken}
        targetKind="PROJECT"
        targetId={projectId}
        fallbackName={getMyProjectDisplayName(project)}
        fallbackYear={project.year ?? new Date().getFullYear()}
        onCancel={() => setDeleteDialogOpen(false)}
        onDeleted={() => {
          setDeleteDialogOpen(false);
          router.replace('/my-projects');
        }}
      />}
      {similarCandidates.length > 0 && (
        <SimilarProjectDialog
          candidates={similarCandidates}
          sourceProjectName={similarityName}
          onDecision={(relationship, candidate) => void decideSimilarity(relationship, candidate)}
          onClose={() => {
            setSimilarCandidates([]);
            setPendingSaveMode(null);
          }}
        />
      )}
    </div>
  );
}
