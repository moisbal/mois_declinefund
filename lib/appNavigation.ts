export type AppNavigationRole = 'admin' | 'local_user';

export type AppNavigationIcon =
  | 'dashboard'
  | 'projects'
  | 'funding'
  | 'analytics'
  | 'confirmations'
  | 'changes'
  | 'settings'
  | 'categories'
  | 'cutover';

export type AppNavigationItem = {
  id: string;
  label: string;
  href: string;
  icon: AppNavigationIcon;
  match: 'exact' | 'prefix';
};

export type AppNavigationGroup = {
  id: string;
  label: string;
  items: AppNavigationItem[];
};

const dashboard: AppNavigationItem = {
  id: 'dashboard',
  label: '메인 대시보드',
  href: '/dashboard',
  icon: 'dashboard',
  match: 'exact',
};

const analytics: AppNavigationItem = {
  id: 'analytics',
  label: '통계·요구자료',
  href: '/analytics',
  icon: 'analytics',
  match: 'prefix',
};

const confirmations: AppNavigationItem = {
  id: 'confirmations',
  label: '확인요청',
  href: '/confirmations',
  icon: 'confirmations',
  match: 'prefix',
};

const localProjects: AppNavigationItem = {
  id: 'my-projects',
  label: '내 사업 관리',
  href: '/my-projects',
  icon: 'projects',
  match: 'prefix',
};

const funding: AppNavigationItem = {
  id: 'funding',
  label: '예산 조정',
  href: '/admin/funding',
  icon: 'funding',
  match: 'prefix',
};

const projectChanges: AppNavigationItem = {
  id: 'project-changes',
  label: '사업변경 관리',
  href: '/admin/project-changes',
  icon: 'changes',
  match: 'prefix',
};

const adminSettings: AppNavigationItem = {
  id: 'admin-settings',
  label: '관리자 설정',
  href: '/admin',
  icon: 'settings',
  match: 'exact',
};

const smallCategories: AppNavigationItem = {
  id: 'small-categories',
  label: '소분류 제안 관리',
  href: '/admin/small-category-proposals',
  icon: 'categories',
  match: 'prefix',
};

const ledgerCutover: AppNavigationItem = {
  id: 'ledger-cutover',
  label: '운영전환 관리',
  href: '/admin/ledger-cutover',
  icon: 'cutover',
  match: 'prefix',
};

export function getAppNavigationGroups(
  role: AppNavigationRole,
  financialLedgerEnabled: boolean,
): AppNavigationGroup[] {
  if (role === 'local_user') {
    return [
      { id: 'overview', label: '공통 조회', items: [dashboard, analytics, confirmations] },
      { id: 'local-work', label: '지자체 업무', items: [localProjects] },
    ];
  }

  return [
    { id: 'overview', label: '공통 조회', items: [dashboard, analytics, confirmations] },
    {
      id: 'admin-work',
      label: '관리자 업무',
      items: [
        ...(financialLedgerEnabled ? [funding] : []),
        projectChanges,
        smallCategories,
        adminSettings,
      ],
    },
    { id: 'operations', label: '운영 관리', items: [ledgerCutover] },
  ];
}

export function getPrimaryAppNavigation(
  role: AppNavigationRole,
  financialLedgerEnabled: boolean,
): AppNavigationItem[] {
  if (role === 'local_user') return [dashboard, localProjects, confirmations, analytics];
  return [
    dashboard,
    ...(financialLedgerEnabled ? [funding] : []),
    confirmations,
    projectChanges,
    analytics,
    adminSettings,
  ];
}

export function isAppNavigationItemActive(pathname: string, item: AppNavigationItem) {
  if (item.match === 'exact') return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
