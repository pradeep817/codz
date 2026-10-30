import type { Contact } from '@/types/contact';
import { api } from './client';
import type { UpdateContactRequest } from '@/types/update-contact-request';
import type { UpdatedContact } from '@/types/updated-contact';

/** GET /contacts/{id} */
export async function getContact(id: number): Promise<Contact> {
  const res = await api.get<Contact>(`/contacts/${id}`);
  return res.data;
}

export async function deleteContact(id: number): Promise<void> {
  await api.delete(`/contacts/${id}`);
}

/** PATCH /v1/contacts/{id} */
export async function updateContact(id: number, body: UpdateContactRequest): Promise<UpdatedContact> {
  const res = await api.patch<UpdatedContact>(`/contacts/${id}`, body);
  return res.data;
}
