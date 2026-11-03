import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import type { ChannelPublic, User } from '../api/types';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anon' }
  | { status: 'error'; message: string }
  | { status: 'authed'; user: User; channel: ChannelPublic };

type AuthContextValue = {
  auth: AuthState;
  /** Re-reads `GET /api/auth/me`. Resolves with the new state. */
  refresh: () => Promise<AuthState>;
  logout: () => Promise<void>;
  /** Locally mark the session as gone (e.g. after a 401 from another endpoint). */
  markSignedOut: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadMe(): Promise<AuthState> {
  try {
    const me = await api.me();
    return { status: 'authed', user: me.user, channel: me.channel };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { status: 'anon' };
    return { status: 'error', message: errorMessage(err) };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    const next = await loadMe();
    setAuth(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuth({ status: 'anon' });
    }
  }, []);

  const markSignedOut = useCallback(() => setAuth({ status: 'anon' }), []);

  const value = useMemo(
    () => ({ auth, refresh, logout, markSignedOut }),
    [auth, refresh, logout, markSignedOut],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
