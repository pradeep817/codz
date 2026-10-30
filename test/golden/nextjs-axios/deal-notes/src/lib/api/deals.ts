import type { Note } from '@/types/note';
import { api } from './client';

/** GET /v1/deals/{dealId}/notes */
export async function getDealNotes(dealId: string, params?: { page?: number }): Promise<Note[]> {
  const res = await api.get<Note[]>(`/deals/${dealId}/notes`, { params });
  return res.data;
}
