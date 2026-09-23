import { Suspense } from 'react';
import ConfirmationCenterShell from '../../components/confirmations/ConfirmationCenterShell';

export default function ConfirmationsPage() {
  return <Suspense fallback={<main className="confirmation-page"><p className="confirmation-empty">확인요청을 불러오는 중입니다.</p></main>}>
    <ConfirmationCenterShell />
  </Suspense>;
}
