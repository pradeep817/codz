import type { User } from '@/types/user';

export function UserCard({ user }: { user: User }) {
  return <div>{user.name}</div>;
}
