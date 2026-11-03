// Multivariant (master) playlist writer. We write it ourselves instead of
// using ffmpeg's -master_pl_name so we control CODECS strings for passthrough
// sources (HEVC/AV1), variant order (start variant first) and NAME labels
// that the player maps to UI labels.
import type { LadderPlan, Variant } from './ladder.ts';

export const AUDIO_GROUP = 'aud';
export const AUDIO_DIR = 'audio';

/** Observed average bitrate (kbps) per variant, used for passthrough sources. */
export type ObservedBitrates = Record<string, number>;

export function effectiveBitrates(v: Variant, observed: ObservedBitrates): { avg: number; peak: number } {
  const seen = observed[v.name];
  if (v.kind === 'copy' && seen && seen > 0) {
    return { avg: Math.round(seen), peak: Math.round(seen * 1.3) };
  }
  return { avg: v.bitrateKbps, peak: v.maxrateKbps };
}

export function buildMasterPlaylist(plan: LadderPlan, observed: ObservedBitrates = {}, playlist = 'index.m3u8'): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  const audioKbps = plan.audio?.bitrateKbps ?? 0;

  if (plan.audio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP}",NAME="main",LANGUAGE="und",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${AUDIO_DIR}/${playlist}"`,
    );
  }

  for (const v of plan.variants) {
    const { avg, peak } = effectiveBitrates(v, observed);
    // BANDWIDTH must be the peak segment bitrate including audio + container overhead.
    const bandwidth = Math.round((peak + audioKbps) * 1000 * 1.05);
    const average = Math.round((avg + audioKbps) * 1000 * 1.03);
    const codecs = plan.audio ? `${v.codecString},${plan.audio.codecString}` : v.codecString;
    const attrs = [
      `BANDWIDTH=${bandwidth}`,
      `AVERAGE-BANDWIDTH=${average}`,
      `RESOLUTION=${v.width}x${v.height}`,
      `FRAME-RATE=${v.fps.toFixed(3)}`,
      `CODECS="${codecs}"`,
      ...(plan.audio ? [`AUDIO="${AUDIO_GROUP}"`] : []),
      `NAME="${v.name}"`,
    ];
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`, `${v.name}/${playlist}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Sum of EXTINF durations and the segment URIs in a media playlist. */
export function parseMediaPlaylist(text: string): { segments: { uri: string; duration: number }[]; mediaSequence: number } {
  const segments: { uri: string; duration: number }[] = [];
  let mediaSequence = 0;
  let pending: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number.parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXTINF:')) pending = Number.parseFloat(line.slice(8));
    else if (line && !line.startsWith('#') && pending !== null) {
      segments.push({ uri: line, duration: pending });
      pending = null;
    }
  }
  return { segments, mediaSequence };
}
