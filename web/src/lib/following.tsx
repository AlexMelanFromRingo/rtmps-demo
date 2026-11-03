import { createContext, use, useEffect, useMemo, type ReactNode } from 'react';
import { api } from '../api/client';
import type { ChannelWithLive } from '../api/types';
import { useAuth } from './auth';
import { usePolling } from './hooks';

const POLL_MS = 60_000;

type FollowingContextValue = {
  /** false for anonymous visitors (nothing to show). */
  enabled: boolean;
  /** Live first (by viewers), then the rest — as the API sorts them. null until loaded. */
  entries: ChannelWithLive[] | null;
  live: ChannelWithLive[];
  error: unknown;
  /** Re-fetch now (after follow/unfollow). */
  refresh: () => void;
};

const FollowingContext = createContext<FollowingContextValue | null>(null);

/** Followed channels for the sidebar, the drawer and /following; polled once a minute. */
export function FollowingProvider({ children }: { children: ReactNode }) {
  const { auth } = useAuth();
  const userId = auth.status === 'authed' ? auth.user.id : null;
  const poll = usePolling((signal) => api.following(signal), POLL_MS, { enabled: userId !== null });
  const { mutate, refresh } = poll;

  // Never show one account's follows to the next one.
  useEffect(() => {
    mutate(() => null);
  }, [userId, mutate]);

  const entries = userId ? (poll.data?.channels ?? null) : null;
  const value = useMemo<FollowingContextValue>(
    () => ({
      enabled: userId !== null,
      entries,
      live: entries?.filter((e) => e.live !== null) ?? [],
      error: poll.error,
      refresh,
    }),
    [userId, entries, poll.error, refresh],
  );
  return <FollowingContext value={value}>{children}</FollowingContext>;
}

export function useFollowing(): FollowingContextValue {
  const ctx = use(FollowingContext);
  if (!ctx) throw new Error('useFollowing must be used inside <FollowingProvider>');
  return ctx;
}
