// Central, environment-driven configuration. Every knob has a default that
// works for `docker compose up` / local development; production overrides
// them through the environment (see ../../.env.example).
import os from 'node:os';

const env = process.env;

function str(name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be an integer, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const isProduction = str('NODE_ENV', 'development') === 'production';
const DEV_SECRET = 'dev-internal-secret-change-me';

export const config = {
  isProduction,
  logLevel: str('LOG_LEVEL', 'info'),

  databaseUrl: str('DATABASE_URL', 'postgres://streamhub:streamhub@localhost:5432/streamhub'),
  databasePoolMax: int('DATABASE_POOL_MAX', 10),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),

  // Shared secret between the control plane and ingest nodes / workers.
  internalSecret: str('INTERNAL_SECRET', DEV_SECRET),

  s3: {
    endpoint: str('S3_ENDPOINT', 'http://localhost:8333'),
    region: str('S3_REGION', 'us-east-1'),
    bucket: str('S3_BUCKET', 'hls'),
    accessKeyId: str('S3_ACCESS_KEY', 'streamhub'),
    secretAccessKey: str('S3_SECRET_KEY', 'streamhub-secret'),
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', true),
    // Make the bucket world-readable (GetObject) on startup so the edge/CDN
    // can fetch segments without signing. Disable when the CDN signs itself.
    publicRead: bool('S3_PUBLIC_READ', true),
  },

  api: {
    host: str('API_HOST', '0.0.0.0'),
    port: int('API_PORT', 3000),
    trustProxy: bool('TRUST_PROXY', true),
    cookieSecure: bool('COOKIE_SECURE', isProduction),
    sessionTtlDays: int('SESSION_TTL_DAYS', 30),
  },

  // URLs shown to streamers / viewers. They must be reachable from *their*
  // machines, so they are configured explicitly instead of being derived.
  public: {
    rtmpUrl: str('PUBLIC_RTMP_URL', 'rtmp://localhost:1935/live'),
    srtUrl: str('PUBLIC_SRT_URL', 'srt://localhost:8890'),
    whipUrl: str('PUBLIC_WHIP_URL', 'http://localhost:8889'),
    hlsBase: str('PUBLIC_HLS_BASE', '/hls'),
  },

  control: {
    tickMs: int('CONTROL_TICK_MS', 2000),
    reconnectGraceSec: int('RECONNECT_GRACE_SEC', 30),
    viewerTtlSec: int('VIEWER_TTL_SEC', 45),
    ingestNodeTimeoutSec: int('INGEST_NODE_TIMEOUT_SEC', 15),
    // How long HLS objects of an ended broadcast stay in object storage.
    retentionMinutes: int('RETENTION_MINUTES', 120),
    // Max transcode attempts per ingest session before giving up.
    maxJobAttempts: int('MAX_JOB_ATTEMPTS', 30),
  },

  worker: {
    id: str('WORKER_ID', `${os.hostname()}-${process.pid}`),
    // Concurrent transcodes. A 1080p60 ABR ladder on libx264 veryfast needs
    // ~4 cores, so default to cores/4 (min 1).
    slots: int('WORKER_SLOTS', Math.max(1, Math.floor(os.availableParallelism() / 4))),
    // Extra low-cost slots for degraded jobs (remux of the source only).
    remuxSlots: int('WORKER_REMUX_SLOTS', 8),
    // A job nobody could take with full transcoding for this long is started
    // in degraded mode (source only) instead of leaving viewers waiting.
    degradeAfterSec: int('DEGRADE_AFTER_SEC', 8),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    encoder: str('ENCODER', 'auto'), // auto | libx264 | h264_nvenc | h264_qsv
    x264Preset: str('X264_PRESET', 'veryfast'),
    segmentSec: int('HLS_SEGMENT_SEC', 2),
    listSize: int('HLS_LIST_SIZE', 6),
    thumbnailEverySec: int('THUMBNAIL_INTERVAL_SEC', 10),
    leaseSec: int('JOB_LEASE_SEC', 10),
    heartbeatSec: int('JOB_HEARTBEAT_SEC', 3),
    // RTSP credentials the worker uses to pull from ingest nodes.
    ingestReadUser: 'transcoder',
    metricsPort: int('WORKER_METRICS_PORT', 9100),
  },
} as const;

export const INGEST_READ_USER = config.worker.ingestReadUser;

/**
 * The default secret is fine for a local demo, but a deployment reachable
 * from other machines (public URLs not on localhost) must set its own.
 */
export function assertProductionSafety(warn: (msg: string) => void): void {
  if (config.internalSecret !== DEV_SECRET) return;
  const isLocal = [config.public.rtmpUrl, config.public.whipUrl].every((u) => /\/\/(localhost|127\.0\.0\.1)[:/]/.test(u));
  if (!isLocal && process.env.ALLOW_DEFAULT_SECRET !== 'true') {
    throw new Error('INTERNAL_SECRET must be set for a non-local deployment (see .env.example)');
  }
  warn('INTERNAL_SECRET uses the built-in development default — set your own before exposing this server');
}
