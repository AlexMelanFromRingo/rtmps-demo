import type { LiveInfo } from '../api/types';

export type BroadcastState = 'live' | 'reconnecting' | 'starting' | 'offline';

/** Folds LiveInfo into the four states the UI distinguishes. */
export function broadcastState(live: LiveInfo | null | undefined): BroadcastState {
  if (!live) return 'offline';
  if (live.status === 'reconnecting') return 'reconnecting';
  return live.playbackUrl ? 'live' : 'starting';
}

const LABELS: Record<BroadcastState, string> = {
  live: 'В эфире',
  reconnecting: 'Переподключение',
  starting: 'Запуск эфира',
  offline: 'Не в эфире',
};

const TONE: Record<BroadcastState, string> = {
  live: 'status--live',
  reconnecting: 'status--standby',
  starting: 'status--standby',
  offline: 'status--offline',
};

export function StatusBadge({
  state,
  size = 'md',
  label,
}: {
  state: BroadcastState;
  size?: 'md' | 'lg';
  label?: string;
}) {
  return (
    <span className={`status ${TONE[state]}${size === 'lg' ? ' status--lg' : ''}`}>
      <span className="status__dot" aria-hidden="true" />
      {label ?? LABELS[state]}
    </span>
  );
}
