"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentSessionWithRetry, getCurrentTestAccountDisplayName, getProfileByUserId, signOut, UserProfile } from '../../lib/auth';
import { getPostCheckCenterAction } from '../../app/confirmations/actions';
import RightSidebarNavigation from './RightSidebarNavigation';

type HeaderProps = {
  title?: string;
};

export default function Header({ title = '지방소멸대응기금 대시보드' }: HeaderProps) {
  const router = useRouter();
  const [testAccountName, setTestAccountName] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [unreadConfirmations, setUnreadConfirmations] = useState(0);
  const isAdmin = profile?.role === 'admin';
  const accountLabel = testAccountName || profile?.region_name || (isAdmin ? '관리자' : '사용자');

  useEffect(() => {
    const load = async () => {
      try {
        const sessionResult = await getCurrentSessionWithRetry();
        const session = sessionResult.data.session;
        const [accountName, profileData] = await Promise.all([
          getCurrentTestAccountDisplayName(session),
          session?.user?.id ? getProfileByUserId(session.user.id) : Promise.resolve(null),
        ]);
        setTestAccountName(accountName || null);
        setProfile(profileData);
        const accessToken = session?.access_token;
        if (accessToken) {
          const confirmationResult = await getPostCheckCenterAction({ accessToken, unreadOnly: true });
          if (!confirmationResult.error) setUnreadConfirmations(confirmationResult.data?.unreadCount ?? 0);
        }
      } catch (error) {
        console.error('프로필 조회 오류', error);
      }
    };

    load();
  }, []);

  const handleLogout = async () => {
    await signOut();
    router.push('/');
  };

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner app-header-inner-sidebar">
        <div className="app-brand">
          <span>지방소멸대응기금</span>
          <strong>{title}</strong>
        </div>
        </div>
      </header>
      <RightSidebarNavigation
        role={profile?.role === 'admin' || profile?.role === 'local_user' ? profile.role : null}
        accountLabel={accountLabel}
        unreadConfirmations={unreadConfirmations}
        onLogout={handleLogout}
      />
    </>
  );
}
