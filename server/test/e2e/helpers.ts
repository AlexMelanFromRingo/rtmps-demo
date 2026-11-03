// Shared helpers for e2e suites that run against a live stack (docker compose).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
export const HLS_ORIGIN = process.env.E2E_HLS_ORIGIN ?? BASE;
export const INGEST = process.env.E2E_INGEST_HOST ?? '127.0.0.1';
export const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? 'streamhub';
export const FFMPEG_IMAGE = 'mwader/static-ffmpeg:9.0.2-1';
export const SUFFIX = randomBytes(3).toString('hex');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45_000, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { lastErr = err; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${(lastErr as Error).message}` : ''}`);
}

export type Res = { status: number; json: any; headers: Headers };

/** HTTP client with its own cookie jar (one per simulated user/device). */
export class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown = {}) => this.req('PATCH', p, b);
  del = (p: string) => this.req('DELETE', p, {});
}

export async function newStreamer(prefix: string, password = 'correct-horse-1') {
  const client = new Client();
  const username = `${prefix}_${SUFFIX}`;
  const r = await client.post('/api/auth/register', { username, password, displayName: `${prefix} ${SUFFIX}` });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.json)}`);
  const d = await client.get('/api/dashboard');
  return { client, username, slug: username.toLowerCase(), key: d.json.streamKey as string, password };
}

export function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const publishers = new Set<string>();

/** Starts a real-time FFmpeg publisher container; returns its name. */
export function publish(name: string, network: string, ffArgs: string[]): string {
  const container = `e2e-${name}-${SUFFIX}`;
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  docker(['run', '-d', '--name', container, '--network', network, FFMPEG_IMAGE, '-hide_banner', '-loglevel', 'error', '-re', ...ffArgs]);
  publishers.add(container);
  return container;
}

export function stopPublisher(container: string): void {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  publishers.delete(container);
}

export function stopAllPublishers(): void {
  for (const c of [...publishers]) stopPublisher(c);
}

export const SOURCE = (w: number, h: number, fps: number) => [
  '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
];

/** RTMP H.264 publisher with a keyframe every `gopSec` seconds. */
export const rtmpH264 = (key: string, seconds: number, gopSec = 2, size: [number, number] = [854, 480]) => [
  ...SOURCE(size[0], size[1], 30), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', String(30 * gopSec),
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), '-f', 'flv', `rtmp://${INGEST}:1935/live/${key}`,
];

export function resetRateLimits(): void {
  spawnSync('docker', ['compose', '-p', PROJECT, 'exec', '-T', 'valkey', 'valkey-cli', 'EVAL',
    "for _,k in ipairs(redis.call('keys','rl:*')) do redis.call('del',k) end", '0'], { stdio: 'ignore' });
}

/** Reads Server-Sent Events from a URL until `until` returns true (or timeout). */
export async function readSse(path: string, until: (events: { event: string; data: any }[]) => boolean, timeoutMs = 20_000,
  onOpen?: () => Promise<void>): Promise<{ event: string; data: any }[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const events: { event: string; data: any }[] = [];
  try {
    const res = await fetch(BASE + path, { signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`SSE ${path}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let opened = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data !== undefined) events.push({ event: ev, data: JSON.parse(data) });
      }
      if (!opened && onOpen) { opened = true; await onOpen(); }
      if (until(events)) break;
    }
  } catch (err) {
    if (!ctl.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return events;
}
