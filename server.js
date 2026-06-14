const express = require('express');
const NodeMediaServer = require('node-media-server');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const http = require('http');
const WebSocket = require('ws');

const config = require('./config');
const { VARIANTS, detectHardwareEncoder, buildHLSArgs } = require('./lib/encoding');

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE SETUP (SQLite for persistence)
// ═══════════════════════════════════════════════════════════════════════════

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS stream_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    srt_port INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_live INTEGER DEFAULT 0,
    started_at DATETIME,
    ended_at DATETIME,
    total_viewers INTEGER DEFAULT 0,
    peak_viewers INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS stream_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_key TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    duration_seconds INTEGER,
    avg_bitrate INTEGER,
    total_viewers INTEGER DEFAULT 0,
    peak_viewers INTEGER DEFAULT 0,
    FOREIGN KEY (stream_key) REFERENCES stream_keys(key)
  );

  CREATE TABLE IF NOT EXISTS stream_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_key TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    bitrate INTEGER,
    fps REAL,
    resolution TEXT,
    codec TEXT,
    viewers INTEGER DEFAULT 0,
    FOREIGN KEY (stream_key) REFERENCES stream_keys(key)
  );
`);

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

const ffmpegProcesses = new Map(); // streamKey -> ChildProcess (RTMP transcodes)
const srtListeners = new Map();    // streamKey -> { ffmpeg, port, stopping, failures }
const streamMetrics = new Map();   // streamKey -> live metrics object
let shuttingDown = false;

// ═══════════════════════════════════════════════════════════════════════════
// PATH HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const hlsDirFor = (key) => path.join(config.mediaRoot, 'live', key);

function ensureHlsDirs(key) {
  const dir = hlsDirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  // Variant subdirectories must exist before ffmpeg writes into them.
  VARIANTS.forEach((v) => fs.mkdirSync(path.join(dir, v.name), { recursive: true }));
  return dir;
}

// Ensure base media directories exist.
fs.mkdirSync(path.join(config.mediaRoot, 'live'), { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════
// FFMPEG TRANSCODE WIRING (shared by RTMP and SRT ingest)
// ═══════════════════════════════════════════════════════════════════════════

// Attach stderr parsing for connection state + live metrics, and stdout logging.
// Source codec/resolution/fps are read only from the *input* section so that
// the encoder's downscaled output renditions never overwrite the real values.
function attachFFmpegLogging(ffmpeg, streamKey, onFirstFrame) {
  let sawInput = false;
  let section = null; // 'input' | 'output'
  const info = { codec: 'unknown', resolution: 'unknown', fps: 0, bitrate: 0 };

  ffmpeg.stdout.on('data', (data) => {
    console.log(`[FFmpeg ${streamKey}] ${data.toString().trim()}`);
  });

  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();

    for (const line of output.split('\n')) {
      if (line.includes('Input #')) section = 'input';
      else if (line.includes('Output #') || line.includes('Stream mapping')) section = 'output';

      if (section === 'input') {
        const m = line.match(/Stream #0:\d+.*Video: (\w+).*?(\d{2,4}x\d{2,4})(?:.*?([\d.]+) fps)?/);
        if (m) {
          info.codec = m[1];
          info.resolution = m[2];
          if (m[3]) info.fps = parseFloat(m[3]);
          streamMetrics.set(streamKey, { ...info });
          broadcastMetrics(streamKey, info);
          if (!sawInput) {
            sawInput = true;
            if (onFirstFrame) onFirstFrame();
          }
        }
      }
    }

    const bitrateMatch = output.match(/bitrate=\s*([\d.]+)\s*kbits\/s/);
    if (bitrateMatch) {
      info.bitrate = parseInt(bitrateMatch[1], 10);
      streamMetrics.set(streamKey, { ...info });
    }

    console.log(`[FFmpeg ${streamKey}] ${output.trim()}`);
  });
}

function spawnTranscode(inputUrl, streamKey, encoder) {
  ensureHlsDirs(streamKey);
  const args = buildHLSArgs(inputUrl, hlsDirFor(streamKey), encoder);
  return spawn(config.ffmpegPath, args);
}

// ═══════════════════════════════════════════════════════════════════════════
// SRT LISTENER (accepts ANY codec, transcodes to H.264 HLS; self-restarts)
// ═══════════════════════════════════════════════════════════════════════════

async function startSRTListener(streamKey, srtPort) {
  if (srtListeners.has(streamKey)) return srtPort; // already running

  const encoder = await detectHardwareEncoder({ ffmpegPath: config.ffmpegPath });
  const srtUrl = `srt://0.0.0.0:${srtPort}?mode=listener`;

  const entry = { ffmpeg: null, port: srtPort, stopping: false, failures: 0 };
  srtListeners.set(streamKey, entry);

  const launch = () => {
    if (entry.stopping || shuttingDown) return;
    console.log(`[SRT] Listening on port ${srtPort} for ${streamKey} (encoder: ${encoder})`);

    const startedAt = Date.now();
    const ffmpeg = spawnTranscode(srtUrl, streamKey, encoder);
    entry.ffmpeg = ffmpeg;

    attachFFmpegLogging(ffmpeg, streamKey, () => {
      db.prepare('UPDATE stream_keys SET is_live = 1, started_at = CURRENT_TIMESTAMP WHERE key = ?').run(streamKey);
      console.log(`[SRT] ✅ Client connected to ${streamKey}`);
    });

    ffmpeg.on('error', (err) => console.error(`[SRT] ffmpeg spawn error for ${streamKey}:`, err.message));

    ffmpeg.on('close', (code) => {
      console.log(`[SRT] ffmpeg for ${streamKey} exited (code ${code})`);
      db.prepare('UPDATE stream_keys SET is_live = 0, ended_at = CURRENT_TIMESTAMP WHERE key = ?').run(streamKey);
      streamMetrics.delete(streamKey);

      if (entry.stopping || shuttingDown) return;

      // Re-arm the listener for the next session, with backoff if it is
      // failing fast (e.g. the port could not be bound).
      const ranFor = Date.now() - startedAt;
      entry.failures = ranFor < 5000 ? entry.failures + 1 : 0;
      const delay = Math.min(30000, 1000 * 2 ** entry.failures);
      entry.restartTimer = setTimeout(launch, delay);
    });
  };

  launch();
  return srtPort;
}

