// E2E for v2 features: follows, search/categories, profile/avatar, 2FA,
// sessions, overlays, low latency, VOD, multistream, health graphs.
// Runs against a live stack, like platform.test.ts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Decode, hotp, stepAt } from '../../src/lib/totp.ts';
import {
  BASE, Client, HLS_ORIGIN, newStreamer, PROJECT, publish, readSse, resetRateLimits, rtmpH264, SOURCE, stopAllPublishers,
  stopPublisher, SUFFIX, waitFor,
} from './helpers.ts';

before(() => resetRateLimits());
after(() => stopAllPublishers());

// 1×1 transparent PNG / JPEG magic bytes
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');

describe('accounts: 2FA (TOTP) and sessions', () => {
  test('2FA: setup → enable → login needs a code; codes and recovery codes are single-use', async () => {
    const s = await newStreamer('totp');
    const setup = await s.client.post('/api/me/2fa/setup');
    assert.equal(setup.status, 200);
    assert.match(setup.json.otpauthUrl, /^otpauth:\/\/totp\/StreamHub/);
    const secret = base32Decode(setup.json.secret);
    const code = (offset = 0) => hotp(secret, stepAt(Date.now()) + offset);

    const enable = await s.client.post('/api/me/2fa/enable', { code: code() });
    assert.equal(enable.status, 200, JSON.stringify(enable.json));
    const recovery: string[] = enable.json.recoveryCodes;
    assert.equal(recovery.length, 8);
    assert.equal((await s.client.get('/api/auth/me')).json.user.twoFactorEnabled, true);

    const c = new Client();
    const login = (totp?: string) => c.post('/api/auth/login', { username: s.username, password: s.password, ...(totp ? { totp } : {}) });
    assert.equal((await login()).json.error.code, 'totp_required');
    assert.equal((await login('000000')).json.error.code, 'totp_invalid');
    const next = code(1); // the current step was consumed by "enable"
    assert.equal((await login(next)).status, 200);
    assert.equal((await login(next)).json.error.code, 'totp_invalid', 'a TOTP code cannot be replayed');
    assert.equal((await login(recovery[0])).status, 200);
    assert.equal((await login(recovery[0])).json.error.code, 'totp_invalid', 'recovery codes are single-use');

    assert.equal((await s.client.post('/api/me/2fa/disable', { password: s.password, code: recovery[1] })).status, 204);
    assert.equal((await login()).status, 200, 'no second factor after disabling');
  });

  test('sessions: list devices, revoke others; a password change signs out other devices', async () => {
    const s = await newStreamer('sess');
    const phone = new Client();
    assert.equal((await phone.post('/api/auth/login', { username: s.username, password: s.password })).status, 200);
    const list = await s.client.get('/api/me/sessions');
    assert.equal(list.json.sessions.length, 2);
    assert.equal(list.json.sessions.filter((x: { current: boolean }) => x.current).length, 1);

    assert.equal((await s.client.post('/api/me/sessions/revoke-others')).status, 204);
    assert.equal((await phone.get('/api/auth/me')).status, 401, 'revoked device is signed out');

    const laptop = new Client();
    await laptop.post('/api/auth/login', { username: s.username, password: s.password });
    assert.equal((await s.client.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'new-password-123' })).status, 401);
    assert.equal((await s.client.post('/api/me/password', { currentPassword: s.password, newPassword: 'new-password-123' })).status, 204);
    assert.equal((await laptop.get('/api/auth/me')).status, 401);
    assert.equal((await s.client.get('/api/auth/me')).status, 200, 'the current device stays signed in');
    assert.equal((await new Client().post('/api/auth/login', { username: s.username, password: 'new-password-123' })).status, 200);
  });
});

