import { redirect } from 'next/navigation';
import { isPublicDemoMode } from '../../lib/demo-mode';

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  if (!isPublicDemoMode) redirect('/');
  return children;
}
