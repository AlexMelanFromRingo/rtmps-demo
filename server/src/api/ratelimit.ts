import { HttpError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { keys, redis } from '../lib/redis.ts';

/** Fixed-window limiter in Redis. Fails open if Redis is unavailable. */
export async function rateLimit(bucket: string, id: string, limit: number, windowSec: number): Promise<void> {
  if (redis.status !== 'ready') return;
  const window = Math.floor(Date.now() / 1000 / windowSec);
  const key = keys.rate(bucket, id, window);
  try {
    const [[, count]] = (await redis.multi().incr(key).expire(key, windowSec + 1).exec()) as [[unknown, number]];
    if (count > limit) throw new HttpError(429, 'rate_limited', 'Слишком много запросов, попробуйте позже');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    log.warn({ err: (err as Error).message }, 'rate limiter unavailable');
  }
}
