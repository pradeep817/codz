'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { patchMe, postLogin, postLogout } from '@/lib/api/auth';
import { apiErrorMessage, ApiError } from '@/lib/api/client';
import { clearSession, setSession } from '@/lib/auth/session';

export interface FormState {
  error?: string;
  saved?: boolean;
}

/** Signs in with the API and keeps the token in an HttpOnly cookie. */
export async function login(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.' };
  try {
    const { token } = await postLogin({ email, password });
    await setSession(token);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 400)) return { error: 'That email and password do not match.' };
    return { error: apiErrorMessage(e) };
  }
  const next = String(form.get('next') ?? '');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
}

export async function logout(): Promise<void> {
  try {
    await postLogout();
  } catch {
    // The cookie is removed either way.
  }
  await clearSession();
  redirect('/login');
}

/** Saves the profile. */
export async function updateProfile(_prev: FormState, form: FormData): Promise<FormState> {
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: 'Enter your name.' };
  try {
    await patchMe({ name });
  } catch (e) {
    return { error: apiErrorMessage(e) };
  }
  revalidatePath('/', 'layout');
  return { saved: true };
}
