import type { Metadata } from 'next';

import LoginForm from '@/components/LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      <LoginForm next={next ?? '/dashboard'} />
    </>
  );
}
