"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentSession, getCurrentUserProfile, updateUserPassword, setFirstLoginComplete } from '../../lib/auth';
import { formatUserFacingError } from '../../lib/presentationLabels';

export default function PasswordResetPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profileFirstLogin, setProfileFirstLogin] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      const session = await getCurrentSession();
      if (!session.data.session?.user) {
        router.replace('/');
        return;
      }

      const profile = await getCurrentUserProfile();
      if (!profile) {
        router.replace('/');
        return;
      }

      setProfileFirstLogin(profile.first_login ?? false);
      setLoading(false);
    };

    initialize();
  }, [router]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password.length < 10) {
      setError('비밀번호는 최소 10자 이상이어야 합니다.');
      return;
    }
    if (password !== confirmPassword) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }

    setSaving(true);
    try {
      const response = await updateUserPassword(password);
      if (response.error) {
        setError(formatUserFacingError(response.error, '비밀번호를 변경하지 못했습니다.'));
        setSaving(false);
        return;
      }

      const session = await getCurrentSession();
      const userId = session.data.session?.user?.id;
      if (!userId) {
        setError('사용자 세션을 찾을 수 없습니다. 다시 로그인하세요.');
        setSaving(false);
        return;
      }

      if (profileFirstLogin) {
        await setFirstLoginComplete(userId);
      }
      router.push('/dashboard');
    } catch (err) {
      setError(formatUserFacingError(err, '비밀번호 변경 중 오류가 발생했습니다.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="panel">비밀번호 변경 페이지를 준비 중입니다...</div>;
  }

  return (
    <div className="login-shell">
      <div className="login-panel">
        <h1>{profileFirstLogin ? '최초 비밀번호 변경' : '비밀번호 변경'}</h1>
        <p>
          {profileFirstLogin
            ? '보안을 위해 초기 비밀번호를 변경해주세요.'
            : '사용할 새 비밀번호를 입력해주세요.'}
        </p>
        <form onSubmit={handleSubmit}>
          <label>
            새 비밀번호
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            비밀번호 확인
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <button type="submit" className="small-btn" disabled={saving}>
            {saving ? '저장 중...' : '비밀번호 변경'}
          </button>
          {error && <p className="error-message">{error}</p>}
        </form>
      </div>
    </div>
  );
}
