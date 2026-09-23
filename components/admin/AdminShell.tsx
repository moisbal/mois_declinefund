"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentSession, getCurrentUserProfile, UserProfile } from '../../lib/auth';
import CustomSmallCategoryReviewPanel from './CustomSmallCategoryReviewPanel';
import { formatUserFacingError } from '../../lib/presentationLabels';

type GeneratedAccount = {
  region_name: string | null;
  region_id: string;
  login_id: string;
  password: string;
  created_at: string;
};

export default function AdminShell() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [accounts, setAccounts] = useState<GeneratedAccount[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      const session = await getCurrentSession();
      if (!session.data.session?.user) {
        router.push('/');
        return;
      }

      const profileData = await getCurrentUserProfile();
      if (!profileData) {
        router.push('/');
        return;
      }
      if (profileData.first_login) {
        router.replace('/password-reset');
        return;
      }
      if (profileData.role !== 'admin') {
        router.push('/dashboard');
        return;
      }

      setProfile(profileData);
      setLoading(false);
    };

    initialize();
  }, [router]);

  const handleGenerateAccounts = async () => {
    setGenerating(true);
    setMessage(null);

    const session = await getCurrentSession();
    const accessToken = session.data.session?.access_token;
    if (!accessToken) {
      setMessage('세션이 만료되었습니다. 다시 로그인하세요.');
      setGenerating(false);
      return;
    }

    const response = await fetch('/api/admin/generate-accounts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const result = await response.json();
    if (!response.ok) {
      setMessage(formatUserFacingError(result, '계정 생성 중 오류가 발생했습니다.'));
      setGenerating(false);
      return;
    }

    setAccounts(result.accounts || []);
    if (result.failures?.length) {
      setMessage(`일부 계정 생성에 실패했습니다: ${result.failures.map((item: any) => (
        formatUserFacingError({ message: item.error }, '상세 원인은 관리자 로그를 확인해 주세요.')
      )).join(', ')}`);
    }
    setGenerating(false);
  };

  const downloadCsv = () => {
    if (!accounts.length) {
      setMessage('다운로드할 계정이 없습니다. 먼저 계정을 생성하세요.');
      return;
    }

    const header = ['지자체명', '지자체 식별값', '로그인 아이디', '초기 비밀번호', '생성일시'];
    const csvRows = [header.join(',')];
    accounts.forEach((account) => {
      csvRows.push([
        account.region_name ?? '',
        account.region_id,
        account.login_id,
        account.password,
        account.created_at,
      ]
        .map((field) => `"${String(field).replace(/"/g, '""')}"`)
        .join(','));
    });

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `region-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="panel">관리자 정보를 불러오는 중입니다...</div>;
  }

  return (
    <>
      <div className="panel">
        <div className="section-title">관리자 계정 관리</div>
        <p className="panel-sub">이 화면에서는 지자체 계정 일괄 생성과 초기 비밀번호 발급 파일 생성을 수행할 수 있습니다.</p>
        <button className="small-btn" onClick={handleGenerateAccounts} disabled={generating}>
          {generating ? '계정 생성 중...' : '지자체 계정 일괄 생성'}
        </button>
        <button className="small-btn" onClick={downloadCsv} disabled={!accounts.length} style={{ marginLeft: 12 }}>
          초기 비밀번호 다운로드
        </button>
        {message && <div className="toast-message">{message}</div>}

        {accounts.length > 0 && (
          <div className="table-scroll" style={{ marginTop: 18, maxHeight: 420 }}>
            <table>
              <thead>
                <tr>
                  <th>지자체명</th>
                  <th>지자체 식별값</th>
                  <th>로그인 아이디</th>
                  <th>초기 비밀번호</th>
                  <th>생성일</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={`${account.region_id}-${account.login_id}`}>
                    <td>{account.region_name}</td>
                    <td className="id-mono">{account.region_id}</td>
                    <td>{account.login_id}</td>
                    <td className="id-mono">{account.password}</td>
                    <td>{new Date(account.created_at).toLocaleString('ko-KR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <CustomSmallCategoryReviewPanel />
    </>
  );
}
