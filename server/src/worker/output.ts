// Per-job HLS publisher: receives files from ffmpeg (via SegmentReceiver) and
// uploads them to object storage preserving per-variant order, so a playlist
// is never visible before the segments it references. Writes the master
// playlist once variants start producing media.
import { buildMasterPlaylist, parseMediaPlaylist, AUDIO_DIR, type ObservedBitrates } from './master.ts';
import type { LadderPlan, Variant } from './ladder.ts';
import type { FileEvent, JobSink } from './receiver.ts';
import type { Logger } from '../lib/log.ts';
import { VOD_PLAYLIST, type VodRecorder } from './vod.ts';

export type PutFn = (key: string, body: Buffer | string, contentType: string, cacheControl: string, signal: AbortSignal) => Promise<void>;
export type DeleteFn = (key: string, signal: AbortSignal) => Promise<void>;

export type ReadyInfo = { variants: Variant[]; observed: ObservedBitrates };

type Meta = { contentType: string; cacheControl: string };

export function fileMeta(file: string): Meta {
  if (file.endsWith('.m3u8')) return { contentType: 'application/vnd.apple.mpegurl', cacheControl: 'public, max-age=1' };
  if (file.endsWith('.m4s')) return { contentType: 'video/iso.segment', cacheControl: 'public, max-age=86400, immutable' };
  if (file.endsWith('.mp4')) return { contentType: 'video/mp4', cacheControl: 'public, max-age=86400, immutable' };
  if (file.endsWith('.jpg')) return { contentType: 'image/jpeg', cacheControl: 'public, max-age=5' };
  return { contentType: 'application/octet-stream', cacheControl: 'no-store' };
}

/** Drops the given segments (EXTINF + per-segment tags + URI) from a media playlist. */
export function withoutSegments(playlist: string, drop: ReadonlySet<string>): string {
  if (drop.size === 0) return playlist;
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of playlist.split('\n')) {
    const t = line.trim();
    if (t.startsWith('#EXTINF') || t.startsWith('#EXT-X-PROGRAM-DATE-TIME') || t.startsWith('#EXT-X-BYTERANGE')) {
      pending.push(line);
    } else if (t && !t.startsWith('#')) {
      if (!drop.has(t)) out.push(...pending, line);
      pending = [];
    } else {
      out.push(...pending, line);
      pending = [];
    }
  }
  return out.join('\n');
}

export type OutputStats = {
  uploads: number; failures: number; pending: number; pendingBytes: number;
  lastSegmentAt: number | null; lastUploadAt: number | null;
};

const SEGMENT_RETRIES = [500, 1000, 2000];

export class JobOutput implements JobSink {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pendingByChain = new Map<string, number>();
  private readonly segmentBytes = new Map<string, number>();
  private readonly failedSegments = new Map<string, Set<string>>(); // variant -> segment files
  private readonly readyVariants = new Set<string>();
  private readonly observed: ObservedBitrates = {};
  private publishedSignature = '';
  readonly stats: OutputStats = { uploads: 0, failures: 0, pending: 0, pendingBytes: 0, lastSegmentAt: null, lastUploadAt: null };
  private closed = false;
  private readonly abortCtl = new AbortController();
  private readonly prefix: string; // live/<broadcastId>/
  private readonly plan: LadderPlan;
  private readonly put: PutFn;
  private readonly del: DeleteFn;
  private readonly onReady: (info: ReadyInfo) => Promise<void>;
  private readonly log: Logger;
  private readonly settleMs: number;
  private settleTimer: NodeJS.Timeout | null = null;
  private settled = false;
  private readonly vod: VodRecorder | null;

  constructor(opts: {
    prefix: string; plan: LadderPlan; put: PutFn; del: DeleteFn;
    onReady: (info: ReadyInfo) => Promise<void>; log: Logger;
    /** How long to wait for the remaining variants before the first master is published. */
    settleMs?: number;
    /** Records the broadcast as VOD (null when recording is disabled). */
    vod?: VodRecorder | null;
  }) {
    this.vod = opts.vod ?? null;
    this.settleMs = opts.settleMs ?? 3000;
    this.prefix = opts.prefix;
    this.plan = opts.plan;
    this.put = opts.put;
    this.del = opts.del;
    this.onReady = opts.onReady;
    this.log = opts.log;
  }

  get aborted(): boolean {
    return this.abortCtl.signal.aborted;
  }

  onFile({ variant, file, body }: FileEvent): void {
    if (this.closed) return;
    const key = variant ? `${this.prefix}${variant}/${file}` : `${this.prefix}${file}`;
    const meta = fileMeta(file);
    const isSegment = file.endsWith('.m4s') || file.endsWith('.mp4');
    if (file.endsWith('.m4s') && variant) {
      this.segmentBytes.set(`${variant}/${file}`, body.length);
      this.stats.lastSegmentAt = Date.now();
    }
    this.enqueue(variant ?? `_${file}`, body.length, async (signal) => {
      if (variant && file === 'index.m3u8') {
        // Never publish a playlist entry whose segment failed to upload.
        const text = withoutSegments(body.toString('utf8'), this.failedSegments.get(variant) ?? new Set());
        await this.put(key, text, meta.contentType, meta.cacheControl, signal);
        this.vod?.onPlaylist(variant, text);
        await this.onPlaylistUploaded(variant, text);
      } else if (isSegment && variant) {
        await this.putWithRetry(key, body, meta, signal, variant, file);
      } else {
        await this.put(key, body, meta.contentType, meta.cacheControl, signal);
      }
    });
  }

