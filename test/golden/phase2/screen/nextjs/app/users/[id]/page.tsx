import { getUser } from '@/lib/api';

export default async function UserProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUser(Number(id));
  return (
    <main>
      <h1>User Profile</h1>
      <dl>
        <dt>id</dt>
        <dd>{String(user.id ?? '')}</dd>
        <dt>name</dt>
        <dd>{String(user.name ?? '')}</dd>
        <dt>email</dt>
        <dd>{String(user.email ?? '')}</dd>
      </dl>
    </main>
  );
}
