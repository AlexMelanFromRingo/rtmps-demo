-- StreamHub schema v1 (PostgreSQL 18+: uses built-in uuidv7()).
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Accounts ────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      citext NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_]{3,25}$'),
  display_name  text   NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  password_hash text   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Opaque session tokens; only their SHA-256 is stored.
CREATE TABLE auth_sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  ip          inet
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

-- ── Channels ────────────────────────────────────────────────────────────────
CREATE TABLE channels (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id        bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug            citext NOT NULL UNIQUE,
  title           text   NOT NULL DEFAULT '' CHECK (char_length(title) <= 140),
  category        text   NOT NULL DEFAULT '' CHECK (char_length(category) <= 40),
  stream_key      text   NOT NULL UNIQUE,
  transcode_mode  text   NOT NULL DEFAULT 'abr' CHECK (transcode_mode IN ('abr', 'passthrough')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Ingest nodes (self-registered MediaMTX instances) ───────────────────────
CREATE TABLE ingest_nodes (
  id            text PRIMARY KEY,
  api_url       text NOT NULL,
  rtsp_url      text NOT NULL,   -- rtsp://host:8554  (AV1/VP9/VP8 pulls)
  srt_url       text NOT NULL,   -- srt://host:8890   (H.264/H.265 pulls: MPEG-TS keeps DTS)
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Broadcasts: one row per continuous "go live" (survives reconnects) ──────
CREATE TABLE broadcasts (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_id      bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('live', 'reconnecting', 'ended')),
  title           text NOT NULL DEFAULT '',
  category        text NOT NULL DEFAULT '',
  -- current ingest attachment
  ingest_node     text,
  source_id       text,          -- MediaMTX source (connection/session) id
  source_url      text,          -- rtsp://node/live/<key> (internal)
  source_srt_url  text,          -- srt://node:8890 (internal)
  protocol        text,
  video_codec     text,
  audio_codec     text,
  width           int,
  height          int,
  fps             real,
  ingest_kbps     int,
  -- playback
  renditions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ready_at        timestamptz,   -- master playlist published
  -- lifecycle
  started_at      timestamptz NOT NULL DEFAULT now(),
  offline_since   timestamptz,
  ended_at        timestamptz,
  storage_purged  boolean NOT NULL DEFAULT false,
  peak_viewers    int NOT NULL DEFAULT 0
);
-- At most one active broadcast per channel (the core invariant).
CREATE UNIQUE INDEX broadcasts_one_active_per_channel ON broadcasts (channel_id) WHERE status <> 'ended';
CREATE INDEX broadcasts_channel_recent_idx ON broadcasts (channel_id, started_at DESC);
CREATE INDEX broadcasts_active_idx ON broadcasts (status) WHERE status <> 'ended';
CREATE INDEX broadcasts_purge_idx ON broadcasts (ended_at) WHERE status = 'ended' AND NOT storage_purged;

-- ── Transcode jobs: leased work items for the worker fleet ──────────────────
-- A job is one transcode of one ingest connection. Workers claim with
-- FOR UPDATE SKIP LOCKED and keep a lease alive; an expired lease makes the
-- job claimable by another worker (failover).
CREATE TABLE transcode_jobs (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  broadcast_id      uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  source_id         text NOT NULL,
  source_url        text NOT NULL,
  source_srt_url    text,
  state             text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'running', 'finished', 'failed', 'cancelled')),
  worker_id         text,
  lease_expires_at  timestamptz,
  attempts          int NOT NULL DEFAULT 0,
  not_before        timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  stats             jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transcode_jobs_one_active ON transcode_jobs (broadcast_id) WHERE state IN ('pending', 'running');
CREATE INDEX transcode_jobs_claim_idx ON transcode_jobs (created_at) WHERE state IN ('pending', 'running');

-- ── Time series for the creator dashboard ───────────────────────────────────
CREATE TABLE broadcast_samples (
  broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  ts            timestamptz NOT NULL DEFAULT now(),
  viewers       int NOT NULL,
  ingest_kbps   int,
  PRIMARY KEY (broadcast_id, ts)
);