describe('community, profile, overlay', () => {
  test('follow / unfollow, following list, follower count; overlay receives the alert', async () => {
    const streamer = await newStreamer('star');
    const fan = await newStreamer('fan');
    const dash = await streamer.client.get('/api/dashboard');
    const token = dash.json.channel.overlayUrl.split('/').pop();

    const events = await readSse(`/api/overlay/${token}/events`,
      (evs) => evs.some((e) => e.event === 'alert'),
      20_000,
      async () => {
        const r = await fan.client.post(`/api/channels/${streamer.slug}/follow`);
        assert.deepEqual(r.json, { following: true, followers: 1 });
      });
    assert.ok(events.some((e) => e.event === 'stats'), 'overlay gets stats on connect');
    const alert = events.find((e) => e.event === 'alert');
    assert.equal(alert?.data.type, 'follow');
    assert.equal(alert?.data.displayName, fan.username.replace('_', ' '));

    const ch = await fan.client.get(`/api/channels/${streamer.slug}`);
    assert.equal(ch.json.viewer.following, true);
    assert.equal(ch.json.channel.followers, 1);
    const following = await fan.client.get('/api/me/following');
    assert.ok(following.json.channels.some((c: { channel: { slug: string } }) => c.channel.slug === streamer.slug));
    assert.equal((await fan.client.post(`/api/channels/${fan.slug}/follow`)).status, 400, 'cannot follow yourself');
    assert.deepEqual((await fan.client.del(`/api/channels/${streamer.slug}/follow`)).json, { following: false, followers: 0 });
    assert.equal((await new Client().get(`/api/channels/${streamer.slug}`)).json.viewer, null);

    // test alert + secret reset
    const test = await readSse(`/api/overlay/${token}/events`, (evs) => evs.some((e) => e.event === 'alert'), 15_000,
      async () => { assert.equal((await streamer.client.post('/api/channel/overlay/test')).status, 204); });
    assert.equal(test.find((e) => e.event === 'alert')?.data.test, true);
    const reset = await streamer.client.post('/api/channel/overlay/reset');
    assert.notEqual(reset.json.overlayUrl, dash.json.channel.overlayUrl);
    assert.equal((await fetch(`${BASE}/api/overlay/${token}/events`)).status, 404, 'old overlay URL stops working');
  });

  test('profile: bio, https-only links, mature flag, avatar upload with content sniffing', async () => {
    const s = await newStreamer('prof');
    const p = await s.client.patch('/api/channel', { bio: 'Про космос', links: [{ label: 'Сайт', url: 'https://example.com' }], mature: true });
    assert.equal(p.status, 200);
    assert.equal(p.json.channel.mature, true);
    assert.equal((await s.client.patch('/api/channel', { links: [{ label: 'x', url: 'http://plain.example' }] })).status, 400);

    assert.equal((await s.client.post('/api/channel/avatar', { contentType: 'image/png', data: JPEG_HEAD })).status, 400,
      'declared type must match the file');
    const up = await s.client.post('/api/channel/avatar', { contentType: 'image/png', data: PNG_1PX });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const img = await fetch(new URL(up.json.avatarUrl, BASE));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const pub = await new Client().get(`/api/channels/${s.slug}`);
    assert.equal(pub.json.channel.avatarUrl, up.json.avatarUrl);
    assert.equal(pub.json.channel.bio, 'Про космос');
    assert.equal((await s.client.del('/api/channel/avatar')).status, 204);
    assert.equal((await new Client().get(`/api/channels/${s.slug}`)).json.channel.avatarUrl, null);
  });
});

