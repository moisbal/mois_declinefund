"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MouseEvent, ReactNode, useEffect, useRef, useState } from 'react';
import {
  AppNavigationIcon,
  AppNavigationItem,
  AppNavigationRole,
  getAppNavigationGroups,
  getPrimaryAppNavigation,
  isAppNavigationItemActive,
} from '../../lib/appNavigation';

type RightSidebarNavigationProps = {
  role: AppNavigationRole | null;
  accountLabel: string;
  unreadConfirmations: number;
  onLogout: () => Promise<void>;
};

const financialLedgerEnabled = process.env.NEXT_PUBLIC_FINANCIAL_LEDGER_UI === 'true';

function LineIcon({ name }: { name: AppNavigationIcon | 'menu' | 'user' | 'logout' | 'close' | 'password' }) {
  const common = {
    width: 28,
    height: 28,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  const paths: Record<typeof name, ReactNode> = {
    menu: <><path d="M4 6h16M4 12h16M4 18h11" /><path d="m17 16 2 2 3-4" /></>,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20c.7-4 3-6 6.5-6s5.8 2 6.5 6" /></>,
    logout: <><path d="M10 5H5v14h5" /><path d="M13 8l4 4-4 4M8 12h9" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    password: <><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></>,
    dashboard: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    projects: <><path d="M3.5 7.5h6l2-2h9v14h-17z" /><path d="M3.5 10h17" /></>,
    funding: <><circle cx="12" cy="12" r="8" /><path d="M8.5 9.5h5a2 2 0 0 1 0 4h-3a2 2 0 0 0 0 4h5M12 6.5v11" /></>,
    analytics: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    confirmations: <><path d="M5 4h14v13H9l-4 3z" /><path d="m8 10 2.4 2.4L16 7" /></>,
    changes: <><path d="M7 7h11l-3-3M17 17H6l3 3" /><path d="m18 7-3 3M6 17l3-3" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.4 3h-4l-.4 3.1a8 8 0 0 0-1.8 1l-2.4-1-2 3.4L5.9 11a7 7 0 0 0 0 2l-2.1 1.5 2 3.4 2.4-1a8 8 0 0 0 1.8 1l.4 3.1h4l.4-3.1a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z" /></>,
    categories: <><path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v5H4z" /><path d="M14 17.5h6M17 14.5v6" /></>,
    cutover: <><path d="M5 4h14v5H5zM5 15h14v5H5z" /><path d="m9 12 3 3 3-3M12 9v6" /></>,
  };

  return <svg {...common}>{paths[name]}</svg>;
}

function NavigationLink({
  item,
  pathname,
  unreadConfirmations,
  compact = false,
  onNavigate,
}: {
  item: AppNavigationItem;
  pathname: string;
  unreadConfirmations: number;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const active = isAppNavigationItemActive(pathname, item);
  return (
    <Link
      href={item.href}
      className={`${compact ? 'right-sidebar-link' : 'right-sidebar-panel-link'}${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={compact ? item.label : undefined}
      onClick={onNavigate}
    >
      <LineIcon name={item.icon} />
      <span className="right-sidebar-item-label">{item.label}</span>
      {item.id === 'confirmations' && unreadConfirmations > 0 && (
        <span className="right-sidebar-badge" aria-label={`읽지 않은 확인요청 알림 ${unreadConfirmations}개`}>
          {unreadConfirmations > 99 ? '99+' : unreadConfirmations}
        </span>
      )}
    </Link>
  );
}

export default function RightSidebarNavigation({ role, accountLabel, unreadConfirmations, onLogout }: RightSidebarNavigationProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const groups = role ? getAppNavigationGroups(role, financialLedgerEnabled) : [];
  const primaryItems = role ? getPrimaryAppNavigation(role, financialLedgerEnabled) : [];

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        returnFocusRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const openPanel = (event: MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = event.currentTarget;
    setOpen(true);
  };

  const closePanel = () => {
    setOpen(false);
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <>
      <button type="button" className="mobile-navigation-trigger" aria-label="전체메뉴 열기" aria-controls="app-full-navigation" aria-expanded={open} onClick={openPanel}>
        <LineIcon name="menu" />
        <span>메뉴</span>
      </button>

      <aside className="app-right-sidebar" data-testid="right-sidebar-navigation" data-role={role ?? 'loading'} aria-label="주요 업무 메뉴">
        <button type="button" className="right-sidebar-all-menu" aria-controls="app-full-navigation" aria-expanded={open} onClick={openPanel}>
          <LineIcon name="menu" />
          <span>전체메뉴</span>
        </button>

        <nav className="right-sidebar-primary" aria-label="계정별 주요 업무">
          {primaryItems.map((item) => <NavigationLink key={item.id} item={item} pathname={pathname} unreadConfirmations={unreadConfirmations} compact />)}
          {!role && <span className="right-sidebar-loading">메뉴 확인 중</span>}
        </nav>

        <div className="right-sidebar-account-area">
          <div className="right-sidebar-account" title={accountLabel}><LineIcon name="user" /><span>{accountLabel}</span></div>
          <Link className="right-sidebar-password" href="/password-reset"><LineIcon name="password" /><span>비밀번호 변경</span></Link>
          <button type="button" className="right-sidebar-logout" onClick={() => void handleLogout()} disabled={loggingOut}><LineIcon name="logout" /><span>{loggingOut ? '로그아웃 중' : '로그아웃'}</span></button>
        </div>
      </aside>

      {open && <>
        <button type="button" className="right-sidebar-overlay" aria-label="전체메뉴 바깥 영역 닫기" onClick={closePanel} />
        <section id="app-full-navigation" className="right-sidebar-panel" role="dialog" aria-modal="true" aria-label="전체메뉴">
          <header className="right-sidebar-panel-header">
            <div><strong>전체메뉴</strong><span>{role === 'admin' ? '관리자 업무' : role === 'local_user' ? '지자체 업무' : '권한 확인 중'}</span></div>
            <button ref={closeButtonRef} type="button" aria-label="전체메뉴 닫기" onClick={closePanel}><LineIcon name="close" /></button>
          </header>
          <div className="right-sidebar-panel-scroll">
            {groups.map((group) => <section className="right-sidebar-panel-group" key={group.id} aria-labelledby={`navigation-group-${group.id}`}>
              <h2 id={`navigation-group-${group.id}`}>{group.label}</h2>
              <nav aria-label={group.label}>{group.items.map((item) => <NavigationLink key={item.id} item={item} pathname={pathname} unreadConfirmations={unreadConfirmations} onNavigate={() => setOpen(false)} />)}</nav>
            </section>)}
          </div>
          <footer className="right-sidebar-panel-footer">
            <div title={accountLabel}><LineIcon name="user" /><span>{accountLabel}</span></div>
            <Link href="/password-reset" onClick={() => setOpen(false)}><LineIcon name="password" /><span>비밀번호 변경</span></Link>
            <button type="button" onClick={() => void handleLogout()} disabled={loggingOut}><LineIcon name="logout" /><span>{loggingOut ? '로그아웃 중' : '로그아웃'}</span></button>
          </footer>
        </section>
      </>}
    </>
  );
}
