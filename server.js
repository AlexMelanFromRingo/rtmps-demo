const express = require('express');
const NodeMediaServer = require('node-media-server');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const Database = require('better-sqlite3');
const http = require('http');
const WebSocket = require('ws');

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE SETUP (SQLite for persistence)
// ═══════════════════════════════════════════════════════════════════════════

const db = new Database('./streaming.db');
db.pragma('journal_mode = WAL');

// Create tables
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
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    allow_origin: '*',
    mediaroot: './media'
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

const ffmpegProcesses = new Map();
const srtListeners = new Map();
const streamMetrics = new Map(); // Real-time metrics
const SRT_BASE_PORT = 9000;

// Hardware encoder detection cache
let hardwareEncoder = null;

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// Create necessary directories
const dirs = ['./media', './media/live'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Detect hardware encoder (NVENC for RTX 4080)
function detectHardwareEncoder() {
  return new Promise((resolve) => {
    if (hardwareEncoder !== null) {
      return resolve(hardwareEncoder);
    }

    exec('ffmpeg -hide_banner -encoders', (error, stdout, stderr) => {
      if (error) {
        console.log('[HW Detect] Using software encoder (libx264)');
        hardwareEncoder = 'libx264';
        return resolve('libx264');
      }

      const output = stdout + stderr;

      // Check for NVENC support (RTX 4080 should have this)
      if (output.includes('h264_nvenc')) {
        console.log('[HW Detect] ✅ NVIDIA NVENC detected! Using h264_nvenc');
        hardwareEncoder = 'h264_nvenc';
        resolve('h264_nvenc');
      } else if (output.includes('h264_qsv')) {
        console.log('[HW Detect] ✅ Intel QSV detected! Using h264_qsv');
        hardwareEncoder = 'h264_qsv';
        resolve('h264_qsv');
      } else {
        console.log('[HW Detect] Using software encoder (libx264)');
        hardwareEncoder = 'libx264';
        resolve('libx264');
      }
    });
  });
}

// Get optimal FFmpeg parameters based on resolution and encoder
function getEncoderParams(encoder, resolution) {
  const baseParams = {
    h264_nvenc: [
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',          // Quality preset (p1=fastest, p7=slowest)
      '-tune', 'ull',           // Ultra-low latency
      '-rc', 'vbr',             // Variable bitrate
      '-b:v', getBitrate(resolution),
      '-maxrate', getMaxBitrate(resolution),
      '-bufsize', getBufferSize(resolution),
      '-profile:v', 'high',
      '-level', '4.2',
      '-g', '60',               // GOP size (2 seconds at 30fps)
      '-bf', '0',               // No B-frames for low latency
      '-pix_fmt', 'yuv420p'
    ],
    h264_qsv: [
      '-c:v', 'h264_qsv',
      '-preset', 'fast',
      '-b:v', getBitrate(resolution),
      '-maxrate', getMaxBitrate(resolution),
      '-bufsize', getBufferSize(resolution),
      '-g', '60',
      '-pix_fmt', 'nv12'
    ],
    libx264: [
      '-c:v', 'libx264',
      '-preset', 'veryfast',    // Best for live streaming
      '-tune', 'zerolatency',   // Minimize latency
      '-crf', '23',             // Quality (18-28)
      '-maxrate', getMaxBitrate(resolution),
      '-bufsize', getBufferSize(resolution),
      '-profile:v', 'high',
      '-level', '4.2',
      '-g', '60',
      '-sc_threshold', '0',
      '-bf', '0',
      '-pix_fmt', 'yuv420p'
    ]
  };

  return baseParams[encoder] || baseParams.libx264;
}

// Resolution-specific bitrates
function getBitrate(resolution) {
  const bitrates = {
    '3440x1440': '10000k',    // Ultrawide 1440p
    '2560x1440': '8000k',     // QHD
    '1920x1080': '5000k',     // Full HD
    '1280x720': '2500k',      // HD
    '854x480': '1200k',       // SD
    '640x360': '800k'         // Low
  };
  return bitrates[resolution] || '5000k';
}

function getMaxBitrate(resolution) {
  const maxBitrates = {
    '3440x1440': '12000k',
    '2560x1440': '10000k',
    '1920x1080': '6000k',
    '1280x720': '3000k',
    '854x480': '1500k',
    '640x360': '1000k'
  };
  return maxBitrates[resolution] || '6000k';
}

function getBufferSize(resolution) {
  const bufferSizes = {
    '3440x1440': '20000k',
    '2560x1440': '16000k',
    '1920x1080': '10000k',
    '1280x720': '5000k',
    '854x480': '2500k',
    '640x360': '1500k'
  };
  return bufferSizes[resolution] || '10000k';
}

// ═══════════════════════════════════════════════════════════════════════════
// SRT LISTENER (Accepts ANY codec, transcodes to H.264 for HLS)
// ═══════════════════════════════════════════════════════════════════════════

async function startSRTListener(streamKey, srtPort) {
  const hlsDir = `./media/live/${streamKey}`;

  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  const srtUrl = `srt://0.0.0.0:${srtPort}?mode=listener`;
  const encoder = await detectHardwareEncoder();

  console.log(`[SRT] Starting listener on port ${srtPort} for ${streamKey}`);
  console.log(`[SRT] Using encoder: ${encoder}`);

  // Get encoder params (will transcode to 1080p for master stream)
  const encoderParams = getEncoderParams(encoder, '1920x1080');

  // Master stream at source resolution
  const masterPath = `${hlsDir}/master.m3u8`;
  const v1080Path = `${hlsDir}/1080p/index.m3u8`;
  const v720Path = `${hlsDir}/720p/index.m3u8`;
  const v480Path = `${hlsDir}/480p/index.m3u8`;

  // Create variant directories
  ['1080p', '720p', '480p'].forEach(variant => {
    const variantDir = `${hlsDir}/${variant}`;
    if (!fs.existsSync(variantDir)) {
      fs.mkdirSync(variantDir, { recursive: true });
    }
  });

  // FFmpeg command with adaptive bitrate (multiple quality levels)
  // This accepts ANY codec (AV1, HEVC, H.264) and transcodes to H.264 for HLS
  const ffmpegArgs = [
    '-i', srtUrl,

    // Audio encoding (same for all variants)
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',

    // Map input to multiple outputs
    '-map', '0:v:0', '-map', '0:a:0',  // 1080p
    '-map', '0:v:0', '-map', '0:a:0',  // 720p
    '-map', '0:v:0', '-map', '0:a:0',  // 480p

    // 1080p stream
    ...encoderParams,
    '-s:v:0', '1920x1080',
    '-b:v:0', '5000k',
    '-maxrate:v:0', '6000k',
    '-bufsize:v:0', '10000k',

    // 720p stream
    ...encoderParams.map(p => p.replace(':v', ':v:1')),
    '-s:v:1', '1280x720',
    '-b:v:1', '2500k',
    '-maxrate:v:1', '3000k',
    '-bufsize:v:1', '5000k',

    // 480p stream
    ...encoderParams.map(p => p.replace(':v', ':v:2')),
    '-s:v:2', '854x480',
    '-b:v:2', '1200k',
    '-maxrate:v:2', '1500k',
    '-bufsize:v:2', '2500k',

    // HLS settings
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',

    // Variant stream mapping
    '-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2',
    '-master_pl_name', 'master.m3u8',
    '-hls_segment_filename', `${hlsDir}/%v/segment%03d.ts`,
    `${hlsDir}/%v/index.m3u8`
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  let isActive = false;
  let streamInfo = {
    codec: 'unknown',
    resolution: 'unknown',
    fps: 0,
    bitrate: 0
  };

  ffmpeg.stdout.on('data', (data) => {
    console.log(`[SRT FFmpeg] ${streamKey}: ${data}`);
  });

  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();

    // Detect connection
    if ((output.includes('Opening') || output.includes('Stream')) && !isActive) {
      isActive = true;
      const stmt = db.prepare('UPDATE stream_keys SET is_live = 1, started_at = CURRENT_TIMESTAMP WHERE key = ?');
      stmt.run(streamKey);
      console.log(`[SRT] ✅ Client connected to ${streamKey}`);
    }

    // Extract codec info
    if (output.includes('Stream #0:0')) {
      const codecMatch = output.match(/Video: (\w+)/);
      const resMatch = output.match(/(\d{3,4}x\d{3,4})/);
      const fpsMatch = output.match(/([\d.]+) fps/);

      if (codecMatch) streamInfo.codec = codecMatch[1];
      if (resMatch) streamInfo.resolution = resMatch[1];
      if (fpsMatch) streamInfo.fps = parseFloat(fpsMatch[1]);

      console.log(`[SRT] Stream info: ${streamInfo.codec} ${streamInfo.resolution} @ ${streamInfo.fps}fps`);

      // Update metrics
      streamMetrics.set(streamKey, streamInfo);
      broadcastMetrics(streamKey, streamInfo);
    }

    // Extract bitrate
    if (output.includes('bitrate=')) {
      const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
      if (bitrateMatch) {
        streamInfo.bitrate = parseInt(bitrateMatch[1]);
        streamMetrics.set(streamKey, streamInfo);
      }
    }

    console.log(`[SRT FFmpeg] ${streamKey}: ${output}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`[SRT] FFmpeg listener for ${streamKey} exited with code ${code}`);

    const stmt = db.prepare('UPDATE stream_keys SET is_live = 0, ended_at = CURRENT_TIMESTAMP WHERE key = ?');
    stmt.run(streamKey);

    srtListeners.delete(streamKey);
    streamMetrics.delete(streamKey);
  });

  srtListeners.set(streamKey, { ffmpeg, port: srtPort });
  return srtPort;
}

// ═══════════════════════════════════════════════════════════════════════════
// RTMP SERVER SETUP
// ═══════════════════════════════════════════════════════════════════════════

const nms = new NodeMediaServer(config);

nms.on('preConnect', (id, args) => {
  console.log('[RTMP] preConnect', `id=${id}`);
});

nms.on('postConnect', (id, args) => {
  console.log('[RTMP] postConnect', `id=${id}`);
});

nms.on('prePublish', (id, StreamPath, args) => {
  const streamKey = StreamPath.split('/').pop();

  const stmt = db.prepare('SELECT * FROM stream_keys WHERE key = ?');
  const keyData = stmt.get(streamKey);

  if (!keyData) {
    console.log('[RTMP] ❌ Invalid stream key:', streamKey);
    let session = nms.getSession(id);
    session.reject();
  } else {
    console.log('[RTMP] ✅ Valid stream key:', streamKey);
    const updateStmt = db.prepare('UPDATE stream_keys SET is_live = 1, started_at = CURRENT_TIMESTAMP WHERE key = ?');
    updateStmt.run(streamKey);
  }
});

nms.on('postPublish', async (id, StreamPath, args) => {
  const streamKey = StreamPath.split('/').pop();
  const app = StreamPath.split('/')[1];

  if (app !== 'live') return;

  const hlsDir = `./media/live/${streamKey}`;

  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  const rtmpUrl = `rtmp://localhost:1935${StreamPath}`;
  const encoder = await detectHardwareEncoder();

  console.log(`[RTMP] Starting transcoding: ${rtmpUrl}`);
  console.log(`[RTMP] Using encoder: ${encoder}`);

  const encoderParams = getEncoderParams(encoder, '1920x1080');

  // Similar adaptive bitrate setup as SRT
  const ffmpegArgs = [
    '-i', rtmpUrl,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    ...encoderParams,
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${hlsDir}/segment%03d.ts`,
    `${hlsDir}/index.m3u8`
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();
    console.log(`[RTMP FFmpeg] ${streamKey}: ${output}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`[RTMP] FFmpeg for ${streamKey} exited with code ${code}`);
    ffmpegProcesses.delete(streamKey);
  });

  ffmpegProcesses.set(streamKey, ffmpeg);
});

