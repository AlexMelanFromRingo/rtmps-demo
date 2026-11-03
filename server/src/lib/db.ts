import pg from 'pg';
import { config } from '../config.ts';
import { log } from './log.ts';

// BIGINT ids are returned as strings by default (safe: they are serialised
// as strings in the API anyway). Make COUNT()/int8 aggregates explicit in SQL.
// Every connection gets bounded queries and TCP keepalives on both ends, so
// a dead network path fails fast instead of hanging (lease fencing and leader
// election depend on noticing that quickly).
export const connectionOptions = {
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
  statement_timeout: 15_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5_000,
  // Server-side keepalive: Postgres drops (and releases advisory locks of) dead clients in ~11 s.
  options: '-c tcp_keepalives_idle=5 -c tcp_keepalives_interval=2 -c tcp_keepalives_count=3',
} satisfies pg.ClientConfig;

export const pool = new pg.Pool({
  ...connectionOptions,
  max: config.databasePoolMax,
  idleTimeoutMillis: 30_000,
  application_name: process.env.SERVICE_NAME ?? 'streamhub',
});

pool.on('error', (err) => log.error({ err }, 'postgres pool error'));

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

// Run fn inside a transaction; retries on serialization failures/deadlocks.
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
