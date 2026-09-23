import Link from 'next/link';

export default function DemoNavigation() {
  return (
    <header className="app-header demo-header">
      <div>
        <h1>지방소멸대응기금 사업관리시스템</h1>
        <p>공개 체험 데모 · 샘플 데이터만 표시하며 저장 기능은 제공하지 않습니다.</p>
      </div>
      <nav className="demo-navigation" aria-label="공개 데모 메뉴">
        <Link className="small-btn" href="/demo">대시보드</Link>
        <Link className="small-btn" href="/demo/analytics">통계·요구자료</Link>
      </nav>
    </header>
  );
}
