// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION (environment-driven, with sensible local defaults)
// ═══════════════════════════════════════════════════════════════════════════

const path = require('path');

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  // Host advertised in generated URLs (RTMP/SRT/HLS). Use your LAN/public IP
  // or domain to stream from another machine.
  publicHost: process.env.PUBLIC_HOST || 'localhost',

  // Web dashboard + API + HLS delivery (single origin).
  webPort: int(process.env.WEB_PORT, 3000),

  // node-media-server RTMP ingest port.
  rtmpPort: int(process.env.RTMP_PORT, 1935),

  // node-media-server HTTP/FLV port (also serves media as a fallback origin).
  mediaHttpPort: int(process.env.MEDIA_HTTP_PORT, 8000),

  // First SRT listener port; each stream key gets the next free one.
  srtBasePort: int(process.env.SRT_BASE_PORT, 9000),

  // Persistence + media output locations (absolute, so cwd never matters).
  dbPath: process.env.DB_PATH || path.join(__dirname, 'streaming.db'),
  mediaRoot: process.env.MEDIA_ROOT || path.join(__dirname, 'media'),

  // FFmpeg binary (override to pin a specific build).
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
};
