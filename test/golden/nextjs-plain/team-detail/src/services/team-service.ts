import type { TeamDetail } from "../models"

/** GET /v1/teams/{id} */
export async function getTeam(id: string): Promise<TeamDetail> {
  const res = await fetch(`${process.env.API_BASE_URL}/teams/${id}`, {
    method: "GET",
  })
  if (!res.ok) throw new Error(`getTeam failed: ${res.status}`)
  return (await res.json()) as TeamDetail
}
