import axios, { AxiosError } from 'axios';

import { tokenStore } from '../auth/tokenStore';
import { API_URL } from '../config/env';

/** The axios instance every API function uses. It sends the stored token on every request. */
export const api = axios.create({
  baseURL: API_URL,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
});

api.interceptors.request.use(async (config) => {
  const token = await tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let onUnauthorized: (() => void) | null = null;

/** The auth provider registers this, so a 401 from any call signs the user out. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

api.interceptors.response.use(undefined, (error: AxiosError) => {
  if (error.response?.status === 401 && onUnauthorized) onUnauthorized();
  return Promise.reject(error);
});

/** A message for the user from any error an API call can throw. */
export function apiErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) return 'Something went wrong. Try again.';
  if (error.code === 'ECONNABORTED') return 'The server took too long to answer. Try again.';
  const status = error.response?.status;
  if (!status) return 'No connection. Check your internet and try again.';
  if (status === 401) return 'Please sign in again.';
  if (status === 403) return 'You do not have access to this.';
  if (status === 404) return 'Not found.';
  if (status === 400 || status === 422) return 'Check the details and try again.';
  if (status >= 500) return 'The server had a problem. Try again later.';
  return `Request failed (${status}).`;
}
