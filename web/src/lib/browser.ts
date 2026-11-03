/**
 * Browser helpers that must also work on plain-HTTP LAN deployments, where
 * `crypto.randomUUID` and `navigator.clipboard` (secure-context only) are missing.
 */

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* not a secure context — fall through */
    }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let memoryViewerId: string | null = null;

/**
 * Per-tab viewer id for heartbeats. sessionStorage is per tab and survives reloads,
 * so reloading the page doesn't count the viewer twice.
 */
export function getViewerId(): string {
  const KEY = 'streamhub.viewerId';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    const id = uuid();
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    memoryViewerId ??= uuid();
    return memoryViewerId;
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall back below */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const prevFocus = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  prevFocus?.focus?.();
  return ok;
}

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`streamhub.${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`streamhub.${key}`, value);
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

/** 18+ consent is remembered per channel (VODs of that channel share it). */
export function hasMatureConsent(slug: string): boolean {
  return readPref(`mature.${slug.toLowerCase()}`) === '1';
}

export function giveMatureConsent(slug: string): void {
  writePref(`mature.${slug.toLowerCase()}`, '1');
}

/** Saves a text file through a temporary object URL (works without a secure context). */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- VOD resume positions: one bounded map instead of a key per video.
const VOD_POS_KEY = 'vodpos';
const VOD_POS_MAX = 50;

type VodPositions = Record<string, { t: number; at: number }>;

function readVodPositions(): VodPositions {
  try {
    const raw = readPref(VOD_POS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as VodPositions) : {};
  } catch {
    return {};
  }
}

export function readVodPosition(id: string): number | null {
  const entry = readVodPositions()[id];
  return entry && Number.isFinite(entry.t) && entry.t > 0 ? entry.t : null;
}

export function writeVodPosition(id: string, seconds: number | null): void {
  const all = readVodPositions();
  if (seconds == null) delete all[id];
  else all[id] = { t: Math.floor(seconds), at: Date.now() };
  const trimmed = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, VOD_POS_MAX);
  writePref(VOD_POS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
}
