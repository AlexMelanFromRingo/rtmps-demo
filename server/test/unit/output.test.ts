import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobOutput, fileMeta } from '../../src/worker/output.ts';
import { planLadder } from '../../src/worker/ladder.ts';
import { log } from '../../src/lib/log.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const playlist = (segs: string[]) => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n${segs.map((s) => `#EXTINF:2.0,\n${s}`).join('\n')}\n`;

function harness(slowSegments = false) {
  const events: string[] = [];
  const store = new Map<string, string>();
  const ready: string[][] = [];
  const plan = planLadder({ videoCodec: 'H264', width: 1280, height: 720, fps: 30, hasAudio: true }, 'abr');
  const out = new JobOutput({
    prefix: 'live/b1/', plan, log,
    put: async (key, body) => {
      if (slowSegments && key.endsWith('.m4s')) await sleep(30);
      store.set(key, body.toString());
      events.push(`put ${key}`);
    },
    del: async (key) => { store.delete(key); events.push(`del ${key}`); },
    onReady: async (info) => { ready.push(info.variants.map((v) => v.name)); },
    settleMs: 50,
  });
  return { out, events, store, ready, plan };
}

test('a playlist is never uploaded before the segment it references (slow S3)', async () => {
  const { out, events } = harness(true);
  out.onFile({ variant: '480p', file: 'seg_1.m4s', body: Buffer.alloc(1000) });
  out.onFile({ variant: '480p', file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  out.onFile({ variant: '480p', file: 'seg_2.m4s', body: Buffer.alloc(1000) });
  out.onFile({ variant: '480p', file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s', 'seg_2.m4s'])) });
  out.onDelete('480p', 'seg_1.m4s');
  await out.drain();
  const v = events.filter((e) => e.includes('/480p/'));
  assert.deepEqual(v, [
    'put live/b1/480p/seg_1.m4s', 'put live/b1/480p/index.m3u8',
    'put live/b1/480p/seg_2.m4s', 'put live/b1/480p/index.m3u8',
    'del live/b1/480p/seg_1.m4s',
  ]);
});

test('master is published once audio + a video variant are ready, then grows', async () => {
  const { out, store, ready, plan } = harness();
  const names = plan.variants.map((v) => v.name);
  // video first: no master until audio is ready
  out.onFile({ variant: names[0]!, file: 'seg_1.m4s', body: Buffer.alloc(500_000) });
  out.onFile({ variant: names[0]!, file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  await sleep(10);
  assert.equal(store.has('live/b1/master.m3u8'), false);

  out.onFile({ variant: 'audio', file: 'seg_1.m4s', body: Buffer.alloc(40_000) });
  out.onFile({ variant: 'audio', file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  await sleep(10);
  assert.equal(store.has('live/b1/master.m3u8'), false, 'waits for the other variants to settle');
  await sleep(80);
  assert.match(store.get('live/b1/master.m3u8')!, new RegExp(`NAME="${names[0]}"`));
  assert.deepEqual(ready, [[names[0]]]);

  for (const n of names.slice(1)) {
    out.onFile({ variant: n, file: 'seg_1.m4s', body: Buffer.alloc(100) });
    out.onFile({ variant: n, file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  }
  await out.drain();
  assert.equal(ready.at(-1)!.length, names.length);
  const source = store.get('live/b1/master.m3u8')!;
  for (const n of names) assert.match(source, new RegExp(`${n}/index\\.m3u8`));
});

test('master is published immediately when every variant is ready', async () => {
  const { out, store, plan } = harness();
  for (const n of [...plan.variants.map((v) => v.name), 'audio']) {
    out.onFile({ variant: n, file: 'seg_1.m4s', body: Buffer.alloc(100) });
    out.onFile({ variant: n, file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  }
  await sleep(10);
  assert.ok(store.has('live/b1/master.m3u8'));
  await out.drain();
});

test('observed bitrate of a passthrough source is computed from segment sizes', async () => {
  const { out, store } = harness();
  out.onFile({ variant: 'audio', file: 'seg_1.m4s', body: Buffer.alloc(40_000) });
  out.onFile({ variant: 'audio', file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  // 2 s segment of 1_000_000 bytes = 4000 kbps
  out.onFile({ variant: 'source', file: 'seg_1.m4s', body: Buffer.alloc(1_000_000) });
  out.onFile({ variant: 'source', file: 'index.m3u8', body: Buffer.from(playlist(['seg_1.m4s'])) });
  await out.drain();
  const m = store.get('live/b1/master.m3u8')!;
  assert.match(m, new RegExp(`AVERAGE-BANDWIDTH=${Math.round((4000 + 160) * 1000 * 1.03)},`));
});

test('fileMeta content types and caching', () => {
  assert.equal(fileMeta('index.m3u8').cacheControl, 'public, max-age=1');
  assert.match(fileMeta('seg_1.m4s').cacheControl, /immutable/);
  assert.equal(fileMeta('init_a_720p.mp4').contentType, 'video/mp4');
  assert.equal(fileMeta('thumb.jpg').contentType, 'image/jpeg');
});
