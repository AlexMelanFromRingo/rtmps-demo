// ═══════════════════════════════════════════════════════════════════════════
// ENCODING HELPERS (pure, unit-testable)
//
// Builds correct FFmpeg argument vectors for an adaptive-bitrate (ABR) HLS
// ladder, and detects a usable hardware encoder by *actually running* it.
// Kept free of side effects (other than ffmpeg probing) so it can be tested
// without starting any network servers.
// ═══════════════════════════════════════════════════════════════════════════

const { execFile } = require('child_process');

// ───────────────────────────────────────────────────────────────────────────
// ABR ladder. One entry per rendition; order matters (best first).
// ───────────────────────────────────────────────────────────────────────────
const VARIANTS = [
  { name: '1080p', width: 1920, height: 1080, vBitrate: '5000k', vMaxrate: '5350k', vBufsize: '7500k', aBitrate: '192k' },
  { name: '720p',  width: 1280, height: 720,  vBitrate: '2800k', vMaxrate: '2996k', vBufsize: '4200k', aBitrate: '128k' },
  { name: '480p',  width: 854,  height: 480,  vBitrate: '1400k', vMaxrate: '1498k', vBufsize: '2100k', aBitrate: '96k'  },
];

// Single-resolution helpers (kept for API/back-compat and reuse).
const BITRATES = {
  '3440x1440': '10000k', '2560x1440': '8000k', '1920x1080': '5000k',
  '1280x720': '2500k', '854x480': '1200k', '640x360': '800k',
};
const MAX_BITRATES = {
  '3440x1440': '12000k', '2560x1440': '10000k', '1920x1080': '6000k',
  '1280x720': '3000k', '854x480': '1500k', '640x360': '1000k',
};
const BUFFER_SIZES = {
  '3440x1440': '20000k', '2560x1440': '16000k', '1920x1080': '10000k',
  '1280x720': '5000k', '854x480': '2500k', '640x360': '1500k',
};

const getBitrate = (resolution) => BITRATES[resolution] || '5000k';
const getMaxBitrate = (resolution) => MAX_BITRATES[resolution] || '6000k';
const getBufferSize = (resolution) => BUFFER_SIZES[resolution] || '10000k';

// ───────────────────────────────────────────────────────────────────────────
// Hardware encoder detection.
//
// IMPORTANT: a codec appearing in `ffmpeg -encoders` does NOT mean the hardware
// is present and usable (e.g. h264_nvenc is listed even on machines with no
// NVIDIA GPU). We must actually run a tiny encode and check the exit code.
// ───────────────────────────────────────────────────────────────────────────
let cachedEncoder = null;

function probeEncoder(encoder, ffmpegPath = 'ffmpeg') {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error',
       '-f', 'lavfi', '-i', 'testsrc2=size=256x144:rate=15', '-t', '0.1',
       '-c:v', encoder, '-f', 'null', '-'],
      { timeout: 15000 },
      (error) => resolve(!error),
    );
  });
}

async function detectHardwareEncoder({ ffmpegPath = 'ffmpeg', force = false } = {}) {
  if (cachedEncoder !== null && !force) return cachedEncoder;

  for (const encoder of ['h264_nvenc', 'h264_qsv']) {
    // eslint-disable-next-line no-await-in-loop
    if (await probeEncoder(encoder, ffmpegPath)) {
      cachedEncoder = encoder;
      return encoder;
    }
  }
  cachedEncoder = 'libx264';
  return 'libx264';
}

function resetEncoderCache() {
  cachedEncoder = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Global (applies to every video rendition) encoder settings for the chosen
// encoder. Per-rendition bitrate/scale is applied separately in buildHLSArgs.
// ───────────────────────────────────────────────────────────────────────────
function globalVideoEncoderArgs(encoder) {
  switch (encoder) {
    case 'h264_nvenc':
      return [
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-tune', 'll',          // low latency
        '-rc', 'vbr',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-g', '60',
        '-bf', '0',
      ];
    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv',
        '-preset', 'fast',
        '-profile:v', 'high',
        '-pix_fmt', 'nv12',
        '-g', '60',
      ];
    case 'libx264':
    default:
      return [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-bf', '0',
      ];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Build the full FFmpeg argument vector for an ABR HLS transcode.
//
//   inputUrl  e.g. rtmp://127.0.0.1:1935/live/<key>  or  srt://0.0.0.0:9000?mode=listener
//   hlsDir    output directory (its <variant>/ subdirs must already exist)
//   encoder   one of libx264 | h264_nvenc | h264_qsv
//
// Produces:  <hlsDir>/master.m3u8  +  <hlsDir>/<name>/index.m3u8  +  segments
// ───────────────────────────────────────────────────────────────────────────
function buildHLSArgs(inputUrl, hlsDir, encoder, variants = VARIANTS) {
  const n = variants.length;

  // filter_complex: split source, then scale+pad each rendition (preserving AR).
  const splitLabels = variants.map((_, i) => `[v${i}]`).join('');
  const scaleChains = variants.map((v, i) =>
    `[v${i}]scale=w=${v.width}:h=${v.height}:force_original_aspect_ratio=decrease,` +
    `pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}out]`,
  ).join(';');
  const filterComplex = `[0:v]split=${n}${splitLabels};${scaleChains}`;

  const args = ['-hide_banner', '-loglevel', 'info', '-i', inputUrl, '-filter_complex', filterComplex];

  // Map scaled video outputs, then one audio copy per rendition.
  variants.forEach((_, i) => args.push('-map', `[v${i}out]`));
  variants.forEach(() => args.push('-map', '0:a:0'));

  // Global video encoder settings + 2-second aligned keyframes for clean segments.
  args.push(...globalVideoEncoderArgs(encoder));
  args.push('-force_key_frames', 'expr:gte(t,n_forced*2)');

  // Per-rendition bitrate ceilings.
  variants.forEach((v, i) => {
    args.push(`-b:v:${i}`, v.vBitrate, `-maxrate:v:${i}`, v.vMaxrate, `-bufsize:v:${i}`, v.vBufsize);
  });

  // Audio (AAC) per rendition.
  args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2');
  variants.forEach((v, i) => args.push(`-b:a:${i}`, v.aBitrate));

  // HLS muxing with a master playlist and named variant streams.
  args.push(
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', variants.map((v, i) => `v:${i},a:${i},name:${v.name}`).join(' '),
    '-hls_segment_filename', `${hlsDir}/%v/segment_%03d.ts`,
    `${hlsDir}/%v/index.m3u8`,
  );

  return args;
}

module.exports = {
  VARIANTS,
  getBitrate,
  getMaxBitrate,
  getBufferSize,
  detectHardwareEncoder,
  probeEncoder,
  resetEncoderCache,
  globalVideoEncoderArgs,
  buildHLSArgs,
};
