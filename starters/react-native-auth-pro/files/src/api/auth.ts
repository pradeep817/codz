import type { User } from '@/types/user';

import { api } from './client';

/** Change these paths to match your API. */
export async function postLogin(body: { email: string; password: string }): Promise<{ token: string; user: User }> {
  const res = await api.post<{ token: string; user: User }>(`/auth/login`, body);
  return res.data;
}

export async function getMe(): Promise<User> {
  const res = await api.get<User>(`/auth/me`);
  return res.data;
}

export async function postLogout(): Promise<void> {
  await api.post(`/auth/logout`);
}
