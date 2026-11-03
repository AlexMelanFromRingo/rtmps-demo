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