function stopSRTListener(streamKey) {
  const entry = srtListeners.get(streamKey);
  if (!entry) return;
  entry.stopping = true;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  if (entry.ffmpeg) entry.ffmpeg.kill('SIGINT');
  srtListeners.delete(streamKey);
}

// ═══════════════════════════════════════════════════════════════════════════
// RTMP SERVER (node-media-server)
// ═══════════════════════════════════════════════════════════════════════════

const nms = new NodeMediaServer({
  rtmp: {
    port: config.rtmpPort,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: config.mediaHttpPort,
    allow_origin: '*',
    mediaroot: config.mediaRoot,
  },
});

nms.on('prePublish', (id, StreamPath) => {
  const streamKey = StreamPath.split('/').pop();
  const keyData = db.prepare('SELECT * FROM stream_keys WHERE key = ?').get(streamKey);

  if (!keyData) {
    console.log('[RTMP] ❌ Invalid stream key:', streamKey);
    const session = nms.getSession(id);
    if (session) session.reject();
    return;
  }
  console.log('[RTMP] ✅ Valid stream key:', streamKey);
  db.prepare('UPDATE stream_keys SET is_live = 1, started_at = CURRENT_TIMESTAMP WHERE key = ?').run(streamKey);
});

nms.on('postPublish', async (id, StreamPath) => {
  const parts = StreamPath.split('/');
  const appName = parts[1];
  const streamKey = parts.pop();
  if (appName !== 'live') return;

  // Validate again — postPublish fires even if we rejected in prePublish only
  // on some paths; never transcode an unknown key.
  if (!db.prepare('SELECT 1 FROM stream_keys WHERE key = ?').get(streamKey)) return;

  const encoder = await detectHardwareEncoder({ ffmpegPath: config.ffmpegPath });
  const inputUrl = `rtmp://127.0.0.1:${config.rtmpPort}${StreamPath}`;
  console.log(`[RTMP] Transcoding ${inputUrl} (encoder: ${encoder})`);

  const ffmpeg = spawnTranscode(inputUrl, streamKey, encoder);
  attachFFmpegLogging(ffmpeg, streamKey);
  ffmpeg.on('error', (err) => console.error(`[RTMP] ffmpeg spawn error for ${streamKey}:`, err.message));
  ffmpeg.on('close', (code) => {
    console.log(`[RTMP] ffmpeg for ${streamKey} exited (code ${code})`);
    ffmpegProcesses.delete(streamKey);
  });
  ffmpegProcesses.set(streamKey, ffmpeg);
});

