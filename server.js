const express = require('express');
const NodeMediaServer = require('node-media-server');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Конфигурация
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

// Хранилище FFmpeg процессов для каждого стрима
const ffmpegProcesses = new Map();

// Создаем необходимые директории
const dirs = ['./media', './media/live'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Хранилище ключей трансляции (в реальном приложении используйте БД)
const streamKeys = new Map();

// Создаем RTMP сервер
const nms = new NodeMediaServer(config);

// События RTMP сервера
nms.on('preConnect', (id, args) => {
  console.log('[NodeEvent on preConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('postConnect', (id, args) => {
  console.log('[NodeEvent on postConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('doneConnect', (id, args) => {
  console.log('[NodeEvent on doneConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('prePublish', (id, StreamPath, args) => {
  console.log('[NodeEvent on prePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);

  // Извлекаем ключ трансляции из пути
  // Формат: /live/STREAM_KEY
  const streamKey = StreamPath.split('/').pop();

  // Проверяем, существует ли такой ключ
  if (!streamKeys.has(streamKey)) {
    console.log('[Reject] Invalid stream key:', streamKey);
    // Отклоняем публикацию с неверным ключом
    let session = nms.getSession(id);
    session.reject();
  } else {
    console.log('[Accept] Valid stream key:', streamKey);
    const keyData = streamKeys.get(streamKey);
    keyData.isLive = true;
    keyData.startedAt = new Date().toISOString();
  }
});

nms.on('postPublish', (id, StreamPath, args) => {
  console.log('[NodeEvent on postPublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);

  // Запускаем FFmpeg для конвертации RTMP в HLS
  const streamKey = StreamPath.split('/').pop();
  const app = StreamPath.split('/')[1];

  if (app === 'live') {
    const hlsDir = `./media/live/${streamKey}`;

    // Создаем директорию для HLS сегментов
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }

    const rtmpUrl = `rtmp://localhost:1935${StreamPath}`;
    const hlsPath = `${hlsDir}/index.m3u8`;

    console.log(`[FFmpeg] Starting transcoding: ${rtmpUrl} -> ${hlsPath}`);

    // Запускаем FFmpeg для конвертации RTMP в HLS
    const ffmpeg = spawn('ffmpeg', [
      '-i', rtmpUrl,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '3',
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', `${hlsDir}/segment%03d.ts`,
      hlsPath
    ]);

    ffmpeg.stdout.on('data', (data) => {
      console.log(`[FFmpeg] ${streamKey}: ${data}`);
    });

    ffmpeg.stderr.on('data', (data) => {
      console.log(`[FFmpeg] ${streamKey}: ${data}`);
    });

    ffmpeg.on('close', (code) => {
      console.log(`[FFmpeg] ${streamKey} process exited with code ${code}`);
      ffmpegProcesses.delete(streamKey);
    });

    ffmpegProcesses.set(streamKey, ffmpeg);
  }
});

nms.on('donePublish', (id, StreamPath, args) => {
  console.log('[NodeEvent on donePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);

  // Помечаем стрим как оффлайн
  const streamKey = StreamPath.split('/').pop();
  if (streamKeys.has(streamKey)) {
    const keyData = streamKeys.get(streamKey);
    keyData.isLive = false;
    keyData.endedAt = new Date().toISOString();
  }

  // Останавливаем FFmpeg процесс
  if (ffmpegProcesses.has(streamKey)) {
    console.log(`[FFmpeg] Stopping transcoding for ${streamKey}`);
    const ffmpeg = ffmpegProcesses.get(streamKey);
    ffmpeg.kill('SIGINT');
    ffmpegProcesses.delete(streamKey);
  }
});

// Запускаем RTMP сервер
nms.run();

// Web сервер для интерфейса
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/media', express.static('media'));

// API: Генерация нового ключа трансляции
app.post('/api/generate-key', (req, res) => {
  const { name } = req.body;
  const streamKey = uuidv4();

  streamKeys.set(streamKey, {
    name: name || 'Unnamed Stream',
    createdAt: new Date().toISOString(),
    isLive: false
  });

  res.json({
    streamKey,
    rtmpUrl: `rtmp://localhost:1935/live`,
    fullUrl: `rtmp://localhost:1935/live/${streamKey}`,
    hlsUrl: `http://localhost:8000/live/${streamKey}/index.m3u8`,
    webPlayerUrl: `http://localhost:3000/watch.html?key=${streamKey}`
  });
});

// API: Получить список всех ключей
app.get('/api/keys', (req, res) => {
  const keys = Array.from(streamKeys.entries()).map(([key, data]) => ({
    key,
    ...data
  }));
  res.json(keys);
});

// API: Получить информацию о конкретном ключе
app.get('/api/key/:key', (req, res) => {
  const { key } = req.params;

  if (!streamKeys.has(key)) {
    return res.status(404).json({ error: 'Key not found' });
  }

  res.json({
    key,
    ...streamKeys.get(key),
    hlsUrl: `http://localhost:8000/live/${key}/index.m3u8`
  });
});

// API: Удалить ключ
app.delete('/api/key/:key', (req, res) => {
  const { key } = req.params;

  if (!streamKeys.has(key)) {
    return res.status(404).json({ error: 'Key not found' });
  }

  const keyData = streamKeys.get(key);
  if (keyData.isLive) {
    return res.status(400).json({ error: 'Cannot delete a live stream' });
  }

  streamKeys.delete(key);
  res.json({ success: true });
});

// Запускаем веб-сервер
const WEB_PORT = 3000;
app.listen(WEB_PORT, () => {
  console.log('='.repeat(60));
  console.log('🚀 RTMP Streaming Server Started!');
  console.log('='.repeat(60));
  console.log(`📺 Web Interface: http://localhost:${WEB_PORT}`);
  console.log(`📡 RTMP Server: rtmp://localhost:1935/live`);
  console.log(`🎬 Media Server: http://localhost:8000`);
  console.log('='.repeat(60));
  console.log('\n📝 Instructions:');
  console.log('1. Open http://localhost:3000 in your browser');
  console.log('2. Generate a stream key');
  console.log('3. Configure OBS with the provided RTMP URL and stream key');
  console.log('4. Start streaming!');
  console.log('='.repeat(60));
});