nms.on('donePublish', (id, StreamPath, args) => {
  const streamKey = StreamPath.split('/').pop();

  const stmt = db.prepare('UPDATE stream_keys SET is_live = 0, ended_at = CURRENT_TIMESTAMP WHERE key = ?');
  stmt.run(streamKey);

  if (ffmpegProcesses.has(streamKey)) {
    const ffmpeg = ffmpegProcesses.get(streamKey);
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
app.use(express.static('public'));
app.use('/media', express.static('media'));

// WebSocket for real-time metrics
wss.on('connection', (ws) => {
  console.log('[WebSocket] Client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe' && data.streamKey) {
        ws.streamKey = data.streamKey;
        // Send current metrics
        if (streamMetrics.has(data.streamKey)) {
          ws.send(JSON.stringify({
            type: 'metrics',
            data: streamMetrics.get(data.streamKey)
          }));
        }
      }
    } catch (e) {
      console.error('[WebSocket] Error:', e);
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
  });
});

function broadcastMetrics(streamKey, metrics) {
  wss.clients.forEach(client => {
    if (client.streamKey === streamKey && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'metrics',
        data: metrics
      }));
    }
  });
}

// API: Generate new stream key
app.post('/api/generate-key', async (req, res) => {
  const { name } = req.body;
  const streamKey = uuidv4();

  // Find next available SRT port
  const usedPorts = db.prepare('SELECT srt_port FROM stream_keys').all().map(r => r.srt_port);
  let srtPort = SRT_BASE_PORT;
  while (usedPorts.includes(srtPort)) {
    srtPort++;
  }

  const stmt = db.prepare('INSERT INTO stream_keys (key, name, srt_port) VALUES (?, ?, ?)');
  stmt.run(streamKey, name || 'Unnamed Stream', srtPort);

  // Start SRT listener
  await startSRTListener(streamKey, srtPort);

  res.json({
    streamKey,
    rtmpUrl: `rtmp://localhost:1935/live`,
    rtmpStreamKey: streamKey,
    srtUrl: `srt://localhost:${srtPort}?mode=caller`,
    srtPort,
    hlsUrl: `http://localhost:8000/live/${streamKey}/master.m3u8`,
    webPlayerUrl: `http://localhost:3000/watch.html?key=${streamKey}`,
    protocols: {
      rtmp: {
        server: `rtmp://localhost:1935/live`,
        streamKey: streamKey,
        codecs: ['H.264'],
        note: 'Traditional RTMP (H.264 only)'
      },
      srt: {
        url: `srt://localhost:${srtPort}?mode=caller`,
        codecs: ['AV1', 'HEVC', 'H.264', 'VP9'],
        note: 'Modern SRT (accepts ANY codec, transcodes to H.264 for web playback)'
      }
    }
  });
});

