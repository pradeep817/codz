import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { getMe } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/client';
import { SESSION_COOKIE } from '@/lib/auth/cookie';
import type { User } from '@/types/user';

export { SESSION_COOKIE };

const MAX_AGE = 60 * 60 * 24 * 30;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export async function setSession(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in user, or null. */
export async function getCurrentUser(): Promise<User | null> {
  if (!(await cookies()).get(SESSION_COOKIE)) return null;
  try {
    return await getMe();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/** For pages behind sign-in: the user, or a redirect to /login. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}
