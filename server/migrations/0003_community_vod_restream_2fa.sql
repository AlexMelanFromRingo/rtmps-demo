-- v2: follows, channel profile, VOD, multistream, overlays, 2FA, session management, search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Channel profile + settings ──────────────────────────────────────────────
ALTER TABLE channels
  ADD COLUMN bio             text    NOT NULL DEFAULT '' CHECK (char_length(bio) <= 300),
  ADD COLUMN links           jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN avatar_key      text,
  ADD COLUMN mature          boolean NOT NULL DEFAULT false,
  ADD COLUMN save_vods       boolean NOT NULL DEFAULT true,
  ADD COLUMN low_latency     boolean NOT NULL DEFAULT false,
  ADD COLUMN followers_count int     NOT NULL DEFAULT 0 CHECK (followers_count >= 0),
  -- Secret for the OBS browser-source overlay (2 × UUIDv4 = 244 random bits).
  ADD COLUMN overlay_token   text    NOT NULL UNIQUE
    DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

-- ── Follows ─────────────────────────────────────────────────────────────────
CREATE TABLE follows (
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX follows_channel_idx ON follows (channel_id);

-- ── VOD (every broadcast is recorded as HLS; playable after it ends) ────────
ALTER TABLE broadcasts
  ADD COLUMN vod_enabled       boolean NOT NULL DEFAULT true,   -- snapshot of channels.save_vods
  ADD COLUMN vod_finalized_at  timestamptz,
  ADD COLUMN vod_duration_sec  real,
  ADD COLUMN vod_deleted       boolean NOT NULL DEFAULT false,
  ADD COLUMN views             int     NOT NULL DEFAULT 0,
  ADD COLUMN latency_mode      text    NOT NULL DEFAULT 'normal' CHECK (latency_mode IN ('normal', 'low'));
CREATE INDEX broadcasts_vod_idx ON broadcasts (channel_id, started_at DESC)
  WHERE status = 'ended' AND vod_enabled AND NOT vod_deleted AND NOT storage_purged;
CREATE INDEX broadcasts_vod_finalize_idx ON broadcasts (ended_at)
  WHERE status = 'ended' AND vod_enabled AND vod_finalized_at IS NULL AND NOT storage_purged;

-- ── Multistream destinations ────────────────────────────────────────────────
CREATE TABLE restream_destinations (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  channel_id      bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  service         text NOT NULL CHECK (service IN ('twitch', 'youtube', 'kick', 'custom')),
  url             text NOT NULL CHECK (char_length(url) <= 300),
  stream_key_enc  text NOT NULL,          -- AES-256-GCM, never returned to clients
  key_hint        text NOT NULL,          -- last 4 characters, for "••••3f9a"
  enabled         boolean NOT NULL DEFAULT true,
  transcode       text NOT NULL DEFAULT 'auto' CHECK (transcode IN ('auto', 'copy', 'h264')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX restream_destinations_channel_idx ON restream_destinations (channel_id);

-- ── 2FA (TOTP, RFC 6238) + recovery codes ───────────────────────────────────
ALTER TABLE users
  ADD COLUMN totp_secret_enc   text,       -- AES-256-GCM
  ADD COLUMN totp_pending_enc  text,       -- set during setup, until confirmed
  ADD COLUMN totp_enabled_at   timestamptz,
  ADD COLUMN totp_last_step    bigint,     -- replay protection
  ADD COLUMN recovery_codes    text[] NOT NULL DEFAULT '{}';  -- SHA-256 hex, single use

-- ── Session management ──────────────────────────────────────────────────────
ALTER TABLE auth_sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- ── Search ──────────────────────────────────────────────────────────────────
CREATE INDEX users_display_name_trgm ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX channels_slug_trgm ON channels USING gin ((slug::text) gin_trgm_ops);
CREATE INDEX channels_title_trgm ON channels USING gin (title gin_trgm_ops);
CREATE INDEX broadcasts_category_idx ON broadcasts (lower(category), started_at DESC);
