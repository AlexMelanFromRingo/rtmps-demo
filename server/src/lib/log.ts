import { pino } from 'pino';
import { config } from '../config.ts';

// Structured JSON logs (stdout) — collected by the container runtime.
export const log = pino({
  level: config.logLevel,
  base: { svc: process.env.SERVICE_NAME ?? 'streamhub' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['password', '*.password', 'streamKey', '*.streamKey', 'req.headers.cookie'], censor: '[redacted]' },
});

export type Logger = typeof log;
