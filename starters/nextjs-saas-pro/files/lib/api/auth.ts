import type { User } from '@/types/user';

import { apiFetch } from './client';

/** Change these paths to match your API. */
export function postLogin(body: { email: string; password: string }): Promise<{ token: string }> {
  return apiFetch<{ token: string }>('/auth/login', { method: 'POST', auth: false, body: JSON.stringify(body) });
}

export function postLogout(): Promise<void> {
  return apiFetch<void>('/auth/logout', { method: 'POST' });
}

export function getMe(): Promise<User> {
  return apiFetch<User>('/auth/me');
}

export function patchMe(body: { name: string }): Promise<User> {
  return apiFetch<User>('/auth/me', { method: 'PATCH', body: JSON.stringify(body) });
}
