import type { Contact } from '@/types/contact';
import { api } from './client';

/** GET /contacts/{id} */
export async function getContact(id: number): Promise<Contact> {
  const res = await api.get<Contact>(`/contacts/${id}`);
  return res.data;
}

export async function deleteContact(id: number): Promise<void> {
  await api.delete(`/contacts/${id}`);
}
