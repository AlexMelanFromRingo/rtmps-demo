import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VodRecorder, finalizeVodPlaylist, parseLivePlaylist, parseVodBody, renderVodPlaylist, vodDuration,
} from '../../src/worker/vod.ts';
import { log } from '../../src/lib/log.ts';

const live = (init: string, segs: [number, number][], pdtBase = 0) => [
  '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${segs[0]![0]}`,
  '#EXT-X-DISCONTINUITY', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="${init}"`,
  ...segs.flatMap(([n, d], i) => [`#EXTINF:${d.toFixed(6)},`, `#EXT-X-PROGRAM-DATE-TIME:2026-11-03T12:00:${String(pdtBase + i * 2).padStart(2, '0')}.000+0000`, `seg_${n}.m4s`]),
].join('\n');

function harness() {
  const store = new Map<string, string>();
  const rec = () => new VodRecorder({
    prefix: 'live/b/', log,
    put: async (k, b) => { store.set(k, b); },
    get: async (k) => store.get(k) ?? null,
  });
  return { store, rec };
}

test('parseLivePlaylist extracts sequence, init, duration and PDT', () => {
  const segs = parseLivePlaylist(live('init_a_720p.mp4', [[100, 2], [101, 1.5]]));
  assert.deepEqual(segs.map((s) => [s.seq, s.uri, s.duration, s.map]), [[100, 'seg_100.m4s', 2, 'init_a_720p.mp4'], [101, 'seg_101.m4s', 1.5, 'init_a_720p.mp4']]);
  assert.match(segs[0]!.pdt!, /^2026-11-03T12:00:00/);
});

test('the recorder appends each segment exactly once across sliding-window updates', async () => {
  const { store, rec } = harness();
  const r = rec();
  r.onPlaylist('720p', live('init_a_720p.mp4', [[100, 2], [101, 2]]));
  r.onPlaylist('720p', live('init_a_720p.mp4', [[101, 2], [102, 2], [103, 2]]));
  await r.flush();
  const text = store.get('live/b/720p/vod.m3u8')!;
  assert.equal(text.match(/seg_\d+\.m4s/g)!.join(','), 'seg_100.m4s,seg_101.m4s,seg_102.m4s,seg_103.m4s');
  assert.match(text, /#EXT-X-PLAYLIST-TYPE:EVENT/);
  assert.doesNotMatch(text, /ENDLIST/);
  assert.equal(text.match(/#EXT-X-MAP/g)!.length, 1);
  assert.equal(vodDuration(text), 8);
});

test('a failed-over worker resumes the recording with a discontinuity and the new init', async () => {
  const { store, rec } = harness();
  const first = rec();
  first.onPlaylist('720p', live('init_a_720p.mp4', [[100, 2], [101, 2]]));
  await first.flush();
  // new worker, new encoder session (epoch-based numbering keeps growing)
  const second = rec();
  await second.resume(['720p', 'audio']);
  second.onPlaylist('720p', live('init_b_720p.mp4', [[180, 2], [181, 2]]));
  await second.flush();
  const text = store.get('live/b/720p/vod.m3u8')!;
  assert.equal(text.match(/seg_\d+\.m4s/g)!.join(','), 'seg_100.m4s,seg_101.m4s,seg_180.m4s,seg_181.m4s');
  assert.match(text, /seg_101\.m4s\n#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init_b_720p\.mp4"/);
  const body = parseVodBody(text);
  assert.equal(body.lastSeq, 181);
});

test('finalize turns EVENT into VOD with ENDLIST, idempotently', () => {
  const ev = renderVodPlaylist(['#EXT-X-MAP:URI="i.mp4"', '#EXTINF:2.000000,', 'seg_1.m4s'], 2, false);
  const vod = finalizeVodPlaylist(ev);
  assert.match(vod, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(vod, /seg_1\.m4s\n#EXT-X-ENDLIST\n$/);
  assert.equal(finalizeVodPlaylist(vod), vod);
});
