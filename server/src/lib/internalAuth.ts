/**
 * Internal callers authenticate with the shared secret in the Authorization
 * header — `Bearer <secret>` (hooks) or Basic with the secret as password
 * (MediaMTX auth URL http://mediamtx:<secret>@api/...). Never in the URL, so
 * it doesn't end up in access logs.
 */
export function internalSecretFrom(header: string | undefined): string {
  if (!header) return '';
  const [scheme, value = ''] = header.split(' ', 2);
  if (scheme?.toLowerCase() === 'bearer') return value;
  if (scheme?.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return '';
}