nms.on('donePublish', (id, StreamPath) => {
  const streamKey = StreamPath.split('/').pop();
  db.prepare('UPDATE stream_keys SET is_live = 0, ended_at = CURRENT_TIMESTAMP WHERE key = ?').run(streamKey);
  streamMetrics.delete(streamKey);

  const ffmpeg = ffmpegProcesses.get(streamKey);
  if (ffmpeg) {
    ffmpeg.kill('SIGINT');
    ffmpegProcesses.delete(streamKey);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WEB SERVER & API
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve HLS (and other media) from the same origin as the dashboard, with the
// correct content types and CORS so any player can fetch it.
app.use('/media', express.static(config.mediaRoot, {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    }
  },
}));

// ── WebSocket: real-time metrics ───────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe' && data.streamKey) {
        ws.streamKey = data.streamKey;
        if (streamMetrics.has(data.streamKey)) {
          ws.send(JSON.stringify({ type: 'metrics', data: streamMetrics.get(data.streamKey) }));
        }
      }
    } catch (e) {
      console.error('[WebSocket] Bad message:', e.message);
    }
  });
});

function broadcastMetrics(streamKey, metrics) {
  for (const client of wss.clients) {
    if (client.streamKey === streamKey && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'metrics', data: metrics }));
    }
  }
}

// ── URL builders ───────────────────────────────────────────────────────────
const rtmpIngest = () => `rtmp://${config.publicHost}:${config.rtmpPort}/live`;
const srtIngest = (port) => `srt://${config.publicHost}:${port}?mode=caller`;
const hlsUrlFor = (key) => `http://${config.publicHost}:${config.webPort}/media/live/${key}/master.m3u8`;
const watchUrlFor = (key) => `http://${config.publicHost}:${config.webPort}/watch.html?key=${key}`;

// ── API: generate a new stream key ─────────────────────────────────────────
app.post('/api/generate-key', async (req, res) => {
  try {
    let name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length > 100) name = name.slice(0, 100);
    if (!name) name = 'Unnamed Stream';

    const streamKey = randomUUID();

    // Pick the next free SRT port.
    const usedPorts = new Set(db.prepare('SELECT srt_port FROM stream_keys').all().map((r) => r.srt_port));
    let srtPort = config.srtBasePort;
    while (usedPorts.has(srtPort)) srtPort++;

    db.prepare('INSERT INTO stream_keys (key, name, srt_port) VALUES (?, ?, ?)').run(streamKey, name, srtPort);
    await startSRTListener(streamKey, srtPort);

    res.json({
      streamKey,
      name,
      rtmpUrl: rtmpIngest(),
      rtmpStreamKey: streamKey,
      srtUrl: srtIngest(srtPort),
      srtPort,
      hlsUrl: hlsUrlFor(streamKey),
      webPlayerUrl: watchUrlFor(streamKey),
      protocols: {
        rtmp: {
          server: rtmpIngest(),
          streamKey,
          codecs: ['H.264'],
          note: 'Traditional RTMP (H.264 only)',
        },
        srt: {
          url: srtIngest(srtPort),
          codecs: ['AV1', 'HEVC', 'H.264', 'VP9'],
          note: 'Modern SRT (accepts ANY codec, transcodes to H.264 for web playback)',
        },
      },
    });
  } catch (err) {
    console.error('[API] generate-key failed:', err);
    res.status(500).json({ error: 'Failed to generate stream key' });
  }
});

