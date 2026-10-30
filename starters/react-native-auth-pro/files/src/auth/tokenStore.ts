import * as SecureStore from 'expo-secure-store';

const KEY = 'auth_token';
let cached: string | null | undefined;

/** The API token, kept in the Keychain (iOS) or Keystore (Android), with an in-memory copy. */
export const tokenStore = {
  async get(): Promise<string | null> {
    if (cached === undefined) cached = await SecureStore.getItemAsync(KEY);
    return cached ?? null;
  },
  async set(token: string): Promise<void> {
    cached = token;
    await SecureStore.setItemAsync(KEY, token);
  },
  async clear(): Promise<void> {
    cached = null;
    await SecureStore.deleteItemAsync(KEY);
  },
};
