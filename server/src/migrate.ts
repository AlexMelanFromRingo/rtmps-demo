// CLI: `node src/migrate.ts` — run pending migrations and exit (compose one-shot).
import { migrate } from './lib/migrate.ts';
import { pool } from './lib/db.ts';
import { log } from './lib/log.ts';

try {
  const applied = await migrate();
  log.info({ applied }, applied.length ? 'migrations complete' : 'schema up to date');
  await pool.end();
} catch (err) {
  log.fatal({ err }, 'migration failed');
  process.exit(1);
}
