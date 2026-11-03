// Cookie sessions: opaque random token in an HttpOnly cookie; Postgres stores
// only its SHA-256, so a DB leak does not leak live sessions.
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { newSessionToken, sha256 } from '../lib/crypto.ts';
import { one, query } from '../lib/db.ts';
import { unauthorized } from '../lib/errors.ts';

export const COOKIE = 'sid';

export type SessionUser = {
  id: string; username: string; display_name: string; created_at: Date; channel_id: string;
  totp_enabled: boolean; session_hash: Buffer; last_seen_at: Date;
};

/** Public, non-secret identifier of a session (prefix of the token hash). */
export const sessionId = (tokenHash: Buffer) => tokenHash.toString('hex').slice(0, 16);

export async function createSession(reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> {
  const token = newSessionToken();
  const ttl = config.api.sessionTtlDays;
  await query(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, user_agent, ip)
               VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
  [sha256(token), userId, ttl, (req.headers['user-agent'] ?? '').slice(0, 300), isIP(req.ip) ? req.ip : null]);
  reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.api.cookieSecure, maxAge: ttl * 86400,
  });
}

export async function destroySession(reply: FastifyReply, req: FastifyRequest): Promise<void> {
  const token = req.cookies[COOKIE];
  if (token) await query('DELETE FROM auth_sessions WHERE token_hash = $1', [sha256(token)]);
  reply.clearCookie(COOKIE, { path: '/' });
}

export async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = req.cookies[COOKIE];
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const user = await one<SessionUser>(`
    SELECT u.id::text, u.username::text, u.display_name, u.created_at, c.id::text AS channel_id,
           u.totp_enabled_at IS NOT NULL AS totp_enabled, s.token_hash AS session_hash, s.last_seen_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id JOIN channels c ON c.owner_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [hash]);
  // "Last active" for the sessions list, written at most every 5 minutes.
  if (user && Date.now() - new Date(user.last_seen_at).getTime() > 5 * 60_000) {
    void query('UPDATE auth_sessions SET last_seen_at = now(), ip = COALESCE($2, ip) WHERE token_hash = $1',
      [hash, isIP(req.ip) ? req.ip : null]).catch(() => {});
  }
  return user;
}

export async function requireUser(req: FastifyRequest): Promise<SessionUser> {
  const user = await currentUser(req);
  if (!user) throw unauthorized();
  return user;
}

export const userView = (u: Pick<SessionUser, 'id' | 'username' | 'display_name' | 'created_at' | 'totp_enabled'>) => ({
  id: u.id, username: u.username, displayName: u.display_name, createdAt: new Date(u.created_at).toISOString(),
  twoFactorEnabled: u.totp_enabled,
});
