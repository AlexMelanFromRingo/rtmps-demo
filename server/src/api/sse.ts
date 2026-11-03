// Server-Sent Events fan-out. Each API replica holds one Redis pattern
// subscription; an event triggers ONE state reload per replica (not per
// client), then the result is pushed to every local subscriber.
import type { ServerResponse } from 'node:http';
import type { Redis } from 'ioredis';
import { createRedis, keys } from '../lib/redis.ts';
import { log } from '../lib/log.ts';
import type { ChannelEvent } from '../lib/events.ts';
import { channelById, channelPublic, liveInfoForChannel, type ChannelPublic, type LiveInfo } from './views.ts';
import { apiMetrics } from './metrics.ts';

type ChannelState = { live: LiveInfo | null; channel: ChannelPublic | null };

async function loadState(channelId: string): Promise<ChannelState> {
  const [live, ch] = await Promise.all([liveInfoForChannel(channelId), channelById(channelId)]);
  return { live, channel: ch ? channelPublic(ch) : null };
}

export class ChannelEventHub {
  private readonly subs = new Map<string, Set<ServerResponse>>();
  private readonly cache = new Map<string, ChannelState>();
  private readonly reloading = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private subscriber: Redis | null = null;
  private timers: NodeJS.Timeout[] = [];

  start(): void {
    this.subscriber = createRedis('sse-sub');
    this.subscriber.on('ready', () => {
      this.subscriber!.psubscribe(keys.eventsPattern).catch((err: Error) => log.warn({ err: err.message }, 'psubscribe failed'));
      // We may have missed events while disconnected: resync everyone.
      for (const id of this.subs.keys()) void this.reload(id);
    });
    this.subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const channelId = channel.slice('ev:ch:'.length);
      if (!this.subs.has(channelId)) return;
      try {
        this.onEvent(channelId, JSON.parse(message) as ChannelEvent);
      } catch { /* ignore malformed */ }
    });
    // Named keep-alive event (EventSource can't see comments) lets clients
    // detect half-open connections; periodic resync covers a Redis outage.
    this.timers.push(setInterval(() => this.broadcastRaw('event: ping\ndata: {}\n\n'), 15_000));
    this.timers.push(setInterval(() => { for (const id of this.subs.keys()) void this.reload(id); }, 30_000));
  }

  async add(channelId: string, res: ServerResponse): Promise<void> {
    let set = this.subs.get(channelId);
    if (!set) this.subs.set(channelId, (set = new Set()));
    set.add(res);
    apiMetrics.sseClients.inc();
    const loaded = this.cache.get(channelId) ?? await loadState(channelId);
    if (!this.subs.get(channelId)?.has(res)) return; // client left while we were loading
    // A reload that finished meanwhile is fresher than what we loaded.
    if (!this.cache.has(channelId)) this.cache.set(channelId, loaded);
    this.write(res, this.cache.get(channelId)!);
  }

  remove(channelId: string, res: ServerResponse): void {
    const set = this.subs.get(channelId);
    if (!set?.delete(res)) return;
    apiMetrics.sseClients.dec();
    if (set.size === 0) {
      this.subs.delete(channelId);
      this.cache.delete(channelId);
    }
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const set of this.subs.values()) for (const res of set) res.end();
    this.subs.clear();
    this.subscriber?.disconnect();
  }

  private onEvent(channelId: string, ev: ChannelEvent): void {
    const cached = this.cache.get(channelId);
    if (ev.kind === 'viewers' && cached?.live && cached.live.broadcastId === ev.broadcastId) {
      if (cached.live.viewers === ev.viewers) return;
      const next = { ...cached, live: { ...cached.live, viewers: ev.viewers } };
      this.cache.set(channelId, next);
      this.push(channelId, next);
      return;
    }
    void this.reload(channelId);
  }

  // Coalesces bursts of events into at most one in-flight + one queued reload.
  private reload(channelId: string): Promise<void> {
    const inflight = this.reloading.get(channelId);
    if (inflight) {
      this.dirty.add(channelId);
      return inflight;
    }
    const p = (async () => {
      try {
        const state = await loadState(channelId);
        if (!this.subs.has(channelId)) return;
        const prev = JSON.stringify(this.cache.get(channelId) ?? null);
        this.cache.set(channelId, state);
        if (JSON.stringify(state) !== prev) this.push(channelId, state);
      } catch (err) {
        log.warn({ err: (err as Error).message, channelId }, 'sse reload failed');
      } finally {
        this.reloading.delete(channelId);
        if (this.dirty.delete(channelId)) void this.reload(channelId);
      }
    })();
    this.reloading.set(channelId, p);
    return p;
  }

  private push(channelId: string, state: ChannelState): void {
    for (const res of this.subs.get(channelId) ?? []) this.write(res, state);
  }

  private write(res: ServerResponse, state: ChannelState): void {
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  }

  private broadcastRaw(text: string): void {
    for (const set of this.subs.values()) for (const res of set) res.write(text);
  }
}

export const hub = new ChannelEventHub();
