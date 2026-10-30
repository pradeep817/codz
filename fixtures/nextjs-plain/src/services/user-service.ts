import type { User } from "../models"

export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`${process.env.API_BASE_URL}/users/${id}`, { method: "GET" })
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}