// ── API: list all stream keys ──────────────────────────────────────────────
app.get('/api/keys', (req, res) => {
  res.json(db.prepare('SELECT * FROM stream_keys ORDER BY created_at DESC').all());
});

// ── API: get one stream key ────────────────────────────────────────────────
app.get('/api/key/:key', (req, res) => {
  const keyData = db.prepare('SELECT * FROM stream_keys WHERE key = ?').get(req.params.key);
  if (!keyData) return res.status(404).json({ error: 'Key not found' });

  if (streamMetrics.has(req.params.key)) keyData.metrics = streamMetrics.get(req.params.key);
  res.json({ ...keyData, hlsUrl: hlsUrlFor(req.params.key) });
});

// ── API: delete a stream key ───────────────────────────────────────────────
app.delete('/api/key/:key', (req, res) => {
  const keyData = db.prepare('SELECT * FROM stream_keys WHERE key = ?').get(req.params.key);
  if (!keyData) return res.status(404).json({ error: 'Key not found' });
  if (keyData.is_live) return res.status(400).json({ error: 'Cannot delete a live stream' });

  stopSRTListener(req.params.key);
  db.prepare('DELETE FROM stream_keys WHERE key = ?').run(req.params.key);

  // Best-effort cleanup of the on-disk HLS output.
  fs.rm(hlsDirFor(req.params.key), { recursive: true, force: true }, () => {});

  res.json({ success: true });
});

// ── API: live metrics ──────────────────────────────────────────────────────
app.get('/api/metrics/:key', (req, res) => {
  if (streamMetrics.has(req.params.key)) return res.json(streamMetrics.get(req.params.key));
  res.status(404).json({ error: 'No live metrics available' });
});

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP / SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received — cleaning up...`);

  try { db.prepare('UPDATE stream_keys SET is_live = 0').run(); } catch (e) { /* db may be closed */ }
  for (const ffmpeg of ffmpegProcesses.values()) { try { ffmpeg.kill('SIGKILL'); } catch (e) { /* ignore */ } }
  for (const entry of srtListeners.values()) {
    entry.stopping = true;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    try { entry.ffmpeg?.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }
  try { nms.stop(); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  try { db.close(); } catch (e) { /* ignore */ }

  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function start() {
  nms.run();

  // Restore SRT listeners for existing keys; mark everything offline first.
  const keys = db.prepare('SELECT * FROM stream_keys').all();
  db.prepare('UPDATE stream_keys SET is_live = 0').run();
  for (const keyData of keys) {
    await startSRTListener(keyData.key, keyData.srt_port); // eslint-disable-line no-await-in-loop
    console.log(`[Startup] Restored SRT listener for ${keyData.name} (${keyData.key})`);
  }

  const encoder = await detectHardwareEncoder({ ffmpegPath: config.ffmpegPath });

  server.listen(config.webPort, () => {
    console.log('\n' + '═'.repeat(80));
    console.log('🚀 PROFESSIONAL STREAMING SERVER');
    console.log('═'.repeat(80));
    console.log(`\n📺 Web Dashboard:    http://${config.publicHost}:${config.webPort}`);
    console.log(`📡 RTMP Server:      ${rtmpIngest()} (H.264)`);
    console.log(`🎯 SRT Server:       Dynamic ports from ${config.srtBasePort} (ANY codec)`);
    console.log(`🎬 Media (FLV):      http://${config.publicHost}:${config.mediaHttpPort}`);
    console.log(`💾 Database:         ${config.dbPath}`);
    console.log(`⚡ Hardware Accel:    ${encoder}`);
    console.log('\n' + '═'.repeat(80) + '\n');
    // Machine-readable readiness marker (used by tests / supervisors).
    console.log(`[READY] web=${config.webPort} rtmp=${config.rtmpPort} encoder=${encoder}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[Fatal] Startup failed:', err);
    process.exit(1);
  });
}

module.exports = { app, server, db, start, shutdown };
