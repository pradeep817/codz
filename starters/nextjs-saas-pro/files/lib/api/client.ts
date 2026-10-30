import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/lib/auth/cookie';

const BASE_URL = process.env.API_URL ?? '{{apiBaseUrl}}';

/** Thrown when the API answers with a status outside 200-299, or cannot be reached (status 0). */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Calls the API from the server (server components, server actions and route handlers) and parses the JSON.
 * The signed-in user's token is sent as a Bearer header; pass `auth: false` for public endpoints.
 */
export async function apiFetch<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const { auth = true, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Accept', 'application/json');
  if (rest.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (auth) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { cache: 'no-store', ...rest, headers });
  } catch {
    throw new ApiError(0, 'The API could not be reached.');
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A message for the user from any error an API call can throw. */
export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.status === 0) return 'The server could not be reached. Try again.';
  if (error.status === 401) return 'Your session ended. Sign in again.';
  if (error.status === 403) return 'You do not have access to this.';
  if (error.status === 404) return 'Not found.';
  if (error.status === 422 || error.status === 400) return 'Check the details and try again.';
  if (error.status >= 500) return 'The server had a problem. Try again later.';
  return `Request failed (${error.status}).`;
}
