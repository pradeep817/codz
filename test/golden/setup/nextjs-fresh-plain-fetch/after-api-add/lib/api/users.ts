import type { User } from "@/types/user";

/** GET /users/{id} */
export async function getUser(id: number): Promise<User> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/users/${id}`, {
    method: "GET",
  });
  if (!res.ok) throw new Error(`getUser failed: ${res.status}`);
  return (await res.json()) as User;
}
