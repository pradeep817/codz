import * as client from '../src/api/client';

// Imported under another name so devtool does not take this test for an API file.
const { ApiError, apiErrorMessage, apiFetch: request } = client;

const mockFetch = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('apiFetch', () => {
  it('parses JSON', async () => {
    global.fetch = mockFetch(200, { id: 1 }) as unknown as typeof fetch;
    await expect(request<{ id: number }>('/items/1')).resolves.toEqual({ id: 1 });
  });

  it('throws ApiError with the status and a readable message', async () => {
    global.fetch = mockFetch(503, { error: 'down' }) as unknown as typeof fetch;
    const err = await request('/items').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(apiErrorMessage(err)).toBe('The server had a problem. Try again later.');
  });
});
