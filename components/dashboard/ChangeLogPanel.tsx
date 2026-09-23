"use client";

import { useEffect, useState } from 'react';
import { getAuditActors, getProjectCategoryMaster, getProjectChangeLogs } from '../../lib/projects';
import type { AuditActor, AuditLogRow } from '../../lib/projects';
import type { UserProfile } from '../../lib/auth';
import { formatAuditAction, formatAuditFieldName, getAuditDisplayItems } from '../../lib/auditLogFormat';
import type { ProjectCategoryMaster } from '../../lib/projectClassification';
import { formatUserFacingError } from '../../lib/presentationLabels';

type ChangeLogPanelProps = {
  profile: UserProfile;
  projectId?: string;
  projectCode?: string;
  refreshVersion?: number;
};

function AuditValue({
  fieldName,
  value,
  master,
}: {
  fieldName: string | null;
  value: string | null;
  master: ProjectCategoryMaster | null;
}) {
  const items = getAuditDisplayItems(fieldName, value, master);
  return (
    <dl className="audit-value-card">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          {item.label && <dt>{item.label}</dt>}
          <dd className={item.isAmount ? 'audit-value-amount' : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function getAuditActorLabel(
  changedBy: string,
  actorsById: Record<string, AuditActor>,
  currentProfile: UserProfile,
) {
  const actor = changedBy === currentProfile.id ? currentProfile : actorsById[changedBy];
  const name = actor?.name?.trim();
  const label = name && !/[A-Za-z@]/.test(name)
    ? name
    : changedBy === currentProfile.id && currentProfile.region_name
      ? `${currentProfile.region_name} 담당자`
      : '사용자';
  if (label) return changedBy === currentProfile.id ? `${label} (나)` : label;
  return '사용자 정보 확인 불가';
}

export default function ChangeLogPanel({ profile, projectId, projectCode, refreshVersion = 0 }: ChangeLogPanelProps) {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [categoryMaster, setCategoryMaster] = useState<ProjectCategoryMaster | null>(null);
  const [actorsById, setActorsById] = useState<Record<string, AuditActor>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setLogs([]);
      setError(null);
      setLoading(false);
      setActorsById({});
      return;
    }

    const loadLogs = async () => {
      setLoading(true);
      setError(null);
      try {
        const [data, master] = await Promise.all([
          getProjectChangeLogs(projectId),
          getProjectCategoryMaster().catch(() => null),
        ]);
        const actors = await getAuditActors(data.map((log) => log.changed_by)).catch(() => []);
        setLogs(data);
        setCategoryMaster(master);
        setActorsById(Object.fromEntries(actors.map((actor) => [actor.id, actor])));
      } catch (err) {
        setError(formatUserFacingError(err, '변경 이력을 불러오는 중 오류가 발생했습니다.'));
      } finally {
        setLoading(false);
      }
    };

    loadLogs();
  }, [projectId, profile, refreshVersion]);

  return (
    <div className="panel">
      <div className="section-title">변경 이력</div>
      <p className="panel-sub">
        {projectId
          ? `${projectCode ?? '선택된 사업'}의 최근 수정 내역입니다.`
          : '사업 목록에서 사업을 선택하면 해당 사업의 수정 이력을 확인할 수 있습니다.'}
      </p>

      {loading && <div>변경 이력 로딩 중...</div>}
      {error && <div className="error-message">{error}</div>}

      {!loading && !error && projectId && (
        <div className="table-scroll" style={{ maxHeight: 360 }}>
          <table className="change-log-table">
            <thead>
              <tr>
                <th>변경일</th>
                <th>필드</th>
                <th>이전값</th>
                <th>변경값</th>
                <th>변경자</th>
                <th>유형</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{log.changed_at ? new Date(log.changed_at).toLocaleString('ko-KR') : '-'}</td>
                  <td>{formatAuditFieldName(log.field_name)}</td>
                  <td className="audit-value-cell">
                    <AuditValue fieldName={log.field_name} value={log.old_value} master={categoryMaster} />
                  </td>
                  <td className="audit-value-cell">
                    <AuditValue fieldName={log.field_name} value={log.new_value} master={categoryMaster} />
                  </td>
                  <td>{getAuditActorLabel(log.changed_by, actorsById, profile)}</td>
                  <td>{formatAuditAction(log.action)}</td>
                </tr>
              ))}
              {!logs.length && (
                <tr>
                  <td colSpan={6} className="empty-state">등록된 변경 이력이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
