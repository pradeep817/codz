import type { Metadata } from 'next';

import { requireUser } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const user = await requireUser();
  return (
    <>
      <h1>Welcome, {user.name}</h1>
      <p className="muted">This page runs on the server, so it can call your API with apiFetch() and the signed-in user's token.</p>
      <section className="panel">
        <h2>Next steps</h2>
        <ol>
          <li>Run devtool init once.</li>
          <li>Add an endpoint: devtool api add (paste a cURL command).</li>
          <li>Add a page for it: devtool screen add orders --api getOrders.</li>
        </ol>
      </section>
    </>
  );
}
