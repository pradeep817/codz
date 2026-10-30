import { AxiosError, AxiosHeaders } from 'axios';

import { apiErrorMessage } from '../src/api/client';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));

const httpError = (status: number) =>
  new AxiosError('failed', String(status), undefined, undefined, { status, statusText: '', headers: {}, config: { headers: new AxiosHeaders() }, data: null });

describe('apiErrorMessage', () => {
  it('turns statuses into messages for people', () => {
    expect(apiErrorMessage(httpError(401))).toBe('Please sign in again.');
    expect(apiErrorMessage(httpError(503))).toBe('The server had a problem. Try again later.');
  });

  it('explains a missing connection', () => {
    expect(apiErrorMessage(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe('No connection. Check your internet and try again.');
  });
});