// API: Get all stream keys
app.get('/api/keys', (req, res) => {
  const stmt = db.prepare('SELECT * FROM stream_keys ORDER BY created_at DESC');
  const keys = stmt.all();
  res.json(keys);
});

// API: Get specific stream key info
app.get('/api/key/:key', (req, res) => {
  const { key } = req.params;
  const stmt = db.prepare('SELECT * FROM stream_keys WHERE key = ?');
  const keyData = stmt.get(key);

  if (!keyData) {
    return res.status(404).json({ error: 'Key not found' });
  }

  // Add real-time metrics if available
  if (streamMetrics.has(key)) {
    keyData.metrics = streamMetrics.get(key);
  }

  res.json({
    ...keyData,
    hlsUrl: `http://localhost:8000/live/${key}/master.m3u8`
  });
});

// API: Delete stream key
app.delete('/api/key/:key', (req, res) => {
  const { key } = req.params;

  const stmt = db.prepare('SELECT * FROM stream_keys WHERE key = ?');
  const keyData = stmt.get(key);

  if (!keyData) {
    return res.status(404).json({ error: 'Key not found' });
  }

  if (keyData.is_live) {
    return res.status(400).json({ error: 'Cannot delete a live stream' });
  }

  // Stop SRT listener
  if (srtListeners.has(key)) {
    const { ffmpeg } = srtListeners.get(key);
    ffmpeg.kill('SIGINT');
    srtListeners.delete(key);
  }

  const deleteStmt = db.prepare('DELETE FROM stream_keys WHERE key = ?');
  deleteStmt.run(key);

  res.json({ success: true });
});

