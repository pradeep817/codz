'use client';

import { useContact } from '@/hooks/use-contact';

export default function UsersPage() {
  const { data } = useContact(1);
  return <p>{data?.name}</p>;
}
