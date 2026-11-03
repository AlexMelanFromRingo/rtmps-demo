// Account security: password change, sessions/devices, TOTP two-factor auth.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../lib/crypto.ts';
import { one, query, tx } from '../../lib/db.ts';
import { HttpError, notFound } from '../../lib/errors.ts';
import { open, seal } from '../../lib/secretbox.ts';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp.ts';
import { rateLimit } from '../ratelimit.ts';
import { requireUser, sessionId } from '../session.ts';
import { TOTP_PURPOSE, verifySecondFactor } from '../twofactor.ts';

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, 'Пароль: минимум 8 символов').max(128),
});
const codeBody = z.object({ code: z.string().trim().min(6).max(20) });
const disableBody = z.object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20) });
const sessionParams = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) });

async function checkPassword(userId: string, password: string): Promise<void> {
  const row = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'Неверный пароль');
  }
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  // ── password ──
  app.post('/api/me/password', async (req, reply) => {
    const user = await requireUser(req);
    const body = passwordBody.parse(req.body);
    await rateLimit('password', user.id, 10, 600);
    await checkPassword(user.id, body.currentPassword);
    const hash = await hashPassword(body.newPassword);
    await tx(async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hash]);
      // A password change signs out every other device.
      await c.query('DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, user.session_hash]);
    });
    return reply.status(204).send();
  });

  // ── sessions / devices ──
  app.get('/api/me/sessions', async (req) => {
    const user = await requireUser(req);
    const rows = await query<{ token_hash: Buffer; created_at: Date; last_seen_at: Date; user_agent: string | null; ip: string | null }>(
      `SELECT token_hash, created_at, last_seen_at, user_agent, host(ip) AS ip FROM auth_sessions
        WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, [user.id]);
    return {
      sessions: rows.map((s) => ({
        id: sessionId(s.token_hash),
        createdAt: new Date(s.created_at).toISOString(),
        lastSeenAt: new Date(s.last_seen_at).toISOString(),
        userAgent: s.user_agent ?? '',
        ip: s.ip,
        current: s.token_hash.equals(user.session_hash),
      })),
    };
  });

  app.delete('/api/me/sessions/:id', async (req, reply) => {
    const user = await requireUser(req);
    const { id } = sessionParams.parse(req.params);
    const rows = await query(`DELETE FROM auth_sessions WHERE user_id = $1 AND encode(token_hash, 'hex') LIKE $2 || '%' RETURNING 1`,
      [user.id, id]);
    if (rows.length === 0) throw notFound('Сессия не найдена');
    return reply.status(204).send();
  });

  app.post('/api/me/sessions/revoke-others', async (req, reply) => {
    const user = await requireUser(req);
    await query('DELETE FROM auth_sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, user.session_hash]);
    return reply.status(204).send();
  });

  // ── two-factor authentication (TOTP) ──
  app.get('/api/me/2fa', async (req) => {
    const user = await requireUser(req);
    return { enabled: user.totp_enabled };
  });

  app.post('/api/me/2fa/setup', async (req) => {
    const user = await requireUser(req);
    if (user.totp_enabled) throw new HttpError(409, 'conflict', 'Двухфакторная защита уже включена');
    const secret = newTotpSecret();
    await query('UPDATE users SET totp_pending_enc = $2 WHERE id = $1', [user.id, seal(secret, TOTP_PURPOSE)]);
    return { secret, otpauthUrl: otpauthUrl(secret, user.username) };
  });

  app.post('/api/me/2fa/enable', async (req) => {
    const user = await requireUser(req);
    const { code } = codeBody.parse(req.body);
    await rateLimit('totp-enable', user.id, 10, 300);
    const row = await one<{ totp_pending_enc: string | null }>('SELECT totp_pending_enc FROM users WHERE id = $1', [user.id]);
    if (!row?.totp_pending_enc) throw new HttpError(409, 'conflict', 'Сначала начните настройку');
    const secret = open(row.totp_pending_enc, TOTP_PURPOSE);
    const step = verifyTotp(secret, code);
    if (step === null) throw new HttpError(401, 'totp_invalid', 'Неверный код — проверьте время на телефоне');
    const codes = newRecoveryCodes();
    await query(`UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = now(),
                   totp_last_step = $2, recovery_codes = $3 WHERE id = $1`,
    [user.id, step, codes.map(hashRecoveryCode)]);
    return { recoveryCodes: codes };
  });

  app.post('/api/me/2fa/disable', async (req, reply) => {
    const user = await requireUser(req);
    const body = disableBody.parse(req.body);
    await rateLimit('totp-disable', user.id, 10, 300);
    await checkPassword(user.id, body.password);
    if (!user.totp_enabled) return reply.status(204).send();
    if (!(await verifySecondFactor(user.id, body.code))) {
      throw new HttpError(401, 'totp_invalid', 'Неверный или уже использованный код');
    }
    await query(`UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL,
                   totp_last_step = NULL, recovery_codes = '{}' WHERE id = $1`, [user.id]);
    return reply.status(204).send();
  });
}