  onDelete(variant: string | null, file: string): void {
    if (this.closed) return;
    const key = variant ? `${this.prefix}${variant}/${file}` : `${this.prefix}${file}`;
    if (variant) {
      this.segmentBytes.delete(`${variant}/${file}`);
      this.failedSegments.get(variant)?.delete(file);
    }
    // Queued behind the uploads of this variant, so we never delete before writing.
    this.enqueue(variant ?? `_${file}`, 0, (signal) => this.del(key, signal));
  }

  /** Graceful end: wait for queued uploads (bounded). */
  async drain(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    if (this.settleTimer) {
      // Don't lose a pending first master: publish whatever is ready now.
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
      this.enqueue('_master', 0, () => this.maybePublishMaster());
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.chains.values()]),
      new Promise((r) => { timer = setTimeout(r, timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (this.stats.pending > 0) this.abort(); // give up on the rest, free the buffers
  }

  /** Fenced off (lease lost) or stuck: stop writing immediately and drop queued work. */
  abort(): void {
    this.closed = true;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    this.abortCtl.abort();
  }

  private async putWithRetry(key: string, body: Buffer, meta: Meta, signal: AbortSignal, variant: string, file: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.put(key, body, meta.contentType, meta.cacheControl, signal);
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        const delay = SEGMENT_RETRIES[attempt];
        if (delay === undefined) {
          let set = this.failedSegments.get(variant);
          if (!set) this.failedSegments.set(variant, (set = new Set()));
          set.add(file);
          throw err;
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private enqueue(chain: string, bytes: number, task: (signal: AbortSignal) => Promise<void>): void {
    const pending = (this.pendingByChain.get(chain) ?? 0) + 1;
    this.pendingByChain.set(chain, pending);
    this.stats.pending++;
    this.stats.pendingBytes += bytes;
    if (pending > 50 && pending % 50 === 1) this.log.warn({ chain, pending }, 'object storage is falling behind');
    const signal = this.abortCtl.signal;
    const prev = this.chains.get(chain) ?? Promise.resolve();
    const next = prev.then(() => (signal.aborted ? undefined : task(signal))).then(
      () => { if (!signal.aborted) { this.stats.uploads++; this.stats.lastUploadAt = Date.now(); } },
      (err: unknown) => {
        if (signal.aborted) return;
        this.stats.failures++;
        this.log.warn({ err: (err as Error).message, chain }, 'upload failed');
      },
    ).finally(() => {
      this.stats.pending--;
      this.stats.pendingBytes -= bytes;
      this.pendingByChain.set(chain, (this.pendingByChain.get(chain) ?? 1) - 1);
    });
    this.chains.set(chain, next);
  }

  private async onPlaylistUploaded(variant: string, playlist: string): Promise<void> {
    // Observed average bitrate of what is actually in the playlist window.
    const { segments } = parseMediaPlaylist(playlist);
    let bytes = 0;
    let seconds = 0;
    for (const s of segments) {
      const size = this.segmentBytes.get(`${variant}/${s.uri}`);
      if (size !== undefined) { bytes += size; seconds += s.duration; }
    }
    if (seconds > 0) this.observed[variant] = (bytes * 8) / seconds / 1000;
    if (segments.length === 0 || this.readyVariants.has(variant)) return;

    this.readyVariants.add(variant);
    // All master writes go through one chain: no out-of-order overwrite.
    this.enqueue('_master', 0, () => this.maybePublishMaster());
  }

  private async maybePublishMaster(): Promise<void> {
    if (this.aborted) return;
    if (this.plan.audio && !this.readyVariants.has(AUDIO_DIR)) return;
    const ready = this.plan.variants.filter((v) => this.readyVariants.has(v.name));
    if (ready.length === 0) return;
    // Give slower variants (e.g. a passthrough source cut on its own GOP) a
    // moment so the first master is complete and keeps the start variant first.
    if (!this.settled && !this.closed && ready.length < this.plan.variants.length) {
      this.settleTimer ??= setTimeout(() => {
        this.settled = true;
        this.enqueue('_master', 0, () => this.maybePublishMaster());
      }, this.settleMs);
      return;
    }
    this.settled = true;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    const signature = ready.map((v) => v.name).join(',');
    if (signature === this.publishedSignature) return;

    const text = buildMasterPlaylist({ ...this.plan, variants: ready }, this.observed);
    await this.put(`${this.prefix}master.m3u8`, text, 'application/vnd.apple.mpegurl', 'public, max-age=2', this.abortCtl.signal);
    if (this.vod) {
      const vodMaster = buildMasterPlaylist({ ...this.plan, variants: ready }, this.observed, VOD_PLAYLIST);
      await this.put(`${this.prefix}${VOD_PLAYLIST}`, vodMaster, 'application/vnd.apple.mpegurl', 'public, max-age=5', this.abortCtl.signal);
    }
    this.publishedSignature = signature; // only after the write succeeded
    this.log.info({ variants: signature }, 'master playlist published');
    await this.onReady({ variants: ready, observed: { ...this.observed } });
  }
}
