import AdminShell from '../../components/admin/AdminShell';
import Header from '../../components/common/Header';

export default function AdminPage() {
  return (
    <div className="dashboard-shell admin-settings-shell">
      <Header title="관리자 설정" />
      <main><AdminShell /></main>
    </div>
  );
}
