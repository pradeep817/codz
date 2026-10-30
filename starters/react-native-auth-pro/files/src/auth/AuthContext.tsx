import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { getMe, postLogin, postLogout } from '../api/auth';
import { setUnauthorizedHandler } from '../api/client';
import { queryClient } from '../api/queryClient';
import type { User } from '../types/user';
import { tokenStore } from './tokenStore';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Restores the session at launch, and signs in and out. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);

  const signOut = useCallback(async () => {
    try {
      await postLogout();
    } catch {
      // Signed out on this phone either way.
    }
    await tokenStore.clear();
    queryClient.clear();
    setUser(null);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void tokenStore.clear();
      queryClient.clear();
      setUser(null);
      setStatus('signedOut');
    });
    (async () => {
      if (!(await tokenStore.get())) return setStatus('signedOut');
      try {
        setUser(await getMe());
        setStatus('signedIn');
      } catch {
        setStatus('signedOut');
      }
    })();
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { token, user: me } = await postLogin({ email, password });
    await tokenStore.set(token);
    setUser(me);
    setStatus('signedIn');
  }, []);

  const value = useMemo(() => ({ status, user, signIn, signOut }), [status, user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
