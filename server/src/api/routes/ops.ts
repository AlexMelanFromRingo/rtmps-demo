import type { FastifyInstance } from 'fastify';
import { pool } from '../../lib/db.ts';
import { redis } from '../../lib/redis.ts';
import { isShuttingDown } from '../../lib/shutdown.ts';
import { registry } from '../metrics.ts';

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async (_req, reply) => reply.status(isShuttingDown() ? 503 : 200).send({ ok: !isShuttingDown() }));

  // Ready = can serve traffic: Postgres is required, Redis is optional (degraded).
  app.get('/readyz', async (_req, reply) => {
    let db = false;
    try { await pool.query('SELECT 1'); db = true; } catch { /* not ready */ }
    const ok = db && !isShuttingDown();
    return reply.status(ok ? 200 : 503).send({ ok, db, redis: redis.status === 'ready' });
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
