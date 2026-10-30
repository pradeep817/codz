// Mock responses, used when NEXT_PUBLIC_USE_MOCKS=true.
// Managed by `codz mock add`; edit the values freely.
export const mockResponses: Record<string, unknown> = {
  // codz:614cb7cc0b
  'GET /users/{id}': {
    "id": "u9",
    "name": "Sample name 1"
  },
};

/** Returns the mock for a request, or undefined when there is none. */
export function findMock(method: string, path: string): unknown {
  const pathname = path.split('?')[0];
  for (const [key, value] of Object.entries(mockResponses)) {
    const [m, pattern] = key.split(' ');
    if (m !== method.toUpperCase()) continue;
    const want = pattern.split('/');
    const got = pathname.split('/');
    if (want.length === got.length && want.every((s, i) => /^\{[^/{}]+\}$/.test(s) || s === got[i])) return value;
  }
  return undefined;
}
