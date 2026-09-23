import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '지방소멸대응기금 대시보드',
  description: '지방소멸대응기금 사업관리 대시보드',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
