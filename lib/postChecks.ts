export type PostCheckSubjectType = 'PROJECT' | 'FUNDING_LINK' | 'BUDGET_CHANGE';
export type PostCheckStatus = 'REQUESTED' | 'REPLIED' | 'COMPLETED';

export type PostCheckRequest = {
  id: string;
  subject_type: PostCheckSubjectType;
  subject_id: string;
  project_id: string | null;
  project_name: string | null;
  region_id: string;
  region_name: string | null;
  fiscal_year: number | null;
  amount: string | null;
  status: PostCheckStatus;
  message: string;
  due_date: string | null;
  parent_request_id: string | null;
  requested_by: string;
  requested_at: string;
  replied_by: string | null;
  replied_at: string | null;
  reply_message: string | null;
  completed_by: string | null;
  completed_at: string | null;
  is_deleted?: boolean; // 삭제된 사업 확인요청 격리용 플래그
};

export type SystemNotification = {
  id: string;
  notification_type: 'POST_CHECK_REQUEST' | 'POST_CHECK_REPLY';
  title: string;
  body: string;
  action_href: string;
  related_post_check_id: string;
  read_at: string | null;
  created_at: string;
};

export type PostCheckCenter = {
  requests: PostCheckRequest[];
  notifications: SystemNotification[];
  unreadCount: number;
};

export const POST_CHECK_STATUS_LABELS: Record<PostCheckStatus, string> = {
  REQUESTED: '확인요청',
  REPLIED: '회신완료',
  COMPLETED: '확인완료',
};

export const POST_CHECK_SUBJECT_LABELS: Record<PostCheckSubjectType, string> = {
  PROJECT: '신규사업 등록',
  FUNDING_LINK: '예정재원 연결',
  BUDGET_CHANGE: '사업 예산연결',
};

export function normalizePostCheckRequest(row: Record<string, unknown>): PostCheckRequest {
  // DB의 삭제 관련 필드 감지 및 [삭제된 사업] 라벨 매칭
  const isDeleted = Boolean(
    row.is_deleted ||
    row.project_deleted ||
    row.deleted_at ||
    (typeof row.project_name === 'string' && row.project_name.includes('[삭제된 사업]'))
  );

  return {
    id: String(row.id),
    subject_type: row.subject_type as PostCheckSubjectType,
    subject_id: String(row.subject_id),
    project_id: row.project_id ? String(row.project_id) : null,
    project_name: row.project_name ? String(row.project_name) : null,
    region_id: String(row.region_id),
    region_name: row.region_name ? String(row.region_name) : null,
    fiscal_year: row.fiscal_year == null ? null : Number(row.fiscal_year),
    amount: row.amount == null ? null : String(row.amount),
    status: row.status as PostCheckStatus,
    message: String(row.message ?? ''),
    due_date: row.due_date ? String(row.due_date) : null,
    parent_request_id: row.parent_request_id ? String(row.parent_request_id) : null,
    requested_by: String(row.requested_by),
    requested_at: String(row.requested_at),
    replied_by: row.replied_by ? String(row.replied_by) : null,
    replied_at: row.replied_at ? String(row.replied_at) : null,
    reply_message: row.reply_message ? String(row.reply_message) : null,
    completed_by: row.completed_by ? String(row.completed_by) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    is_deleted: isDeleted,
  };
}

export function normalizeSystemNotification(row: Record<string, unknown>): SystemNotification {
  return {
    id: String(row.id),
    notification_type: row.notification_type as SystemNotification['notification_type'],
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    action_href: String(row.action_href ?? '/confirmations'),
    related_post_check_id: String(row.related_post_check_id),
    read_at: row.read_at ? String(row.read_at) : null,
    created_at: String(row.created_at),
  };
}
