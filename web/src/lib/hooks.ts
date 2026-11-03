import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isAbortError } from '../api/client';

function subscribeVisibility(cb: () => void) {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

/** true while the tab is visible. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

/** Current timestamp, re-rendering every `intervalMs` while enabled. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Keep a ref pointing at the latest value (for callbacks used inside long-lived effects). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export type PollState<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  updatedAt: number | null;
};

/**
 * Fetch immediately, then every `intervalMs` after each request settles (no overlap).
 * Pauses while the tab is hidden and refetches as soon as it becomes visible again.
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  opts: { enabled?: boolean; pauseWhenHidden?: boolean } = {},
) {
  const enabled = opts.enabled ?? true;
  const pauseWhenHidden = opts.pauseWhenHidden ?? true;
  const visible = useDocumentVisible();
  const fetcherRef = useLatest(fetcher);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    loading: true,
    updatedAt: null,
  });

  const active = enabled && (!pauseWhenHidden || visible);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    let ctrl: AbortController | null = null;

    const tick = async () => {
      ctrl = new AbortController();
      try {
        const data = await fetcherRef.current(ctrl.signal);
        if (cancelled) return;
        setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (err) {
        if (cancelled || isAbortError(err)) return;
        setState((s) => ({ ...s, error: err, loading: false }));
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), intervalMs);
    };
    void tick();

    return () => {
      cancelled = true;
      ctrl?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, intervalMs, nonce, fetcherRef]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback(
    (updater: (prev: T | null) => T | null) => setState((s) => ({ ...s, data: updater(s.data) })),
    [],
  );

  return { ...state, refresh, mutate };
}

export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} — StreamHub` : 'StreamHub';
  }, [title]);
}

/** Matches a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** `value`, updated only after it has been stable for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export type ResourceState<T> = {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  mutate: (updater: (prev: T | null) => T | null) => void;
};

/**
 * One-shot fetch that re-runs when `key` changes (and on `reload()`), aborting stale requests.
 * Keeps the previous data while reloading so lists don't flash.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  key: string,
  enabled = true,
): ResourceState<T> {
  const fetcherRef = useLatest(fetcher);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean; key: string }>({
    data: null,
    error: null,
    loading: enabled,
    key,
  });

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setState((s) => ({ data: s.key === key ? s.data : null, error: null, loading: true, key }));
    fetcherRef.current(ctrl.signal).then(
      (data) => setState({ data, error: null, loading: false, key }),
      (err: unknown) => {
        if (isAbortError(err)) return;
        setState((s) => ({ ...s, error: err, loading: false }));
      },
    );
    return () => ctrl.abort();
  }, [key, nonce, enabled, fetcherRef]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback(
    (updater: (prev: T | null) => T | null) => setState((s) => ({ ...s, data: updater(s.data) })),
    [],
  );
  const stale = state.key !== key;
  return {
    data: stale ? null : state.data,
    error: stale ? null : state.error,
    loading: stale ? enabled : state.loading,
    reload,
    mutate,
  };
}
