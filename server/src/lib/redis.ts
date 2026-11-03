import { Redis } from 'ioredis';
import { config } from '../config.ts';
import { log } from './log.ts';

// Redis/Valkey holds only ephemeral, reconstructible state (viewer presence,
// rate-limit counters, pub/sub fan-out). The platform keeps streaming if it
// is down; those features degrade gracefully.
export function createRedis(name: string): Redis {
  const client = new Redis(config.redisUrl, {
    connectionName: `streamhub:${name}`,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  client.on('error', (err) => log.warn({ err: err.message, name }, 'redis error'));
  return client;
}

export const redis = createRedis('main');

export const keys = {
  viewers: (broadcastId: string) => `viewers:${broadcastId}`,
  viewerCount: 'viewer_counts', // HASH broadcastId -> count
  rate: (bucket: string, id: string, window: number) => `rl:${bucket}:${id}:${window}`,
  channelEvents: (channelId: string) => `ev:ch:${channelId}`,
  overlayEvents: (channelId: string) => `ov:${channelId}`,
  followAlertOnce: (channelId: string, userId: string) => `ovf:${channelId}:${userId}`,
  videoView: (videoId: string, viewer: string) => `vv:${videoId}:${viewer}`,
  eventsPattern: 'ev:*',
};
