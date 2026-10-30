import { API_URL } from '../config/env';

/** Thrown when the API answers with a status outside 200-299, or cannot be reached (status 0). */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const TIMEOUT_MS = 20_000;

/** Calls the API and parses the JSON response. Add auth headers here. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers },
    });
  } catch (e) {
    throw new ApiError(0, e instanceof Error && e.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A message for the user from any error an API call can throw. */
export function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again.';
  if (error.status === 0) return error.message === 'timeout' ? 'The server took too long to answer. Try again.' : 'No connection. Check your internet and try again.';
  if (error.status === 401) return 'Please sign in again.';
  if (error.status === 404) return 'Not found.';
  if (error.status >= 500) return 'The server had a problem. Try again later.';
  return `Request failed (${error.status}).`;
}
