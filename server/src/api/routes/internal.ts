// Endpoints for MediaMTX ingest nodes. Not routed by the edge; additionally
// protected by a shared secret in the query string.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.ts';
import { safeEqual } from '../../lib/crypto.ts';
import { internalSecretFrom } from '../../lib/internalAuth.ts';
import { HttpError } from '../../lib/errors.ts';
import { log } from '../../lib/log.ts';
import { authorizeIngest, handleOffline, handleOnline, registerNode, type AuthRequest } from '../../control/broadcasts.ts';
import { apiMetrics } from '../metrics.ts';

function checkSecret(req: FastifyRequest): void {
  if (!safeEqual(internalSecretFrom(req.headers.authorization), config.internalSecret)) {
    throw new HttpError(403, 'forbidden', 'bad internal secret');
  }
}

const nodeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const heartbeatBody = z.object({
  node: nodeId, apiUrl: z.url(), rtspUrl: z.string().regex(/^rtsp:\/\/[^\s]+$/), srtUrl: z.string().regex(/^srt:\/\/[^\s?]+$/),
});
const streamBody = z.object({
  node: nodeId, path: z.string().max(200), sourceType: z.string().max(40).optional(), sourceId: z.string().min(1).max(100),
  query: z.string().max(500).optional(),
});

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/mediamtx/auth', async (req, reply) => {
    checkSecret(req);
    const decision = await authorizeIngest((req.body ?? {}) as AuthRequest);
    const action = (req.body as AuthRequest | undefined)?.action ?? 'unknown';
    apiMetrics.ingestAuth.inc({ action, result: decision.allow ? 'allow' : 'deny' });
    if (!decision.allow) {
      // RTSP readers first try without credentials and expect a 401 challenge.
      log.debug({ action, reason: decision.reason, ip: (req.body as AuthRequest).ip }, 'ingest auth denied');
      return reply.status(401).send({ error: { code: 'unauthorized', message: decision.reason } });
    }
    return reply.status(200).send({});
  });

  app.post('/internal/ingest/heartbeat', async (req, reply) => {
    checkSecret(req);
    const b = heartbeatBody.parse(req.body);
    await registerNode(b.node, b.apiUrl, b.rtspUrl, b.srtUrl);
    return reply.status(204).send();
  });

  app.post('/internal/ingest/online', async (req, reply) => {
    checkSecret(req);
    const ev = streamBody.parse(req.body);
    await handleOnline(ev);
    return reply.status(204).send();
  });

  app.post('/internal/ingest/offline', async (req, reply) => {
    checkSecret(req);
    const ev = streamBody.parse(req.body);
    await handleOffline(ev);
    return reply.status(204).send();
  });
}
