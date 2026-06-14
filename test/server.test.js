'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated ports + storage so the suite never collides with a running instance.
const ENV = {
  ...process.env,
  WEB_PORT: '13700',
  RTMP_PORT: '11935',
  MEDIA_HTTP_PORT: '18800',
  SRT_BASE_PORT: '19700',
  PUBLIC_HOST: '127.0.0.1',
};

const PROJECT_ROOT = path.join(__dirname, '..');
let tmpDir;
let serverProc;
const serverLog = [];

const BASE = `http://127.0.0.1:${ENV.WEB_PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForReady(proc, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not become ready in time')), timeoutMs);
    const onData = (buf) => {
      const text = buf.toString();
      serverLog.push(text);
      if (text.includes('[READY]')) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (b) => serverLog.push(b.toString()));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${serverLog.join('')}`));
    });
  });
}

async function waitFor(predicate, { timeoutMs = 25000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  return false;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtmps-test-'));
  const env = {
    ...ENV,
    DB_PATH: path.join(tmpDir, 'test.db'),
    MEDIA_ROOT: path.join(tmpDir, 'media'),
  };
  serverProc = spawn('node', ['server.js'], { cwd: PROJECT_ROOT, env });
  await waitForReady(serverProc);
});

after(async () => {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
    await waitFor(() => serverProc.exitCode !== null, { timeoutMs: 5000, intervalMs: 100 });
    if (serverProc.exitCode === null) serverProc.kill('SIGKILL');
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/generate-key returns a complete descriptor', async () => {
  const res = await fetch(`${BASE}/api/generate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'My Test Stream' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.match(data.streamKey, /^[0-9a-f-]{36}$/);
  assert.equal(data.name, 'My Test Stream');
  assert.equal(data.rtmpUrl, `rtmp://127.0.0.1:${ENV.RTMP_PORT}/live`);
  assert.match(data.srtUrl, /^srt:\/\/127\.0\.0\.1:\d+\?mode=caller$/);
  assert.equal(data.srtPort, Number(ENV.SRT_BASE_PORT));
  assert.match(data.hlsUrl, /\/media\/live\/.*\/master\.m3u8$/);
  assert.ok(data.protocols.srt && data.protocols.rtmp);
});

test('name is sanitised (defaults + length cap)', async () => {
  const empty = await (await fetch(`${BASE}/api/generate-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })).json();
  assert.equal(empty.name, 'Unnamed Stream');

  const long = await (await fetch(`${BASE}/api/generate-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(500) }),
  })).json();
  assert.equal(long.name.length, 100);
});

test('GET /api/keys lists created keys; ports do not collide', async () => {
  const keys = await (await fetch(`${BASE}/api/keys`)).json();
  assert.ok(Array.isArray(keys));
  assert.ok(keys.length >= 3);
  const ports = keys.map((k) => k.srt_port);
  assert.equal(new Set(ports).size, ports.length, 'SRT ports must be unique');
});

test('GET /api/key/:key returns 404 for unknown key', async () => {
  const res = await fetch(`${BASE}/api/key/does-not-exist`);
  assert.equal(res.status, 404);
});

test('GET /api/metrics/:key returns 404 when no live metrics', async () => {
  const res = await fetch(`${BASE}/api/metrics/does-not-exist`);
  assert.equal(res.status, 404);
});

