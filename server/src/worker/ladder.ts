// Adaptive-bitrate ladder planning. Pure — see test/unit/ladder.test.ts.
//
// Policy:
//  * Sources in a browser-playable codec (H.264 / HEVC / AV1) are always
//    offered untouched as the "source" rendition (no generation loss, no CPU).
//  * `abr` mode adds H.264 renditions strictly below the source resolution,
//    plus an H.264 rendition *at* the source resolution when the source is
//    not H.264 (so every browser can watch the top quality) or when it can't
//    be passed through at all (VP8/VP9/MPEG-2...).
//  * `passthrough` mode only offers the source (or one H.264 copy of it if
//    the codec can't be passed through).
//  * `degraded` (capacity exhausted): source only, plus one cheap ≤480p H.264
//    rendition when the source is not H.264 so every browser can still watch.
//  * Never upscale; renditions ≤480p are capped at 30 fps.
//  * Resolutions refer to the *short* side so vertical video works too.
import {
  AAC_LC, PASSTHROUGH_CODECS, av1CodecString, bitDepth, h264CodecString, h264LevelFor, hevcCodecString,
} from './codecs.ts';

export type TranscodeMode = 'abr' | 'passthrough';
/** 'degraded' is chosen by the worker when no full transcoding capacity is left. */
export type PlanMode = TranscodeMode | 'degraded';
export const DEGRADED_MAX_SHORT = 480;

export type ProbedTrack = {
  videoCodec: string;          // H264 | H265 | AV1 | VP9 | VP8 | ...
  width: number;
  height: number;
  fps: number;
  profile?: string | undefined;
  level?: number | undefined;
  pixFmt?: string | undefined;
};

/** The primary (largest) video track + optional extra renditions sent by the encoder. */
export type ProbedSource = ProbedTrack & {
  hasAudio: boolean;
  audioCodec?: string | null | undefined;
  /** Index of the primary track among the input's video streams (0:v:N). */
  track?: number | undefined;
  /**
   * Further video tracks encoded by the streamer's software — OBS "Enhanced
   * Broadcasting" / multitrack video. Offered as-is; the server only encodes
   * the rungs nobody sent.
   */
  extraTracks?: (ProbedTrack & { track: number })[] | undefined;
};

export type Variant = {
  name: string;                // playlist directory + NAME attribute
  label: string;               // human label for the UI
  kind: 'copy' | 'encode';
  codec: 'H264' | 'H265' | 'AV1';
  codecString: string;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;         // target/average
  maxrateKbps: number;         // peak (BANDWIDTH)
  bufsizeKbps: number;
  h264Level?: number;          // encode only
  track?: number;              // copy only: input video track (0:v:N)
};

export type LadderPlan = {
  variants: Variant[];         // in master playlist order (first = start variant)
  audio: { bitrateKbps: number; codecString: string } | null;
  decodeKeyframesOnly: boolean; // nothing to encode → decode keyframes for thumbnails only
};

export type Rung = { short: number; kbps30: number; kbps60: number };

export const DEFAULT_RUNGS: readonly Rung[] = [
  { short: 1080, kbps30: 4500, kbps60: 6000 },
  { short: 720, kbps30: 2500, kbps60: 3500 },
  { short: 480, kbps30: 1200, kbps60: 1200 },
  { short: 360, kbps30: 700, kbps60: 700 },
  { short: 160, kbps30: 250, kbps60: 250 },
];

export const MAX_ENCODE_SHORT = 1080;
export const AUDIO_KBPS = 160;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function parseRungs(spec: string | undefined): readonly Rung[] {
  if (!spec) return DEFAULT_RUNGS;
  const wanted = spec.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  const rungs = DEFAULT_RUNGS.filter((r) => wanted.includes(r.short));
  return rungs.length > 0 ? rungs : DEFAULT_RUNGS;
}

