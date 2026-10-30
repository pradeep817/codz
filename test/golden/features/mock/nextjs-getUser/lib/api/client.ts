import { findMock } from './mocks';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  // codz: mock responses
  if (process.env.NEXT_PUBLIC_USE_MOCKS === 'true') {
    const mock = findMock(init?.method ?? 'GET', path);
    if (mock !== undefined) return mock as T;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return (await res.json()) as T;
}
