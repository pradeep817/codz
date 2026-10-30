import { getUser } from '@/lib/api';
import { UserCard } from '@/components/user-card';

export default async function ProfilePage() {
  const user = await getUser(1);
  return <UserCard user={user} />;
}
