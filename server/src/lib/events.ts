import { keys, redis } from './redis.ts';
import { log } from './log.ts';

// Channel event bus (Redis pub/sub). Payloads are small hints; API instances
// re-read authoritative state from Postgres (except cheap viewer updates).
export type ChannelEvent =
  | { kind: 'state' }
  | { kind: 'viewers'; broadcastId: string; viewers: number };

export async function publishChannelEvent(channelId: string, ev: ChannelEvent): Promise<void> {
  try {
    await redis.publish(keys.channelEvents(channelId), JSON.stringify(ev));
  } catch (err) {
    // Non-fatal: SSE clients still converge on the next state change.
    log.warn({ err: (err as Error).message, channelId }, 'event publish failed');
  }
}

// Overlay (OBS browser source) alerts: published per channel.
export type OverlayAlert = { type: 'follow'; displayName: string; at: string; test?: boolean };

export async function publishOverlayAlert(channelId: string, alert: OverlayAlert): Promise<void> {
  try {
    await redis.publish(keys.overlayEvents(channelId), JSON.stringify(alert));
  } catch (err) {
    log.warn({ err: (err as Error).message, channelId }, 'overlay publish failed');
  }
}
