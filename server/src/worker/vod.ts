// VOD recording: alongside the sliding live playlist each variant gets an
// append-only playlist (`vod.m3u8`) listing every segment of the broadcast.
// It survives failovers (a new worker loads it from storage and continues with
// EXT-X-DISCONTINUITY) and is finalized (PLAYLIST-TYPE:VOD + ENDLIST) by the
// control plane when the broadcast ends.
import type { Logger } from '../lib/log.ts';

export const VOD_PLAYLIST = 'vod.m3u8';

export type ParsedSegment = { seq: number; uri: string; duration: number; pdt: string | null; map: string | null };

const SEG_RE = /seg_(\d+)\.m4s$/;

/** Parses a live media playlist into segments with their init (EXT-X-MAP) and PDT. */
export function parseLivePlaylist(text: string): ParsedSegment[] {
  const out: ParsedSegment[] = [];
  let map: string | null = null;
  let pdt: string | null = null;
  let dur: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) map = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
    else if (line.startsWith('#EXTINF:')) dur = Number.parseFloat(line.slice(8));
    else if (line && !line.startsWith('#') && dur !== null) {
      const m = SEG_RE.exec(line);
      if (m) out.push({ seq: Number(m[1]), uri: line, duration: dur, pdt, map });
      dur = null;
      pdt = null;
    }
  }
  return out;
}

type VariantState = { lines: string[]; lastSeq: number; map: string | null; maxDuration: number; dirty: boolean; resumed: boolean };

/** Body lines (everything after the header) + the last segment number of an existing VOD playlist. */
export function parseVodBody(text: string): { lines: string[]; lastSeq: number; lastMap: string | null; maxDuration: number } {
  const lines: string[] = [];
  let lastSeq = -1;
  let lastMap: string | null = null;
  let maxDuration = 0;
  let inBody = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!inBody) {
      // Header tags end where the first segment-level tag begins.
      if (/^#EXT-X-(DISCONTINUITY|MAP|PROGRAM-DATE-TIME)|^#EXTINF/.test(line)) inBody = true;
      else continue;
    }
    if (line === '#EXT-X-ENDLIST') continue;
    lines.push(line);
    if (line.startsWith('#EXT-X-MAP:')) lastMap = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    if (line.startsWith('#EXTINF:')) maxDuration = Math.max(maxDuration, Number.parseFloat(line.slice(8)) || 0);
    const m = SEG_RE.exec(line);
    if (m && !line.startsWith('#')) lastSeq = Math.max(lastSeq, Number(m[1]));
  }
  return { lines, lastSeq, lastMap, maxDuration };
}

export function renderVodPlaylist(lines: string[], maxDuration: number, final: boolean): string {
  const head = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(maxDuration))}`,
    `#EXT-X-PLAYLIST-TYPE:${final ? 'VOD' : 'EVENT'}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  return `${[...head, ...lines, ...(final ? ['#EXT-X-ENDLIST'] : [])].join('\n')}\n`;
}

/** Total duration (seconds) of a VOD playlist. */
export function vodDuration(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) if (line.startsWith('#EXTINF:')) total += Number.parseFloat(line.slice(8)) || 0;
  return total;
}

/** Turns an EVENT playlist into a finished VOD playlist (idempotent). */
export function finalizeVodPlaylist(text: string): string {
  const { lines, maxDuration } = parseVodBody(text);
  return renderVodPlaylist(lines, maxDuration, true);
}

export class VodRecorder {
  private readonly state = new Map<string, VariantState>();
  private readonly prefix: string;
  private readonly put: (key: string, body: string) => Promise<void>;
  private readonly get: (key: string) => Promise<string | null>;
  private readonly log: Logger;

  constructor(opts: {
    prefix: string;
    put: (key: string, body: string) => Promise<void>;
    get: (key: string) => Promise<string | null>;
    log: Logger;
  }) {
    this.prefix = opts.prefix;
    this.put = opts.put;
    this.get = opts.get;
    this.log = opts.log;
  }

  /** Load what previous attempts of this broadcast already recorded (failover / reconnect). */
  async resume(variants: string[]): Promise<void> {
    await Promise.all(variants.map(async (v) => {
      let text: string | null = null;
      try { text = await this.get(`${this.prefix}${v}/${VOD_PLAYLIST}`); } catch { /* treat as new */ }
      if (!text) return;
      const prev = parseVodBody(text);
      this.state.set(v, { lines: prev.lines, lastSeq: prev.lastSeq, map: prev.lastMap, maxDuration: prev.maxDuration, dirty: false, resumed: true });
    }));
    if (this.state.size > 0) this.log.info({ variants: [...this.state.keys()] }, 'continuing the recording of this broadcast');
  }

  /** Called after a live playlist of `variant` was uploaded (its segments are already in storage). */
  onPlaylist(variant: string, text: string): void {
    let st = this.state.get(variant);
    if (!st) this.state.set(variant, (st = { lines: [], lastSeq: -1, map: null, maxDuration: 0, dirty: false, resumed: false }));
    for (const seg of parseLivePlaylist(text)) {
      if (seg.seq <= st.lastSeq) continue;
      if (seg.map && seg.map !== st.map) {
        // New init segment = new encoder session (failover/re-plan): timestamps restart.
        if (st.lines.length > 0) st.lines.push('#EXT-X-DISCONTINUITY');
        st.lines.push(`#EXT-X-MAP:URI="${seg.map}"`);
        st.map = seg.map;
      }
      if (seg.pdt) st.lines.push(`#EXT-X-PROGRAM-DATE-TIME:${seg.pdt}`);
      st.lines.push(`#EXTINF:${seg.duration.toFixed(6)},`, seg.uri);
      st.lastSeq = seg.seq;
      st.maxDuration = Math.max(st.maxDuration, seg.duration);
      st.dirty = true;
    }
  }

  /** Upload changed VOD playlists (EVENT type while live). */
  async flush(): Promise<void> {
    await Promise.all([...this.state.entries()].map(async ([v, st]) => {
      if (!st.dirty) return;
      st.dirty = false;
      try {
        await this.put(`${this.prefix}${v}/${VOD_PLAYLIST}`, renderVodPlaylist(st.lines, st.maxDuration, false));
      } catch (err) {
        st.dirty = true; // retry on the next flush
        this.log.warn({ err: (err as Error).message, variant: v }, 'vod playlist upload failed');
      }
    }));
  }
}
