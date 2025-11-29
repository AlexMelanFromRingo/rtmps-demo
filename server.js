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

// Хранилище SRT listeners
const srtListeners = new Map();

// SRT порты (динамические)
const SRT_BASE_PORT = 9000;
let srtPortCounter = 0;

// Создаем необходимые директории
const dirs = ['./media', './media/live'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Хранилище ключей трансляции (в реальном приложении используйте БД)
const streamKeys = new Map();

// Функция для запуска SRT listener для stream key
function startSRTListener(streamKey, srtPort) {
  const hlsDir = `./media/live/${streamKey}`;

  if (!fs.existsSync(hlsDir)) {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  const hlsPath = `${hlsDir}/index.m3u8`;
  const srtUrl = `srt://0.0.0.0:${srtPort}?mode=listener`;

  console.log(`[SRT] Starting listener on port ${srtPort} for ${streamKey}`);

  // Запускаем FFmpeg в режиме SRT listener
  // Это позволяет принимать ЛЮБОЙ кодек (AV1, HEVC, H.264, VP9, etc.)
  const ffmpeg = spawn('ffmpeg', [
    '-i', srtUrl,
    '-c:v', 'copy',                 // Копируем видео как есть (без перекодирования!)
    '-c:a', 'aac',                  // Аудио в AAC
    '-b:a', '192k',
    '-ar', '48000',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${hlsDir}/segment%03d.ts`,
    hlsPath
  ]);

  let isActive = false;

  ffmpeg.stdout.on('data', (data) => {
    console.log(`[SRT FFmpeg] ${streamKey}: ${data}`);
  });

  ffmpeg.stderr.on('data', (data) => {
    const output = data.toString();

    // Определяем когда клиент подключился
    if (output.includes('Opening') || output.includes('Stream')) {
      if (!isActive && streamKeys.has(streamKey)) {
        isActive = true;
        const keyData = streamKeys.get(streamKey);
        keyData.isLive = true;
        keyData.startedAt = new Date().toISOString();
        console.log(`[SRT] Client connected to ${streamKey}`);
      }
    }

    console.log(`[SRT FFmpeg] ${streamKey}: ${output}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`[SRT] FFmpeg listener for ${streamKey} exited with code ${code}`);

    if (streamKeys.has(streamKey)) {
      const keyData = streamKeys.get(streamKey);
      keyData.isLive = false;
      keyData.endedAt = new Date().toISOString();
    }

    srtListeners.delete(streamKey);
  });

  srtListeners.set(streamKey, { ffmpeg, port: srtPort });
  return srtPort;
}

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
    // Декодируем входящий поток и перекодируем в H.264 для совместимости
    const ffmpeg = spawn('ffmpeg', [
      '-i', rtmpUrl,
      '-c:v', 'libx264',              // Перекодируем в H.264
      '-preset', 'veryfast',          // Быстрое кодирование
      '-crf', '23',                   // Качество (18-28, меньше = лучше)
      '-maxrate', '6000k',            // Максимальный битрейт для 1440p
      '-bufsize', '12000k',           // Буфер
      '-g', '60',                     // GOP size (keyframe interval)
      '-sc_threshold', '0',           // Disable scene change detection
      '-c:a', 'aac',                  // Аудио кодек
      '-b:a', '192k',                 // Битрейт аудио
      '-ar', '48000',                 // Sample rate
      '-f', 'hls',                    // HLS формат
      '-hls_time', '2',               // Длина сегмента (секунды)
      '-hls_list_size', '5',          // Количество сегментов в плейлисте
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', `${hlsDir}/segment%03d.ts`,
      '-pix_fmt', 'yuv420p',          // Pixel format для совместимости
      hlsPath
    ]);

    let ffmpegLog = '';
    let codecErrorDetected = false;

    ffmpeg.stdout.on('data', (data) => {
      console.log(`[FFmpeg] ${streamKey}: ${data}`);
    });

    ffmpeg.stderr.on('data', (data) => {
      const output = data.toString();
      ffmpegLog += output;

      // Проверяем на ошибку кодека
      if (output.includes('Video codec') && output.includes('is not implemented')) {
        codecErrorDetected = true;
        console.error('\n' + '='.repeat(70));
        console.error('❌ ОШИБКА: НЕПОДДЕРЖИВАЕМЫЙ ВИДЕО КОДЕК');
        console.error('='.repeat(70));
        console.error('OBS отправляет видео в кодеке, который не поддерживается RTMP.');
        console.error('');
        console.error('РЕШЕНИЕ:');
        console.error('1. Откройте OBS → Настройки → Вывод');
        console.error('2. Режим вывода: "Расширенный"');
        console.error('3. Кодировщик видео: "NVIDIA NVENC H.264"');
        console.error('   (НЕ AV1, НЕ HEVC!)');
        console.error('4. Применить → OK → Перезапустите OBS');
        console.error('5. Начните трансляцию заново');
        console.error('');
        console.error('📖 Подробная инструкция: cat TROUBLESHOOTING.md');
        console.error('='.repeat(70) + '\n');
      }

      // Определяем кодек из логов FFmpeg
      if (output.includes('Video: none ([13][0][0][0]') || output.includes('0x000D')) {
        console.error('⚠️  Обнаружен AV1 кодек (0x0D) - не поддерживается RTMP!');
      }

      console.log(`[FFmpeg] ${streamKey}: ${output}`);
    });

    ffmpeg.on('close', (code) => {
      console.log(`[FFmpeg] ${streamKey} process exited with code ${code}`);

      if (codecErrorDetected && code !== 0) {
        console.error(`\n❌ Транскодирование не удалось для ${streamKey}`);
        console.error('   Причина: Неподдерживаемый видео кодек от OBS');
        console.error('   Смените кодек на H.264 в настройках OBS!\n');
      }

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

  // Выделяем порт для SRT
  const srtPort = SRT_BASE_PORT + srtPortCounter;
  srtPortCounter++;

  streamKeys.set(streamKey, {
    name: name || 'Unnamed Stream',
    createdAt: new Date().toISOString(),
    isLive: false,
    srtPort
  });

  // Запускаем SRT listener для этого ключа
  startSRTListener(streamKey, srtPort);

  res.json({
    streamKey,
    // RTMP endpoints (H.264 only)
    rtmpUrl: `rtmp://localhost:1935/live`,
    rtmpFullUrl: `rtmp://localhost:1935/live/${streamKey}`,
    // SRT endpoints (ANY codec: AV1, HEVC, H.264, VP9, etc.)
    srtUrl: `srt://localhost:${srtPort}?mode=caller`,
    srtPort,
    // Common
    hlsUrl: `http://localhost:8000/live/${streamKey}/index.m3u8`,
    webPlayerUrl: `http://localhost:3000/watch.html?key=${streamKey}`,
    // Info
    protocols: {
      rtmp: {
        url: `rtmp://localhost:1935/live/${streamKey}`,
        codecs: ['H.264'],
        note: 'Use this for compatibility (H.264 only)'
      },
      srt: {
        url: `srt://localhost:${srtPort}?mode=caller`,
        codecs: ['AV1', 'HEVC', 'H.264', 'VP9', 'VP8'],
        note: 'Use this for any modern codec (recommended)'
      }
    }
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

  // Останавливаем SRT listener
  if (srtListeners.has(key)) {
    const { ffmpeg } = srtListeners.get(key);
    ffmpeg.kill('SIGINT');
    srtListeners.delete(key);
    console.log(`[SRT] Stopped listener for ${key}`);
  }

  streamKeys.delete(key);
  res.json({ success: true });
});

// Запускаем веб-сервер
const WEB_PORT = 3000;
app.listen(WEB_PORT, () => {
  console.log('='.repeat(70));
  console.log('🚀 RTMP + SRT Streaming Server Started!');
  console.log('='.repeat(70));
  console.log(`📺 Web Interface: http://localhost:${WEB_PORT}`);
  console.log(`📡 RTMP Server: rtmp://localhost:1935/live (H.264 only)`);
  console.log(`🎯 SRT Server: Dynamic ports starting from ${SRT_BASE_PORT} (ANY codec!)`);
  console.log(`🎬 Media Server: http://localhost:8000`);
  console.log('='.repeat(70));
  console.log('\n📝 Instructions:');
  console.log('1. Open http://localhost:3000 in your browser');
  console.log('2. Generate a stream key');
  console.log('3. Choose protocol:');
  console.log('   • RTMP - For H.264 codec (compatible)');
  console.log('   • SRT  - For ANY codec (AV1, HEVC, H.264, VP9) ⭐ RECOMMENDED');
  console.log('4. Configure OBS and start streaming!');
  console.log('='.repeat(70));
  console.log('\n✨ NEW: SRT support allows streaming with ANY video codec!');
  console.log('   Use your RTX 4080 with AV1 codec for best quality! 🚀');
  console.log('='.repeat(70));
});