describe('live features: low latency, categories/search, health, multistream, VOD', () => {
  test('a low-latency broadcast in a category: 1 s segments, browse + search, health samples, VOD afterwards', async () => {
    const s = await newStreamer('vod');
    const category = `Наука ${SUFFIX}`;
    await s.client.patch('/api/channel', { title: `Запись ${SUFFIX}`, category, lowLatency: true });
    const container = publish('vod', 'host', rtmpH264(s.key, 90, 1));

    const live = await waitFor('low-latency live', async () => {
      const d = (await s.client.get('/api/dashboard')).json;
      return d.live?.playbackUrl ? d.live : null;
    }, 60_000);
    assert.equal(live.latencyMode, 'low');
    const variant = await (await fetch(new URL(live.playbackUrl.replace('master.m3u8', '360p/index.m3u8'), HLS_ORIGIN))).text();
    assert.match(variant, /#EXT-X-TARGETDURATION:1\n/, '1 s segments in low-latency mode');

    // browse & search
    const cats = (await new Client().get('/api/categories')).json.categories as { name: string; liveCount: number }[];
    assert.ok(cats.some((c) => c.name === category && c.liveCount >= 1));
    const inCat = (await new Client().get(`/api/streams?category=${encodeURIComponent(category.toUpperCase())}`)).json.streams;
    assert.deepEqual(inCat.map((x: { channel: { slug: string } }) => x.channel.slug), [s.slug]);
    const found = (await new Client().get(`/api/search?q=${encodeURIComponent(s.username.slice(0, 8))}`)).json;
    assert.ok(found.channels.some((c: { channel: { slug: string }; live: unknown }) => c.channel.slug === s.slug && c.live));

    // health samples accumulate while live
    await waitFor('health samples', async () => (await s.client.get('/api/dashboard/health')).json.samples.length >= 2, 40_000, 2000);

    // after the stream ends (+ reconnect grace) it becomes a VOD
    stopPublisher(container);
    const video = await waitFor('VOD', async () => {
      const v = (await new Client().get(`/api/channels/${s.slug}/videos`)).json.videos;
      return v?.[0];
    }, 120_000, 3000);
    assert.equal(video.title, `Запись ${SUFFIX}`);
    assert.ok(video.durationSec >= 10 && video.durationSec <= 90, `duration ${video.durationSec}`);
    const master = await (await fetch(new URL(video.playbackUrl, HLS_ORIGIN))).text();
    const firstVariant = master.split('\n').find((l) => l.endsWith('/vod.m3u8'))!;
    const vodPl = await (await fetch(new URL(firstVariant, new URL(video.playbackUrl, HLS_ORIGIN)))).text();
    assert.match(vodPl, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(vodPl, /#EXT-X-ENDLIST\n$/);
    const firstSeg = vodPl.match(/seg_\d+\.m4s/)![0];
    const seg = await fetch(new URL(firstSeg, new URL(firstVariant, new URL(video.playbackUrl, HLS_ORIGIN))));
    assert.equal(seg.status, 200, 'the very first segment of the broadcast is still there');

    // views: one per viewer
    const viewer = new Client();
    await viewer.post(`/api/videos/${video.id}/view`, { viewerId: `v-${SUFFIX}-1` });
    await viewer.post(`/api/videos/${video.id}/view`, { viewerId: `v-${SUFFIX}-1` });
    assert.equal((await viewer.get(`/api/videos/${video.id}`)).json.video.views, 1);

    // only the owner can delete
    assert.equal((await viewer.del(`/api/videos/${video.id}`)).status, 401);
    assert.equal((await s.client.del(`/api/videos/${video.id}`)).status, 204);
    assert.equal((await viewer.get(`/api/videos/${video.id}`)).status, 404);
  });

  test('multitrack (OBS Enhanced Broadcasting): streamer-encoded renditions are served as-is', async () => {
    const s = await newStreamer('mtrack');
    // One connection, two H.264 video tracks (720p + 360p) — what OBS multitrack video sends.
    const container = publish('mtrack', `${PROJECT}_default`, [...SOURCE(1280, 720, 30),
      '-filter_complex', '[0:v]split=2[a][b];[b]scale=640:360[b2]', '-map', '[a]', '-map', '[b2]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-bf', '0', '-b:v:0', '2500k', '-b:v:1', '700k', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-t', '120', '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://ingest:8554/live/${s.key}`]);
    try {
      const live = await waitFor('multitrack live', async () => {
        const d = (await s.client.get('/api/dashboard')).json;
        return d.live?.renditions?.length ? d.live : null;
      }, 60_000);
      const byName = Object.fromEntries(live.renditions.map((r: { name: string }) => [r.name, r]));
      assert.equal(byName.source?.passthrough, true);
      assert.equal(byName['obs-360p']?.passthrough, true, 'the 360p track from the encoder is passed through');
      assert.equal(byName['360p'], undefined, 'the server does not re-encode what the streamer already sent');
      assert.ok(byName['480p'] && byName['160p'], 'missing rungs are filled by the server');
    } finally {
      stopPublisher(container);
    }
  });

  test('multistream: destinations are validated (SSRF) and pushed while live', async (t) => {
    const a = await newStreamer('mstr');
    const b = await newStreamer('mdst');
    const probe = await a.client.post('/api/channel/restreams', {
      name: 'Второй канал', service: 'custom', url: 'rtmp://ingest:1935/live', streamKey: b.key,
    });
    if (probe.status === 400) {
      assert.match(probe.json.error.message, /внутренней/);
      t.skip('RESTREAM_ALLOW_PRIVATE is off: internal targets are rejected (SSRF protection verified)');
      return;
    }
    assert.equal(probe.status, 201, JSON.stringify(probe.json));
    assert.equal(probe.json.destination.keyMasked, `••••${b.key.slice(-4)}`);
    assert.ok(!JSON.stringify((await a.client.get('/api/channel/restreams')).json).includes(b.key), 'the key is never returned');

    const container = publish('mstr', 'host', rtmpH264(a.key, 120));
    try {
      // A goes live → the worker pushes A to B's ingest → B goes live too.
      const status = await waitFor('restream live', async () => {
        const d = (await a.client.get('/api/dashboard')).json;
        return d.live?.stats.restreams.find((r: { state: string }) => r.state === 'live');
      }, 60_000, 2000);
      assert.equal(status.id, probe.json.destination.id);
      const bLive = await waitFor('target channel live', async () => (await new Client().get(`/api/channels/${b.slug}`)).json.live, 60_000, 2000);
      assert.equal(bLive.source.protocol, 'rtmp');

      // disabling the destination stops the push within a sync period
      await a.client.patch(`/api/channel/restreams/${probe.json.destination.id}`, { enabled: false });
      await waitFor('target channel stops', async () => (await new Client().get(`/api/channels/${b.slug}`)).json.live?.status !== 'live', 60_000, 2000);
    } finally {
      stopPublisher(container);
    }
  });
});

