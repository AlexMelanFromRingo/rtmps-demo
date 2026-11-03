import Fastify, { LogController, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import { config } from '../config.ts';
import { HttpError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';
import { apiMetrics } from './metrics.ts';
import { authRoutes } from './routes/auth.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { internalRoutes } from './routes/internal.ts';
import { opsRoutes } from './routes/ops.ts';
import { publicRoutes } from './routes/public.ts';
import { accountRoutes } from './routes/account.ts';
import { overlayRoutes } from './routes/overlay.ts';
import { restreamRoutes } from './routes/restreams.ts';
import { socialRoutes } from './routes/social.ts';
import { videoRoutes } from './routes/videos.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp() {
  const app = Fastify({
    loggerInstance: log,
    logController: new LogController({ disableRequestLogging: true }),
    // Trust exactly N proxy hops (proxy-addr semantics) — not client-supplied X-Forwarded-For.
    trustProxy: (_address: string, hop: number) => hop < config.api.trustProxyHops,
    bodyLimit: 64 * 1024,
    routerOptions: { caseSensitive: false, ignoreTrailingSlash: true },
  });

  await app.register(cookie);

  // CSRF defence for cookie-authenticated, state-changing requests:
  // JSON-only bodies (no simple cross-site form posts) + same-origin check.
  app.addHook('onRequest', async (req) => {
    if (!MUTATING.has(req.method) || req.url.startsWith('/internal/')) return;
    const ct = req.headers['content-type'] ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'unsupported_media_type', 'Ожидается Content-Type: application/json');
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* invalid */ }
      if (originHost !== req.host) throw new HttpError(403, 'forbidden', 'Cross-origin запрос отклонён');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    apiMetrics.requests.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) log.warn({ method: req.method, route, status: reply.statusCode }, 'request failed');
  });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return reply.status(400).send({ error: { code: 'validation_failed', message: `${where}${issue?.message ?? 'invalid input'}` } });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).send({ error: { code: status === 415 ? 'unsupported_media_type' : 'validation_failed', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка сервера' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Не найдено' } }));

  await app.register(opsRoutes);
  await app.register(internalRoutes);
  await app.register(publicRoutes);
  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(socialRoutes);
  await app.register(videoRoutes);
  await app.register(restreamRoutes);
  await app.register(overlayRoutes);
  await app.register(accountRoutes);
  return app;
}
