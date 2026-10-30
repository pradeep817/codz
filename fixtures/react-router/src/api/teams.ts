import { apiFetch } from './client';
import type { Team } from '../types/team';

/** GET /teams/{teamId} */
export async function getTeam(teamId: string): Promise<Team> {
  return apiFetch<Team>(`/teams/${teamId}`);
}
