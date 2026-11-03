// Per-job HLS publisher: receives files from ffmpeg (via SegmentReceiver) and
// uploads them to object storage preserving per-variant order, so a playlist
// is never visible before the segments it references. Writes the master
// playlist once variants start producing media.
import { buildMasterPlaylist, parseMediaPlaylist, AUDIO_DIR, type ObservedBitrates } from './master.ts';
import type { LadderPlan, Variant } from './ladder.ts';
import type { FileEvent, JobSink } from './receiver.ts';
import type { Logger } from '../lib/log.ts';

export type PutFn = (key: string, body: Buffer | string, contentType: string, cacheControl: string) => Promise<void>;
export type DeleteFn = (key: string) => Promise<void>;

export type ReadyInfo = { variants: Variant[]; observed: ObservedBitrates };

type Meta = { contentType: string; cacheControl: string };

export function fileMeta(file: string): Meta {
  if (file.endsWith('.m3u8')) return { contentType: 'application/vnd.apple.mpegurl', cacheControl: 'public, max-age=1' };
  if (file.endsWith('.m4s')) return { contentType: 'video/iso.segment', cacheControl: 'public, max-age=86400, immutable' };
  if (file.endsWith('.mp4')) return { contentType: 'video/mp4', cacheControl: 'public, max-age=86400, immutable' };
  if (file.endsWith('.jpg')) return { contentType: 'image/jpeg', cacheControl: 'public, max-age=5' };
  return { contentType: 'application/octet-stream', cacheControl: 'no-store' };
}

export type OutputStats = { uploads: number; failures: number; pending: number; lastSegmentAt: number | null };

export class JobOutput implements JobSink {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pendingByChain = new Map<string, number>();
  private readonly segmentBytes = new Map<string, number>();
  private readonly readyVariants = new Set<string>();
  private readonly observed: ObservedBitrates = {};
  private publishedSignature = '';
  readonly stats: OutputStats = { uploads: 0, failures: 0, pending: 0, lastSegmentAt: null };
  private closed = false;
  private readonly prefix: string; // live/<broadcastId>/
  private readonly plan: LadderPlan;
  private readonly put: PutFn;
  private readonly del: DeleteFn;
  private readonly onReady: (info: ReadyInfo) => Promise<void>;
  private readonly log: Logger;
  private readonly settleMs: number;
  private settleTimer: NodeJS.Timeout | null = null;
  private settled = false;

  constructor(opts: {
    prefix: string; plan: LadderPlan; put: PutFn; del: DeleteFn;
    onReady: (info: ReadyInfo) => Promise<void>; log: Logger;
    /** How long to wait for the remaining variants before the first master is published. */
    settleMs?: number;
  }) {
    this.settleMs = opts.settleMs ?? 3000;
    this.prefix = opts.prefix;
    this.plan = opts.plan;
    this.put = opts.put;
    this.del = opts.del;
    this.onReady = opts.onReady;
    this.log = opts.log;
  }

  onFile({ variant, file, body }: FileEvent): void {
    if (this.closed) return;
    const key = variant ? `${this.prefix}${variant}/${file}` : `${this.prefix}${file}`;
    const meta = fileMeta(file);
    if (file.endsWith('.m4s') && variant) {
      this.segmentBytes.set(`${variant}/${file}`, body.length);
      this.stats.lastSegmentAt = Date.now();
    }
    this.enqueue(variant ?? `_${file}`, async () => {
      await this.put(key, body, meta.contentType, meta.cacheControl);
      if (variant && file === 'index.m3u8') await this.onPlaylistUploaded(variant, body.toString('utf8'));
    });
  }

  onDelete(variant: string | null, file: string): void {
    if (this.closed) return;
    const key = variant ? `${this.prefix}${variant}/${file}` : `${this.prefix}${file}`;
    if (variant) this.segmentBytes.delete(`${variant}/${file}`);
    // Queued behind the uploads of this variant, so we never delete before writing.
    this.enqueue(variant ?? `_${file}`, () => this.del(key));
  }

  /** Wait for all queued uploads (used on job shutdown). */
  async drain(timeoutMs = 5000): Promise<void> {
    this.closed = true;
    if (this.settleTimer) {
      // Don't lose a pending first master: publish whatever is ready now.
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
      this.enqueue('_master', () => this.maybePublishMaster());
    }
    await Promise.race([
      Promise.allSettled([...this.chains.values()]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  private enqueue(chain: string, task: () => Promise<void>): void {
    const pending = (this.pendingByChain.get(chain) ?? 0) + 1;
    this.pendingByChain.set(chain, pending);
    this.stats.pending++;
    if (pending > 50 && pending % 50 === 1) this.log.warn({ chain, pending }, 'object storage is falling behind');
    const prev = this.chains.get(chain) ?? Promise.resolve();
    const next = prev.then(task).then(
      () => { this.stats.uploads++; },
      (err: unknown) => {
        this.stats.failures++;
        this.log.warn({ err: (err as Error).message, chain }, 'upload failed');
      },
    ).finally(() => {
      this.stats.pending--;
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
    if (segments.length === 0) return;

    this.readyVariants.add(variant);
    await this.maybePublishMaster();
  }

  private async maybePublishMaster(): Promise<void> {
    if (this.plan.audio && !this.readyVariants.has(AUDIO_DIR)) return;
    const ready = this.plan.variants.filter((v) => this.readyVariants.has(v.name));
    if (ready.length === 0) return;
    // Give slower variants (e.g. a passthrough source cut on its own GOP) a
    // moment so the first master is complete and keeps the start variant first.
    if (!this.settled && !this.closed && ready.length < this.plan.variants.length) {
      this.settleTimer ??= setTimeout(() => {
        this.settled = true;
        this.enqueue('_master', () => this.maybePublishMaster());
      }, this.settleMs);
      return;
    }
    this.settled = true;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    const signature = ready.map((v) => v.name).join(',');
    if (signature === this.publishedSignature) return;
    this.publishedSignature = signature;

    const text = buildMasterPlaylist({ ...this.plan, variants: ready }, this.observed);
    await this.put(`${this.prefix}master.m3u8`, text, 'application/vnd.apple.mpegurl', 'public, max-age=2');
    this.log.info({ variants: signature }, 'master playlist published');
    await this.onReady({ variants: ready, observed: { ...this.observed } });
  }
}