// API: Get stream metrics
app.get('/api/metrics/:key', (req, res) => {
  const { key } = req.params;

  if (streamMetrics.has(key)) {
    res.json(streamMetrics.get(key));
  } else {
    res.json({ error: 'No live metrics available' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════

// Start RTMP server
nms.run();

// Restore SRT listeners from database
(async () => {
  const stmt = db.prepare('SELECT * FROM stream_keys');
  const keys = stmt.all();

  for (const keyData of keys) {
    // Mark all as offline on startup
    const updateStmt = db.prepare('UPDATE stream_keys SET is_live = 0 WHERE key = ?');
    updateStmt.run(keyData.key);

    // Restart SRT listeners
    await startSRTListener(keyData.key, keyData.srt_port);
    console.log(`[Startup] Restored SRT listener for ${keyData.name} (${keyData.key})`);
  }

  // Start web server
  const WEB_PORT = 3000;
  server.listen(WEB_PORT, () => {
    console.log('\n' + '═'.repeat(80));
    console.log('🚀 PROFESSIONAL STREAMING SERVER - POWERED BY RTX 4080 SUPER');
    console.log('═'.repeat(80));
    console.log(`\n📺 Web Dashboard:    http://localhost:${WEB_PORT}`);
    console.log(`📡 RTMP Server:      rtmp://localhost:1935/live (H.264)`);
    console.log(`🎯 SRT Server:       Dynamic ports from ${SRT_BASE_PORT} (ANY codec)`);
    console.log(`🎬 Media Server:     http://localhost:8000`);
    console.log(`💾 Database:         SQLite (persistent storage)`);
    console.log(`🔌 WebSocket:        Real-time metrics enabled`);
    console.log(`⚡ Hardware Accel:    ${hardwareEncoder || 'Detecting...'}`);
    console.log('\n' + '═'.repeat(80));
    console.log('✨ FEATURES:');
    console.log('  • Adaptive Bitrate (480p/720p/1080p)');
    console.log('  • Hardware encoding (NVENC on RTX 4080)');
    console.log('  • ANY codec support via SRT (AV1, HEVC, H.264, VP9)');
    console.log('  • Persistent stream keys (survives restarts)');
    console.log('  • Real-time metrics and monitoring');
    console.log('  • Professional web interface');
    console.log('═'.repeat(80) + '\n');
  });
})();
