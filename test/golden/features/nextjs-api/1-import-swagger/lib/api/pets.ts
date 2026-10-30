import type { Pet } from '@/types/pet';
import { apiFetch } from './client';

/** GET /api/pets */
export async function listPets(params?: { limit?: number }): Promise<Pet[]> {
  const searchParams = new URLSearchParams();
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
  const queryString = searchParams.toString();
  return apiFetch<Pet[]>(`/api/pets${queryString ? `?${queryString}` : ''}`);
}

/** POST /api/pets */
export function addPet(body: Pet): Promise<Pet> {
  return apiFetch<Pet>(`/api/pets`, { method: 'POST', body: JSON.stringify(body) });
}
