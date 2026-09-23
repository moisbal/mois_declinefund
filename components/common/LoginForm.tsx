"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabaseClient';
import { getCurrentSessionWithRetry } from '../../lib/auth';
import { formatUserFacingError } from '../../lib/presentationLabels';
import {
  isTestLoginAliasEnabled,
  resolveTestLoginIdentifier,
} from '../../lib/testLoginAliases';

export default function LoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: resolveTestLoginIdentifier(identifier),
        password,
      });

      if (error) {
        setError(formatUserFacingError(error, '로그인하지 못했습니다. 입력한 계정 정보를 확인해 주세요.'));
        return;
      }
      if (!data.session?.user?.id || !data.session.access_token) {
        setError('로그인 정보가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }

      const readySession = await getCurrentSessionWithRetry(data.session.user.id);
      if (!readySession.data.session?.access_token) {
        setError('로그인 정보를 저장하지 못했습니다. 다시 로그인해 주세요.');
        return;
      }

      router.replace('/dashboard');
      router.refresh();
    } catch (loginError) {
      setError(formatUserFacingError(loginError, '로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-panel">
        <h1>지방소멸대응기금 대시보드</h1>
        <p>지자체 및 관리자 계정으로 로그인하세요.</p>
        <form onSubmit={handleSubmit}>
          <label>
            아이디 또는 이메일
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              required
            />
          </label>
          <label>
            비밀번호
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {isTestLoginAliasEnabled() && (
            <p className="login-test-hint">시험 환경에서는 발급된 간편 아이디 또는 기존 이메일을 사용할 수 있습니다.</p>
          )}
          <button type="submit" disabled={loading}>{loading ? '로그인 중...' : '로그인'}</button>
          {error && <p className="error-message">{error}</p>}
        </form>
      </div>
    </div>
  );
}
