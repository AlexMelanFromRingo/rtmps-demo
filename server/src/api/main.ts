// API replica: HTTP API + SSE + (when elected leader) the control loop.
// Stateless — scale horizontally behind the edge load balancer.
import { assertProductionSafety, config } from '../config.ts';
import { pool } from '../lib/db.ts';
import { log } from '../lib/log.ts';
import { migrate } from '../lib/migrate.ts';
import { redis } from '../lib/redis.ts';
import { ensureBucket } from '../lib/s3.ts';
import { installSignalHandlers, onShutdown } from '../lib/shutdown.ts';
import { runControlLoopWhenLeader } from '../control/loop.ts';
import { buildApp } from './app.ts';
import { hub } from './sse.ts';

process.env.SERVICE_NAME ??= 'api';
assertProductionSafety((msg) => log.warn(msg));
installSignalHandlers();

if (process.env.MIGRATE_ON_START !== 'false') await migrate();
ensureBucket().catch((err: Error) => log.warn({ err: err.message }, 'bucket check failed (worker will retry)'));

const app = await buildApp();
hub.start();

const stopLeader = new AbortController();
const leader = process.env.CONTROL_LOOP === 'false'
  ? Promise.resolve()
  : runControlLoopWhenLeader(stopLeader.signal);

onShutdown(async () => { await pool.end().catch(() => {}); redis.disconnect(); });
onShutdown(async () => { await app.close(); });
onShutdown(async () => { await hub.close(); });
onShutdown(async () => { stopLeader.abort(); await leader; });

await app.listen({ host: config.api.host, port: config.api.port });
log.info({ port: config.api.port }, 'api listening');
