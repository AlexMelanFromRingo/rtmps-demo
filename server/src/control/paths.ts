// Pure helpers for ingest paths and protocols (no I/O; unit tested).
import { STREAM_KEY_RE } from '../lib/crypto.ts';

export function streamKeyFromPath(path: string): string | null {
  const m = /^live\/([^/]+)$/.exec(path);
  return m && STREAM_KEY_RE.test(m[1]!) ? m[1]! : null;
}

export function protocolFromSourceType(t: string | undefined | null, query?: string | null): string {
  // The universal SRT gateway re-publishes over RTSP and tags it with via=srt.
  // MediaMTX hands hooks the query URL-escaped as a whole (MTX_QUERY=via%3Dsrt).
  if (query) {
    let q = query;
    try { if (!q.includes('=')) q = decodeURIComponent(q); } catch { /* keep raw */ }
    if (new URLSearchParams(q).get('via') === 'srt') return 'srt';
  }
  switch (t) {
    case 'rtmpConn': case 'rtmpsConn': return 'rtmp';
    case 'srtConn': return 'srt';
    case 'webRTCSession': return 'webrtc';
    case 'rtspSession': case 'rtspsSession': return 'rtsp';
    default: return 'unknown';
  }
}
