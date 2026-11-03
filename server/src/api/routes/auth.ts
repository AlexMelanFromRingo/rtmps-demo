import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { burnPasswordCheck, hashPassword, newStreamKey, verifyPassword } from '../../lib/crypto.ts';
import { one, tx } from '../../lib/db.ts';
import { HttpError, unauthorized } from '../../lib/errors.ts';
import { rateLimit } from '../ratelimit.ts';
import { verifySecondFactor } from '../twofactor.ts';
import { createSession, currentUser, destroySession, userView, type SessionUser } from '../session.ts';
import { channelById, channelPublic } from '../views.ts';

// Channel pages live at /<slug>: names that collide with app routes are reserved.
export const RESERVED_USERNAMES = new Set([
  'api', 'hls', 'assets', 'internal', 'metrics', 'healthz', 'readyz', 'login', 'logout', 'signup', 'register',
  'dashboard', 'studio', 'settings', 'admin', 'root', 'support', 'help', 'about', 'directory', 'browse', 'search',
  'live', 'streams', 'channels', 'edge_health', 'favicon', 'robots', 'static', 'www', 'streamhub',
  'following', 'videos', 'overlay', 'categories', 'media', 'account', 'security', 'me',
]);
const username = z.string().regex(/^[A-Za-z0-9_]{3,25}$/, 'Логин: 3–25 символов, латиница, цифры и _')
  .refine((u) => !RESERVED_USERNAMES.has(u.toLowerCase()), 'Этот логин зарезервирован');
const password = z.string().min(8, 'Пароль: минимум 8 символов').max(128);
const registerBody = z.object({ username, password, displayName: z.string().trim().min(1).max(40).optional() });
const loginBody = z.object({
  username: z.string().min(1).max(25), password: z.string().min(1).max(128),
  totp: z.string().trim().min(6).max(20).optional(),
});

const USER_SQL = `SELECT u.id::text, u.username::text, u.display_name, u.created_at, c.id::text AS channel_id,
       u.totp_enabled_at IS NOT NULL AS totp_enabled
  FROM users u JOIN channels c ON c.owner_id = u.id WHERE u.id = $1`;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', async (req, reply) => {
    await rateLimit('register', req.ip, 20, 600);
    const body = registerBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    let userId: string;
    try {
      userId = await tx(async (c) => {
        const u = await one<{ id: string }>(
          `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id::text`,
          [body.username, body.displayName ?? body.username, passwordHash], c);
        await c.query(`INSERT INTO channels (owner_id, slug, title, stream_key) VALUES ($1, $2, $3, $4)`,
          [u!.id, body.username.toLowerCase(), `Эфир ${body.displayName ?? body.username}`, newStreamKey()]);
        return u!.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'username_taken', 'Этот логин уже занят');
      throw err;
    }
    await createSession(reply, req, userId);
    const user = (await one<SessionUser>(USER_SQL, [userId]))!;
    return reply.status(201).send({ user: userView(user) });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    await rateLimit('login-ip', req.ip, 30, 300);
    await rateLimit('login-user', body.username.toLowerCase(), 10, 300);
    const row = await one<{ id: string; password_hash: string; totp_enabled: boolean }>(
      'SELECT id::text, password_hash, totp_enabled_at IS NOT NULL AS totp_enabled FROM users WHERE username = $1', [body.username]);
    if (!row) {
      await burnPasswordCheck(body.password);
      throw new HttpError(401, 'invalid_credentials', 'Неверный логин или пароль');
    }
    if (!(await verifyPassword(body.password, row.password_hash))) {
      throw new HttpError(401, 'invalid_credentials', 'Неверный логин или пароль');
    }
    if (row.totp_enabled) {
      // Second step of the same request: the client resubmits with `totp`.
      if (!body.totp) throw new HttpError(401, 'totp_required', 'Введите код из приложения-аутентификатора');
      await rateLimit('totp', row.id, 8, 300);
      if (!(await verifySecondFactor(row.id, body.totp))) {
        throw new HttpError(401, 'totp_invalid', 'Неверный или уже использованный код');
      }
    }
    await createSession(reply, req, row.id);
    const user = (await one<SessionUser>(USER_SQL, [row.id]))!;
    return { user: userView(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(reply, req);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    const user = await currentUser(req);
    if (!user) throw unauthorized();
    const ch = (await channelById(user.channel_id))!;
    return { user: userView(user), channel: channelPublic(ch) };
  });
}
