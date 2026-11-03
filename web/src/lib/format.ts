import type { SourceInfo } from '../api/types';

const LOCALE = 'ru-RU';
const numberFmt = new Intl.NumberFormat(LOCALE);
const decimalFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const pluralRules = new Intl.PluralRules(LOCALE);

/** Russian plural: plural(5, 'зритель', 'зрителя', 'зрителей') → 'зрителей'. */
export function plural(n: number, one: string, few: string, many: string): string {
  switch (pluralRules.select(n)) {
    case 'one':
      return one;
    case 'few':
      return few;
    default:
      return many;
  }
}

export function formatCount(n: number): string {
  return numberFmt.format(n);
}

export function viewersWord(n: number): string {
  return plural(n, 'зритель', 'зрителя', 'зрителей');
}

export function viewersLabel(n: number): string {
  return `${formatCount(n)} ${viewersWord(n)}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 3725000 → "1:02:05", 65000 → "1:05" */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Human duration: "2 ч 15 мин", "45 мин", "меньше минуты". */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1) return 'меньше минуты';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

export function sinceMs(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now - t : 0;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** "сегодня", "вчера", "5 дней назад" … for recent broadcasts. */
export function formatRelativeDay(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date(now)) - startOf(d)) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 7) return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' }).format(d);
}

const CODEC_LABELS: Record<string, string> = {
  H264: 'H.264',
  H265: 'HEVC',
  HEVC: 'HEVC',
  AV1: 'AV1',
  VP9: 'VP9',
  VP8: 'VP8',
  AAC: 'AAC',
  OPUS: 'Opus',
};

export function codecLabel(codec: string | null | undefined): string {
  if (!codec) return '—';
  return CODEC_LABELS[codec.toUpperCase()] ?? codec;
}

const PROTOCOL_LABELS: Record<string, string> = {
  rtmp: 'RTMP',
  srt: 'SRT',
  webrtc: 'WebRTC',
  rtsp: 'RTSP',
};

export function protocolLabel(protocol: string | null | undefined): string | null {
  if (!protocol) return null;
  return PROTOCOL_LABELS[protocol.toLowerCase()] ?? null;
}

/** 1080 + 60 → "1080p60"; 30 fps and below are shown without the suffix. */
export function resolutionLabel(height: number | null, fps?: number | null): string | null {
  if (!height) return null;
  const f = fps ? Math.round(fps) : 0;
  return f > 30 ? `${height}p${f}` : `${height}p`;
}

/** "AV1 · 1080p60" */
export function sourceBadge(source: SourceInfo): string | null {
  const parts = [
    source.videoCodec ? codecLabel(source.videoCodec) : null,
    resolutionLabel(source.height, source.fps),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export function formatFps(fps: number | null | undefined): string | null {
  if (fps == null || !Number.isFinite(fps)) return null;
  return `${decimalFmt.format(Math.round(fps * 10) / 10)} fps`;
}

export function formatKbps(kbps: number | null | undefined): string | null {
  if (kbps == null || !Number.isFinite(kbps)) return null;
  if (kbps >= 1000) return `${decimalFmt.format(kbps / 1000)} Мбит/с`;
  return `${numberFmt.format(Math.round(kbps))} кбит/с`;
}

export function formatDecimal(n: number, digits = 1): string {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** hls.js level.videoCodec ("avc1.640028", "av01.0.08M.08", "hvc1.1.6.L120.90") → friendly name. */
export function hlsCodecName(codecs: string | undefined): string | null {
  if (!codecs) return null;
  const c = codecs.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'H.264';
  if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'HEVC';
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'VP9';
  if (c.startsWith('vp08') || c.startsWith('vp8')) return 'VP8';
  return codecs.split('.')[0] ?? null;
}

/** Append a cache-busting query param, respecting an existing query string. */
export function withCacheBust(url: string, t: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}t=${t}`;
}

/** Stable hue (0–359) for a channel monogram. */
export function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initialOf(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

/** Seconds → "3:07", "1:02:05" (player timecode). */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return formatUptime(seconds * 1000);
}

/** Spoken form of a timecode for screen readers: "1 ч 2 мин 5 с". */
export function spokenClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h ? `${h} ч` : '', m ? `${m} мин` : '', `${s} с`].filter(Boolean).join(' ');
}

export function followersLabel(n: number): string {
  return `${formatCount(n)} ${plural(n, 'подписчик', 'подписчика', 'подписчиков')}`;
}

export function viewsLabel(n: number): string {
  return `${formatCount(n)} ${plural(n, 'просмотр', 'просмотра', 'просмотров')}`;
}

const compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });

/** 1234 → "1,2 тыс." — for tight spots (sidebar). */
export function formatCompact(n: number): string {
  return n < 1000 ? numberFmt.format(n) : compactFmt.format(n);
}

/** "10 ноября" (+ year when not the current one). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(LOCALE, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}

/** "14:05" */
export function formatTime(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }).format(d);
}

const relFmt = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

/** "только что", "5 минут назад", "вчера", "3 дня назад", then a plain date. */
export function formatAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const sec = Math.round((now - t) / 1000);
  if (sec < 60) return 'только что';
  const min = Math.round(sec / 60);
  if (min < 60) return relFmt.format(-min, 'minute');
  const h = Math.round(min / 60);
  if (h < 24) return relFmt.format(-h, 'hour');
  const days = Math.round(h / 24);
  if (days < 7) return relFmt.format(-days, 'day');
  return formatDate(iso);
}
