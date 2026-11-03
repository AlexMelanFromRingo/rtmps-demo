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
