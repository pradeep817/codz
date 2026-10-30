import type { User } from "@/types/user";
import { apiFetch } from "./client";

/** GET /users/{id} */
export function getUser(id: number): Promise<User> {
  return apiFetch<User>(`/users/${id}`);
}
