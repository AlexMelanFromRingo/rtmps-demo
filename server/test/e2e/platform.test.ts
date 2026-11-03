// End-to-end tests against a running stack (`docker compose up -d`).
// Publishers are real FFmpeg 9 processes in containers, so every ingest
// protocol/codec path is exercised exactly like OBS/browsers would.
//
//   E2E_BASE_URL   site origin (edge)            default http://localhost:8080
//   E2E_HLS_ORIGIN origin for /hls/... URLs      default = E2E_BASE_URL
//   E2E_INGEST_HOST host for RTMP/SRT publishing default 127.0.0.1
//
// Run: npm run test:e2e   (needs docker on PATH)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const HLS_ORIGIN = process.env.E2E_HLS_ORIGIN ?? BASE;
const INGEST = process.env.E2E_INGEST_HOST ?? '127.0.0.1';
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? 'streamhub';
const FFMPEG_IMAGE = 'mwader/static-ffmpeg:9.0.2-1';
const SUFFIX = randomBytes(3).toString('hex');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const publishers = new Set<string>();

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45_000, everyMs = 1000): Promise<T> {
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

// ── HTTP client with a cookie jar per user ──────────────────────────────────
class Client {
  cookie = '';
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
}

type Dashboard = {
  streamKey: string;
  live: null | {
    broadcastId: string; status: string; playbackUrl: string | null; thumbnailUrl: string | null;
    source: { protocol: string; videoCodec: string | null; width: number | null; height: number | null };
    renditions: { name: string; codec: string; passthrough: boolean }[];
    stats: { transcoder: null | { state: string; worker: string | null } };
  };
};

async function newStreamer(prefix: string): Promise<{ client: Client; username: string; key: string }> {
  const client = new Client();
  const username = `${prefix}_${SUFFIX}`;
  const r = await client.post('/api/auth/register', { username, password: 'correct-horse-1' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const d = await client.get('/api/dashboard');
  return { client, username, key: (d.json as Dashboard).streamKey };
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Starts a real-time FFmpeg publisher container; returns its name. */
function publish(name: string, network: string, ffArgs: string[]): string {
  const container = `e2e-${name}-${SUFFIX}`;
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  docker(['run', '-d', '--name', container, '--network', network, FFMPEG_IMAGE, '-hide_banner', '-loglevel', 'error', '-re', ...ffArgs]);
  publishers.add(container);
  return container;
}

function stopPublisher(container: string): void {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  publishers.delete(container);
}

const SOURCE = (w: number, h: number, fps: number) => [
  '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
];
const DURATION = ['-t', '300'];

async function waitLive(client: Client, what: string, container?: string): Promise<NonNullable<Dashboard['live']>> {
  let restarts = 0;
  return waitFor(`${what}: playback ready`, async () => {
    // A publisher can fail its handshake when the test box is saturated
    // (many software encoders starting at once): restart it like OBS would.
    if (container && restarts < 3 && docker(['inspect', '-f', '{{.State.Status}}', container]) === 'exited') {
      restarts++;
      docker(['start', container]);
    }
    const d = (await client.get('/api/dashboard')).json as Dashboard;
    return d.live?.playbackUrl && d.live.renditions.length > 0 ? d.live : null;
  }, 60_000);
}

async function hls(url: string): Promise<Response> {
  return fetch(new URL(url, HLS_ORIGIN));
}

/** Validates master + one variant playlist + init + segment + thumbnail. */
async function assertPlayable(live: NonNullable<Dashboard['live']>, expectCodecs: RegExp[]): Promise<string> {
  const masterRes = await hls(live.playbackUrl!);
  assert.equal(masterRes.status, 200);
  assert.match(masterRes.headers.get('content-type') ?? '', /mpegurl/i);
  const master = await masterRes.text();
  for (const re of expectCodecs) assert.match(master, re, `master playlist should contain ${re}:\n${master}`);

  const base = new URL(live.playbackUrl!, HLS_ORIGIN);
  const variants = master.split('\n').filter((l) => l.endsWith('/index.m3u8'));
  assert.ok(variants.length >= 1);
  for (const v of variants) {
    const vUrl = new URL(v, base);
    const playlist = await waitFor(`segments in ${v}`, async () => {
      const t = await (await fetch(vUrl)).text();
      return /seg_\d+\.m4s/.test(t) ? t : null;
    }, 20_000);
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)![1]!;
    const seg = playlist.match(/seg_\d+\.m4s/g)!.at(-1)!;
    const initRes = await fetch(new URL(init, vUrl));
    assert.equal(initRes.status, 200, `init ${init}`);
    const segRes = await fetch(new URL(seg, vUrl));
    assert.equal(segRes.status, 200, `segment ${seg} of ${v}`);
    assert.ok((await segRes.arrayBuffer()).byteLength > 500);
  }
  const thumb = await waitFor('thumbnail', async () => {
    const r = await hls(live.thumbnailUrl!);
    return r.status === 200 ? r : null;
  }, 20_000);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  return master;
}

before(() => {
  // Fresh rate-limit windows so repeated runs don't trip registration limits.
  spawnSync('docker', ['compose', '-p', PROJECT, 'exec', '-T', 'valkey', 'valkey-cli', 'EVAL',
    "for _,k in ipairs(redis.call('keys','rl:*')) do redis.call('del',k) end", '0'], { stdio: 'ignore' });
});

after(() => {
  for (const c of [...publishers]) stopPublisher(c);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('accounts & security', () => {
  test('register, me, logout, login', async () => {
    const c = new Client();
    const username = `user_${SUFFIX}`;
    assert.equal((await c.post('/api/auth/register', { username, password: 'pw-is-long-enough' })).status, 201);
    assert.equal((await c.post('/api/auth/register', { username, password: 'pw-is-long-enough' })).status, 409);
    const me = await c.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.channel.slug, username.toLowerCase());
    assert.equal((await c.post('/api/auth/logout')).status, 204);
    assert.equal((await c.get('/api/auth/me')).status, 401);
    assert.equal((await c.post('/api/auth/login', { username, password: 'wrong-password' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { username, password: 'pw-is-long-enough' })).status, 200);
    assert.equal((await c.get('/api/dashboard')).status, 200);
  });

  test('validation and CSRF protections', async () => {
    const c = new Client();
    const bad = await c.post('/api/auth/register', { username: 'x', password: 'short' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'validation_failed');
    const form = await c.req('POST', '/api/auth/login', undefined, { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    const xorigin = await c.req('POST', '/api/auth/login', { username: 'a', password: 'b' }, { origin: 'https://evil.example' });
    assert.equal(xorigin.status, 403);
    assert.equal((await c.get('/api/dashboard')).status, 401);
  });

  test('internal endpoints are not reachable through the edge', async () => {
    const r = await fetch(`${BASE}/internal/ingest/online`, { method: 'POST' });
    assert.equal(r.status, 404);
  });

  test('publishing with an unknown stream key is rejected', async () => {
    const container = publish('badkey', 'host', [...SOURCE(320, 240, 15), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '5',
      '-f', 'flv', `rtmp://${INGEST}:1935/live/live_${'x'.repeat(32)}`]);
    const exit = await waitFor('publisher exit', async () => {
      const s = docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', container]);
      return s.startsWith('exited') ? s : null;
    }, 20_000);
    stopPublisher(container);
    assert.notEqual(exit, 'exited 0', 'ffmpeg must fail to publish');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ingest × codec matrix (multiple channels live at once)', () => {
  const cases = [
    {
      name: 'rtmp-h264', protocol: 'rtmp', network: 'host',
      args: (key: string) => [...SOURCE(1280, 720, 30), '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-bf', '2',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...DURATION, '-f', 'flv', `rtmp://${INGEST}:1935/live/${key}`],
      codecs: [/CODECS="avc1\.[0-9a-f]{6},mp4a\.40\.2".*NAME="source"/], ladder: [/NAME="480p"/],
      expect: { video: 'H264', source: 'H264' },
    },
    {
      name: 'rtmp-hevc', protocol: 'rtmp', network: 'host',
      args: (key: string) => [...SOURCE(1280, 720, 30), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
        '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...DURATION, '-f', 'flv', `rtmp://${INGEST}:1935/live/${key}`],
      codecs: [/CODECS="hvc1\.1\.6\.L\d+\.B0,mp4a\.40\.2".*NAME="source"/, /CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/], ladder: [/NAME="720p"/],
      expect: { video: 'H265', source: 'H265' },
    },
    {
      name: 'rtmp-av1', protocol: 'rtmp', network: 'host',
      args: (key: string) => [...SOURCE(1280, 720, 30), '-c:v', 'libsvtav1', '-preset', '12', '-g', '60', '-pix_fmt', 'yuv420p',
        '-c:a', 'libopus', ...DURATION, '-f', 'flv', `rtmp://${INGEST}:1935/live/${key}`],
      codecs: [/CODECS="av01\.0\.\d\dM\.08,mp4a\.40\.2".*NAME="source"/, /avc1\./], ladder: [/NAME="720p"/],
      expect: { video: 'AV1', source: 'AV1' },
    },
    {
      name: 'srt-hevc', protocol: 'srt', network: 'host',
      args: (key: string) => [...SOURCE(1920, 1080, 30), '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
        '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...DURATION, '-f', 'mpegts',
        `srt://${INGEST}:8890?streamid=publish:live/${key}&pkt_size=1316`],
      codecs: [/hvc1\..*NAME="source"/, /avc1\./], ladder: [/NAME="1080p"/, /NAME="720p"/],
      expect: { video: 'H265', source: 'H265' },
    },
    {
      // WHIP's ICE candidate is the container IP, so publish from inside the ingest netns.
      name: 'whip-h264', protocol: 'webrtc', network: `container:${PROJECT}-ingest-1`,
      args: (key: string) => [...SOURCE(1280, 720, 30), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0',
        '-g', '60', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', ...DURATION,
        '-handshake_timeout', '20000', '-f', 'whip', `http://127.0.0.1:8889/live/${key}/whip`],
      codecs: [/avc1\.42[0-9a-f]{4},mp4a\.40\.2".*NAME="source"/], ladder: [/NAME="480p"/],
      expect: { video: 'H264', source: 'H264' },
    },
  ];

  const running = new Map<string, { client: Client; username: string; container: string }>();

  before(async () => {
    // Everyone goes live at the same time: multi-tenant ingest + transcoding.
    // WebRTC first: its DTLS handshake is the most sensitive to CPU contention.
    for (const c of [...cases].sort((a, b) => Number(b.protocol === 'webrtc') - Number(a.protocol === 'webrtc'))) {
      const s = await newStreamer(c.name.replace('-', ''));
      const container = publish(c.name, c.network, c.args(s.key));
      running.set(c.name, { client: s.client, username: s.username, container });
    }
  });

  after(() => {
    for (const r of running.values()) stopPublisher(r.container);
  });

  for (const c of cases) {
    test(`${c.name}: goes live, transcodes and serves a playable ABR ladder`, async () => {
      const { client, container } = running.get(c.name)!;
      const live = await waitLive(client, c.name, container);
      assert.equal(live.status, 'live');
      assert.equal(live.source.protocol, c.protocol);
      assert.equal(live.source.videoCodec, c.expect.video);
      const source = live.renditions.find((r) => r.name === 'source');
      assert.ok(source?.passthrough, 'source rendition passes the original codec through');
      assert.equal(source.codec, c.expect.source);
      assert.ok(live.renditions.some((r) => r.codec === 'H264' && !r.passthrough) || c.expect.video === 'H264',
        'non-H.264 sources always get an H.264 rendition');
      // With more streams than full transcoding slots, some run degraded (source + ≤480p H.264).
      const degraded = (await client.get('/api/dashboard')).json.live.stats.transcoder?.degraded === true;
      if (degraded) console.log(`  ${c.name}: running in degraded mode (capacity exhausted)`);
      await assertPlayable(live, degraded ? c.codecs : [...c.codecs, ...c.ladder]);
    });
  }

  test('directory lists every live channel; channel API + SSE agree', async () => {
    const usernames = [...running.values()].map((r) => r.username.toLowerCase());
    const streams = await waitFor('directory', async () => {
      const s = (await new Client().get('/api/streams')).json.streams as { channel: { slug: string } }[];
      return usernames.every((u) => s.some((x) => x.channel.slug === u)) ? s : null;
    });
    assert.ok(streams.length >= usernames.length);

    const slug = usernames[0]!;
    const ch = await new Client().get(`/api/channels/${slug}`);
    assert.equal(ch.status, 200);
    assert.equal(ch.json.live.status, 'live');

    const ctl = new AbortController();
    const res = await fetch(`${BASE}/api/channels/${slug}/events`, { signal: ctl.signal });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    let buf = '';
    while (!buf.includes('event: state')) buf += new TextDecoder().decode((await reader.read()).value);
    ctl.abort();
    const data = JSON.parse(/data: (.*)\n/.exec(buf.slice(buf.indexOf('event: state')))![1]!);
    assert.equal(data.live.broadcastId, ch.json.live.broadcastId);
  });

  test('viewer heartbeats are counted', async () => {
    const { username } = running.get('rtmp-h264')!;
    const slug = username.toLowerCase();
    const viewers = [new Client(), new Client(), new Client()];
    for (const [i, v] of viewers.entries()) {
      const r = await v.post(`/api/channels/${slug}/heartbeat`, { viewerId: `viewer-${SUFFIX}-${i}` });
      assert.equal(r.status, 204);
    }
    await waitFor('viewer count', async () => (await new Client().get(`/api/channels/${slug}`)).json.live.viewers >= 3, 20_000);
  });

  test('stream ends → reconnecting state (grace period)', async () => {
    const r = running.get('whip-h264')!;
    // SIGKILLed publisher sends no WHIP DELETE: MediaMTX notices via ICE timeout (~25 s).
    stopPublisher(r.container);
    await waitFor('reconnecting', async () => (await r.client.get('/api/dashboard')).json.live?.status === 'reconnecting', 50_000);
  });

  test('stream key reset: the old key is rejected', async () => {
    const s = await newStreamer('rotate');
    const r = await s.client.post('/api/channel/stream-key');
    assert.equal(r.status, 200);
    assert.notEqual(r.json.streamKey, s.key);
    const container = publish('oldkey', 'host', [...SOURCE(320, 240, 15), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '5',
      '-f', 'flv', `rtmp://${INGEST}:1935/live/${s.key}`]);
    const exit = await waitFor('publisher exit', async () => {
      const st = docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', container]);
      return st.startsWith('exited') ? st : null;
    }, 20_000);
    stopPublisher(container);
    assert.notEqual(exit, 'exited 0');
  });
  test('worker crash (SIGKILL): another worker takes over the transcode', async () => {
    // Free transcoding capacity first (N+1 headroom is how failover is planned).
    for (const [name, r] of running) if (name !== 'rtmp-h264') stopPublisher(r.container);
    const { client } = running.get('rtmp-h264')!;
    await sleep(3000);
    const before = (await client.get('/api/dashboard')).json as Dashboard;
    const worker = before.live!.stats.transcoder!.worker!;
    const container = worker.replace(/-\d+$/, ''); // worker id = <container hostname>-<pid>
    const variantUrl = new URL(before.live!.playbackUrl!.replace('master.m3u8', 'source/index.m3u8'), HLS_ORIGIN);
    const lastSeg = async () => Number((await (await fetch(variantUrl)).text()).match(/seg_(\d+)\.m4s/g)?.at(-1)?.slice(4, -4) ?? 0);
    const segBefore = await lastSeg();

    docker(['kill', container]);
    const killedAt = Date.now();
    try {
      await waitFor('failover', async () => {
        const d = (await client.get('/api/dashboard')).json as Dashboard;
        const t = d.live?.stats.transcoder;
        return t?.state === 'running' && t.worker !== worker && (await lastSeg()) > segBefore + 3;
      }, 60_000);
      console.log(`  failover completed in ${((Date.now() - killedAt) / 1000).toFixed(1)} s`);
    } finally {
      docker(['start', container]);
    }
  });

});
