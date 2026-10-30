import type { User } from '@/types/user';
import { apiFetch } from './client';

export function getUser(id: number): Promise<User> {
  return apiFetch<User>(`/users/${id}`);
}

export function updateUser(id: number, body: Partial<User>): Promise<User> {
  return apiFetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE /users/{id} */
export function deleteUser(id: number): Promise<void> {
  return apiFetch<void>(`/users/${id}`, { method: 'DELETE' });
}
