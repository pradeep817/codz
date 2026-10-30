import Sidebar from '@/components/Sidebar';
import { logout } from '@/lib/auth/actions';
import { requireUser } from '@/lib/auth/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="shell">
      <Sidebar />
      <div className="content">
        <header className="topbar">
          <span className="muted">{user.email}</span>
          <form action={logout}>
            <button className="button secondary">Sign out</button>
          </form>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
