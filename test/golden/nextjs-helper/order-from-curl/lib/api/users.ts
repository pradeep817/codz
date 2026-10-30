import type { User } from '@/types/user';
import { apiFetch } from './client';
import type { CreateUserOrderRequest } from '@/types/create-user-order-request';
import type { Order } from '@/types/order';

export function getUser(id: number): Promise<User> {
  return apiFetch<User>(`/users/${id}`);
}

export function updateUser(id: number, body: Partial<User>): Promise<User> {
  return apiFetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/** POST /users/{userId}/orders */
export async function createUserOrder(userId: number, body: CreateUserOrderRequest, params?: { expand?: string }): Promise<Order> {
  const searchParams = new URLSearchParams();
  if (params?.expand !== undefined) searchParams.set('expand', String(params.expand));
  const queryString = searchParams.toString();
  const res = await apiFetch<{ data: Order }>(`/users/${userId}/orders${queryString ? `?${queryString}` : ''}`, { method: 'POST', body: JSON.stringify(body) });
  return res.data;
}