/** Halve the frame rate until it fits the cap (keeps cadence: 59.94→29.97, 50→25). */
export function cappedFps(srcFps: number, cap: number): number {
  let fps = srcFps > 0 && Number.isFinite(srcFps) ? srcFps : 30;
  let div = 1;
  while (fps / div > cap + 0.5) div++;
  fps = fps / div;
  return Math.round(fps * 1000) / 1000;
}

/** Bitrate for an arbitrary short side by scaling the nearest rung by pixel count. */
function bitrateFor(short: number, fps: number, rungs: readonly Rung[]): number {
  const exact = rungs.find((r) => r.short === short) ?? DEFAULT_RUNGS.find((r) => r.short === short);
  const pick = (r: Rung) => (fps > 31 ? r.kbps60 : r.kbps30);
  if (exact) return pick(exact);
  const sorted = [...DEFAULT_RUNGS].sort((a, b) => a.short - b.short);
  const ref = sorted.find((r) => r.short >= short) ?? sorted[sorted.length - 1]!;
  return Math.round((pick(ref) * (short * short)) / (ref.short * ref.short) / 50) * 50 || 250;
}

function renditionName(short: number, fps: number): string {
  return fps > 31 ? `${short}p${Math.round(fps)}` : `${short}p`;
}

function dimensions(srcW: number, srcH: number, short: number): { width: number; height: number } {
  const landscape = srcW >= srcH;
  const srcShort = landscape ? srcH : srcW;
  const srcLong = landscape ? srcW : srcH;
  const long = even((short * srcLong) / srcShort);
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

/** Rough bitrate estimate for a passthrough source before we observe real segment sizes. */
export function estimateSourceKbps(codec: string, w: number, h: number, fps: number): number {
  const bpp = codec === 'AV1' ? 0.05 : codec === 'H265' ? 0.06 : 0.09;
  return Math.max(500, Math.round((w * h * (fps || 30) * bpp) / 1000 / 100) * 100);
}

export function sourceCodecString(src: ProbedTrack): string {
  const depth = bitDepth(src.pixFmt);
  switch (src.videoCodec) {
    case 'H264': return h264CodecString(src.profile, src.level);
    case 'H265': return hevcCodecString(src.profile, src.level);
    case 'AV1': return av1CodecString(src.profile, src.level, depth, src.width, src.height, src.fps);
    default: throw new Error(`no passthrough codec string for ${src.videoCodec}`);
  }
}

export function planLadder(src: ProbedSource, mode: PlanMode, rungs: readonly Rung[] = DEFAULT_RUNGS): LadderPlan {
  if (!(src.width > 0 && src.height > 0)) throw new Error('source has no video dimensions');
  const srcShort = Math.min(src.width, src.height);
  const srcFps = src.fps > 0 ? src.fps : 30;
  // 10-bit sources can't be passed to H.264-only devices anyway; still OK for copy.
  const copyable = PASSTHROUGH_CODECS.has(src.videoCodec);

  const variants: Variant[] = [];

  if (copyable) {
    const kbps = estimateSourceKbps(src.videoCodec, src.width, src.height, srcFps);
    const fpsLabel = srcFps > 31 ? String(Math.round(srcFps)) : '';
    variants.push({
      name: 'source',
      label: `${srcShort}p${fpsLabel} · ${src.videoCodec} (источник)`,
      kind: 'copy',
      codec: src.videoCodec as Variant['codec'],
      codecString: sourceCodecString(src),
      width: src.width,
      height: src.height,
      fps: Math.round(srcFps * 1000) / 1000,
      bitrateKbps: kbps,
      maxrateKbps: Math.round(kbps * 1.3),
      bufsizeKbps: kbps * 2,
      track: src.track ?? 0,
    });
  }

  // Extra renditions encoded by the streamer (OBS multitrack / Enhanced Broadcasting).
  const providedShorts = new Set<number>(copyable ? [srcShort] : []);
  for (const t of src.extraTracks ?? []) {
    if (!PASSTHROUGH_CODECS.has(t.videoCodec) || !(t.width > 0 && t.height > 0)) continue;
    const short = Math.min(t.width, t.height);
    if (providedShorts.has(short)) continue; // duplicate size
    providedShorts.add(short);
    const tfps = t.fps > 0 ? t.fps : srcFps;
    const kbps = estimateSourceKbps(t.videoCodec, t.width, t.height, tfps);
    const name = `obs-${renditionName(short, tfps)}`;
    variants.push({
      name,
      label: `${renditionName(short, tfps)} · ${t.videoCodec} (из OBS)`,
      kind: 'copy',
      codec: t.videoCodec as Variant['codec'],
      codecString: sourceCodecString(t),
      width: t.width,
      height: t.height,
      fps: Math.round(tfps * 1000) / 1000,
      bitrateKbps: kbps,
      maxrateKbps: Math.round(kbps * 1.3),
      bufsizeKbps: kbps * 2,
      track: t.track,
    });
  }
  // A rung the streamer already sends in H.264 needs no server-side encode.
  const providedH264 = new Set(variants.filter((v) => v.kind === 'copy' && v.codec === 'H264').map((v) => Math.min(v.width, v.height)));

  const encodeShorts = new Set<number>();
  const topShort = Math.min(srcShort, MAX_ENCODE_SHORT);
  if (mode === 'abr') {
    for (const r of rungs) if (r.short < srcShort && r.short <= MAX_ENCODE_SHORT) encodeShorts.add(r.short);
    if (!copyable || src.videoCodec !== 'H264') encodeShorts.add(topShort);
  } else if (mode === 'degraded') {
    if (!copyable || src.videoCodec !== 'H264') encodeShorts.add(Math.min(srcShort, DEGRADED_MAX_SHORT));
  } else if (!copyable) {
    encodeShorts.add(topShort);
  }

  for (const short of [...encodeShorts].sort((a, b) => b - a)) {
    if (providedH264.has(short)) continue;
    const fps = cappedFps(srcFps, short <= 480 ? 30 : 60);
    const { width, height } = dimensions(src.width, src.height, short);
    const kbps = bitrateFor(short, fps, rungs);
    const level = h264LevelFor(width, height, fps);
    const name = renditionName(short, fps);
    variants.push({
      name,
      label: name,
      kind: 'encode',
      codec: 'H264',
      codecString: h264CodecString('High', level),
      width,
      height,
      fps,
      bitrateKbps: kbps,
      maxrateKbps: Math.round(kbps * 1.1),
      bufsizeKbps: kbps * 2,
      h264Level: level,
    });
  }

  // Start variant first in the master playlist: players (hls.js, Safari)
  // begin with the first listed variant. Prefer a universally decodable
  // H.264 rendition close to 720p for a fast, compatible start.
  const encodes = variants.filter((v) => v.kind === 'encode');
  const h264 = variants.filter((v) => v.codec === 'H264');
  const startPool = h264.length > 0 ? h264 : variants;
  const start = startPool.reduce((best, v) => (Math.abs(Math.min(v.width, v.height) - 720) < Math.abs(Math.min(best.width, best.height) - 720) ? v : best));
  const ordered = [start, ...variants.filter((v) => v !== start)];

  return {
    variants: ordered,
    audio: src.hasAudio ? { bitrateKbps: AUDIO_KBPS, codecString: AAC_LC } : null,
    decodeKeyframesOnly: encodes.length === 0,
  };
}

/**
 * Should a running transcode be re-planned? True when the source switched
 * codec or grew noticeably beyond what the ladder was planned for (WebRTC
 * publishers ramp resolution up after connecting; encoders get reconfigured).
 * Shrinking sources are fine: the existing ladder keeps working.
 */
export function sourceUpgraded(planned: ProbedSource, now: ProbedSource): boolean {
  if (now.videoCodec !== planned.videoCodec) return true;
  if ((now.extraTracks?.length ?? 0) !== (planned.extraTracks?.length ?? 0)) return true; // multitrack changed
  if (now.hasAudio && !planned.hasAudio) return true;
  const before = Math.min(planned.width, planned.height);
  const after = Math.min(now.width, now.height);
  return after > before * 1.2;
}
