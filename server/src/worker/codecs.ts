// Codec naming + RFC 6381 codec strings for HLS master playlists.
// Pure functions — unit tested in test/unit/codecs.test.ts.

export type VideoCodec = 'H264' | 'H265' | 'AV1' | 'VP9' | 'VP8';

const FFMPEG_TO_NAME: Record<string, string> = {
  h264: 'H264', hevc: 'H265', av1: 'AV1', vp9: 'VP9', vp8: 'VP8',
  mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4',
  aac: 'AAC', opus: 'Opus', mp3: 'MP3', ac3: 'AC3', flac: 'FLAC',
  pcm_alaw: 'G711', pcm_mulaw: 'G711', g722: 'G722',
};

export function codecName(ffmpegCodec: string | null | undefined): string | null {
  if (!ffmpegCodec) return null;
  return FFMPEG_TO_NAME[ffmpegCodec] ?? ffmpegCodec.toUpperCase();
}

// Sources in these codecs can be re-muxed into fMP4 HLS as-is ("source"
// quality, zero transcoding cost) and are decodable by modern browsers.
export const PASSTHROUGH_CODECS: ReadonlySet<string> = new Set(['H264', 'H265', 'AV1']);

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

const H264_PROFILES: Record<string, [number, number]> = {
  'Constrained Baseline': [0x42, 0xc0],
  Baseline: [0x42, 0x00],
  Main: [0x4d, 0x40],
  Extended: [0x58, 0x00],
  High: [0x64, 0x00],
  'Progressive High': [0x64, 0x08],
  'Constrained High': [0x64, 0x0c],
  'High 10': [0x6e, 0x00],
  'High 4:2:2': [0x7a, 0x00],
  'High 4:4:4 Predictive': [0xf4, 0x00],
};

/** avc1.PPCCLL — level is ffprobe's level (e.g. 31 for 3.1). */
export function h264CodecString(profile: string | undefined, level: number | undefined): string {
  const [p, c] = H264_PROFILES[profile ?? ''] ?? [0x64, 0x00];
  const l = level && level > 0 ? level : 40;
  return `avc1.${hex2(p)}${hex2(c)}${hex2(l)}`;
}

/** hvc1.<profile>.<compat>.L<level>.B0 — level is general_level_idc (e.g. 120 for 4.0). */
export function hevcCodecString(profile: string | undefined, level: number | undefined): string {
  const l = level && level > 0 ? level : 120;
  if (profile === 'Main 10') return `hvc1.2.4.L${l}.B0`;
  if (profile === 'Rext' || profile === 'Format Range Extensions') return `hvc1.4.10.L${l}.B0`;
  return `hvc1.1.6.L${l}.B0`;
}

export function bitDepth(pixFmt: string | undefined): number {
  if (!pixFmt) return 8;
  if (/12(le|be)?$/.test(pixFmt)) return 12;
  if (/10(le|be)?$/.test(pixFmt) || pixFmt === 'p010le') return 10;
  return 8;
}

/** AV1 seq_level_idx estimate when the stream does not report it. */
export function estimateAv1Level(width: number, height: number, fps: number): number {
  const px = width * height;
  const rate = px * fps;
  if (px <= 1280 * 720 && rate <= 1280 * 720 * 30) return 5; // 3.1
  if (px <= 1280 * 720) return 8; // 720p60 fits 4.0
  if (px <= 2048 * 1152 && rate <= 2048 * 1152 * 30) return 8; // 4.0
  if (px <= 2048 * 1152) return 9; // 4.1
  if (px <= 4096 * 2176 && rate <= 4096 * 2176 * 30) return 12; // 5.0
  if (px <= 4096 * 2176) return 13; // 5.1
  return 16; // 6.0
}

/** av01.<profile>.<level><tier>.<bitdepth> */
export function av1CodecString(profile: string | undefined, level: number | undefined, depth: number, w: number, h: number, fps: number): string {
  const p = profile === 'High' ? 1 : profile === 'Professional' ? 2 : 0;
  const l = level !== undefined && level >= 0 && level <= 31 ? level : estimateAv1Level(w, h, fps);
  return `av01.${p}.${String(l).padStart(2, '0')}M.${String(depth).padStart(2, '0')}`;
}

export const AAC_LC = 'mp4a.40.2';

/** H.264 level (×10) that comfortably fits a rendition we encode. */
export function h264LevelFor(width: number, height: number, fps: number): number {
  const px = width * height;
  if (px <= 640 * 360) return fps > 30 ? 31 : 30;
  if (px <= 854 * 480) return fps > 30 ? 31 : 30;
  if (px <= 1280 * 720) return fps > 30 ? 32 : 31;
  if (px <= 1920 * 1088) return fps > 30 ? 42 : 40;
  return fps > 30 ? 51 : 50;
}
