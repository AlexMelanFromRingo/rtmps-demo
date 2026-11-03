// Egress policy for user-supplied network targets (multistream destinations):
// the server must not be usable to reach internal services (SSRF).
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

export const allowPrivateEgress = () => process.env.RESTREAM_ALLOW_PRIVATE === 'true';

export function isPrivateAddress(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 part. (A ::ffff:0:0/96
  // rule in BlockList would match every IPv4 address.)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const SCHEMES = new Set(['rtmp:', 'rtmps:', 'srt:']);

/** Syntactic validation (API side). Returns an error message or null. */
export function validateDestinationUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Некорректный адрес'; }
  if (!SCHEMES.has(u.protocol)) return 'Поддерживаются rtmp://, rtmps:// и srt://';
  if (u.username || u.password) return 'Ключ указывайте в отдельном поле, а не в адресе';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'В адресе нет сервера';
  if (allowPrivateEgress()) return null;
  if (isIP(host) ? isPrivateAddress(host) : !host.includes('.') || /\.(local|internal|localhost)$/i.test(host) || host === 'localhost') {
    return 'Адреса внутренней сети запрещены';
  }
  return null;
}

/** Resolution-time check (worker side, right before connecting): blocks DNS rebinding to private ranges. */
export async function assertPublicTarget(raw: string): Promise<void> {
  if (allowPrivateEgress()) return;
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('адрес назначения ведёт во внутреннюю сеть');
  }
}
