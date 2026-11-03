// SSE hub for OBS browser-source overlays: follow alerts + live viewer count.
import type { ServerResponse } from 'node:http';
import type { Redis } from 'ioredis';
import { createRedis } from '../lib/redis.ts';
import { log } from '../lib/log.ts';
import type { ChannelEvent } from '../lib/events.ts';
import { liveInfoForChannel } from './views.ts';

type Stats = { live: boolean; viewers: number };

export class OverlayHub {
  private readonly subs = new Map<string, Set<ServerResponse>>();
  private readonly stats = new Map<string, Stats>();
  private subscriber: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    this.subscriber = createRedis('overlay-sub');
    this.subscriber.on('ready', () => {
      this.subscriber!.psubscribe('ov:*', 'ev:ch:*').catch((err: Error) => log.warn({ err: err.message }, 'overlay psubscribe failed'));
    });
    this.subscriber.on('pmessage', (_p: string, channel: string, message: string) => {
      try {
        if (channel.startsWith('ov:')) {
          const id = channel.slice(3);
          if (this.subs.has(id)) this.push(id, 'alert', JSON.parse(message));
        } else {
          const id = channel.slice('ev:ch:'.length);
          if (this.subs.has(id)) void this.onChannelEvent(id, JSON.parse(message) as ChannelEvent);
        }
      } catch { /* ignore malformed */ }
    });
    this.timer = setInterval(() => {
      for (const set of this.subs.values()) for (const res of set) res.write('event: ping\ndata: {}\n\n');
    }, 15_000);
  }

  async add(channelId: string, res: ServerResponse): Promise<void> {
    let set = this.subs.get(channelId);
    if (!set) this.subs.set(channelId, (set = new Set()));
    set.add(res);
    const stats = await this.load(channelId);
    if (set.has(res)) res.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
  }

  remove(channelId: string, res: ServerResponse): void {
    const set = this.subs.get(channelId);
    if (!set?.delete(res)) return;
    if (set.size === 0) {
      this.subs.delete(channelId);
      this.stats.delete(channelId);
    }
  }

  /** Drop every overlay connection of a channel (its secret URL was reset). */
  disconnect(channelId: string): void {
    for (const res of this.subs.get(channelId) ?? []) res.end();
    this.subs.delete(channelId);
    this.stats.delete(channelId);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const set of this.subs.values()) for (const res of set) res.end();
    this.subs.clear();
    this.subscriber?.disconnect();
  }

  private async load(channelId: string): Promise<Stats> {
    const live = await liveInfoForChannel(channelId);
    const stats = { live: live?.status === 'live', viewers: live?.viewers ?? 0 };
    this.stats.set(channelId, stats);
    return stats;
  }

  private async onChannelEvent(channelId: string, ev: ChannelEvent): Promise<void> {
    const prev = this.stats.get(channelId);
    const next = ev.kind === 'viewers' && prev ? { ...prev, viewers: ev.viewers } : await this.load(channelId);
    if (prev && prev.live === next.live && prev.viewers === next.viewers) return;
    this.stats.set(channelId, next);
    this.push(channelId, 'stats', next);
  }

  private push(channelId: string, event: string, data: unknown): void {
    for (const res of this.subs.get(channelId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export const overlayHub = new OverlayHub();