test('DELETE /api/key/:key removes an offline key', async () => {
  const created = await (await fetch(`${BASE}/api/generate-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'to delete' }),
  })).json();

  const del = await fetch(`${BASE}/api/key/${created.streamKey}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  const after = await fetch(`${BASE}/api/key/${created.streamKey}`);
  assert.equal(after.status, 404);
});

test('end-to-end: RTMP publish produces a playable HLS ladder', async () => {
  // 1. Create a key.
  const created = await (await fetch(`${BASE}/api/generate-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e' }),
  })).json();
  const key = created.streamKey;

  // 2. Publish a short synthetic RTMP stream (H.264 + AAC) in real time.
  const publisher = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-t', '12',
    '-f', 'flv', `rtmp://127.0.0.1:${ENV.RTMP_PORT}/live/${key}`,
  ]);
  const pubErr = [];
  publisher.stderr.on('data', (b) => pubErr.push(b.toString()));

  try {
    // 3. The server should flip the key to live.
    const wentLive = await waitFor(async () => {
      const data = await (await fetch(`${BASE}/api/key/${key}`)).json();
      return data.is_live === 1;
    }, { timeoutMs: 15000 });
    assert.ok(wentLive, `stream never went live. ffmpeg said:\n${pubErr.join('')}`);

    // 4. The master playlist should be served over HTTP with the right type.
    const masterUrl = `${BASE}/media/live/${key}/master.m3u8`;
    const gotMaster = await waitFor(async () => (await fetch(masterUrl)).ok, { timeoutMs: 20000 });
    assert.ok(gotMaster, `master.m3u8 never appeared. ffmpeg said:\n${pubErr.join('')}`);

    const masterRes = await fetch(masterUrl);
    assert.match(masterRes.headers.get('content-type') || '', /mpegurl/);
    const master = await masterRes.text();
    assert.match(master, /#EXTM3U/);
    assert.match(master, /1080p\/index\.m3u8/);
    assert.match(master, /720p\/index\.m3u8/);
    assert.match(master, /480p\/index\.m3u8/);

    // 5. A variant playlist should reference at least one segment that loads.
    const gotSegment = await waitFor(async () => {
      const variant = await (await fetch(`${BASE}/media/live/${key}/720p/index.m3u8`)).text();
      const m = variant.match(/(segment_\d+\.ts)/);
      if (!m) return false;
      const seg = await fetch(`${BASE}/media/live/${key}/720p/${m[1]}`);
      return seg.ok && seg.headers.get('content-type') === 'video/mp2t';
    }, { timeoutMs: 20000 });
    assert.ok(gotSegment, 'no playable .ts segment was produced');
  } finally {
    publisher.kill('SIGKILL');
  }
});

test('end-to-end: SRT publish produces a playable HLS ladder', async () => {
  // Creating a key starts an SRT listener on its dedicated port.
  const created = await (await fetch(`${BASE}/api/generate-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e-srt' }),
  })).json();
  const key = created.streamKey;
  const srtPort = created.srtPort;

  await sleep(1000); // give the listener a moment to bind

  // Push an mpegts stream to the listener as an SRT caller.
  const publisher = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-t', '12',
    '-f', 'mpegts', `srt://127.0.0.1:${srtPort}?mode=caller`,
  ]);
  const pubErr = [];
  publisher.stderr.on('data', (b) => pubErr.push(b.toString()));

  try {
    const wentLive = await waitFor(async () => {
      const data = await (await fetch(`${BASE}/api/key/${key}`)).json();
      return data.is_live === 1;
    }, { timeoutMs: 15000 });
    assert.ok(wentLive, `SRT stream never went live. ffmpeg said:\n${pubErr.join('')}`);

    const masterUrl = `${BASE}/media/live/${key}/master.m3u8`;
    const gotMaster = await waitFor(async () => (await fetch(masterUrl)).ok, { timeoutMs: 20000 });
    assert.ok(gotMaster, `master.m3u8 never appeared. ffmpeg said:\n${pubErr.join('')}`);

    const master = await (await fetch(masterUrl)).text();
    assert.match(master, /1080p\/index\.m3u8/);
    assert.match(master, /480p\/index\.m3u8/);

    // Source metrics should reflect the 1080p input, not a downscaled rendition.
    const data = await (await fetch(`${BASE}/api/key/${key}`)).json();
    assert.equal(data.metrics?.codec, 'h264');
    assert.equal(data.metrics?.resolution, '1920x1080');
  } finally {
    publisher.kill('SIGKILL');
  }
});
