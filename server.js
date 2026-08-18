'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { promises: fs, createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

const MIB = 1024 * 1024;
const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = String(process.env.CONVERTER_API_TOKEN || '');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_MB || 48) * MIB;
const TELEGRAM_TARGET_OUTPUT_BYTES = Math.max(
  5 * MIB,
  Math.min(Number(process.env.TARGET_OUTPUT_MB || 44) * MIB, MAX_OUTPUT_BYTES - 2 * MIB),
);
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_SECONDS || 360) * 1000;
const FFPROBE_TIMEOUT_MS = 30000;
const POSTER_SECONDS = Math.min(3, Math.max(0.5, Number(process.env.POSTER_SECONDS || 1.5)));
const AUDIO_BITRATE_KBPS = 128;
const MAX_VIDEO_BITRATE_KBPS = 4500;
const MIN_VIDEO_BITRATE_KBPS = 350;
const MIN_WEB_OUTPUT_VIDEO_BITRATE_KBPS = 900;
const OUTPUT_DURATION_TOLERANCE_SECONDS = 2.5;
const ALLOWED_HOSTS = new Set([
  'video.akamai.steamstatic.com',
  'cdn.akamai.steamstatic.com',
  'shared.akamai.steamstatic.com',
]);

let activeConversion = false;

function log(level, event, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  }));
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function tokenMatches(headerValue) {
  const expected = `Bearer ${API_TOKEN}`;
  const actual = String(headerValue || '');
  if (!API_TOKEN || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function validateSteamHls(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    const error = new Error('hls_url must be a valid URL');
    error.statusCode = 400;
    throw error;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    const error = new Error('hls_url host is not allowed');
    error.statusCode = 400;
    throw error;
  }
  if (!url.pathname.toLowerCase().endsWith('.m3u8')) {
    const error = new Error('hls_url must point to an .m3u8 playlist');
    error.statusCode = 400;
    throw error;
  }
  return url.toString();
}

function validateSteamCover(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    const error = new Error('cover_url must be a valid URL');
    error.statusCode = 400;
    throw error;
  }
  const hostname = url.hostname.toLowerCase();
  const pathname = url.pathname.toLowerCase();
  if (url.protocol !== 'https:' || hostname !== 'shared.akamai.steamstatic.com') {
    const error = new Error('cover_url host is not allowed');
    error.statusCode = 400;
    throw error;
  }
  if (!pathname.startsWith('/store_item_assets/steam/apps/') || !/\.jpe?g$/.test(pathname)) {
    const error = new Error('cover_url must point to a Steam JPEG asset');
    error.statusCode = 400;
    throw error;
  }
  return url.toString();
}

async function downloadSteamCover(coverUrl, outputPath) {
  let response;
  try {
    response = await fetch(coverUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'user-agent': 'GDZ-Steam-FFmpeg-Converter/1.2.0' },
    });
  } catch (cause) {
    const error = new Error(`Steam cover download failed: ${cause.message}`);
    error.code = 'COVER_DOWNLOAD_FAILED';
    error.statusCode = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`Steam cover returned HTTP ${response.status}`);
    error.code = 'COVER_DOWNLOAD_FAILED';
    error.statusCode = 502;
    throw error;
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/jpeg')) {
    const error = new Error('Steam cover response is not JPEG');
    error.code = 'INVALID_COVER_FILE';
    error.statusCode = 502;
    throw error;
  }
  const cover = Buffer.from(await response.arrayBuffer());
  if (!cover.length || cover.length > 2 * 1024 * 1024) {
    const error = new Error('Steam cover size is invalid');
    error.code = 'INVALID_COVER_FILE';
    error.statusCode = 502;
    throw error;
  }
  if (cover[0] !== 0xff || cover[1] !== 0xd8 || cover[2] !== 0xff) {
    const error = new Error('Steam cover has an invalid JPEG signature');
    error.code = 'INVALID_COVER_FILE';
    error.statusCode = 502;
    throw error;
  }
  await fs.writeFile(outputPath, cover);
  return cover.length;
}

function probeDuration(inputUrl, requestId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputUrl,
    ];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-2000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error('FFprobe duration check timed out');
      error.code = 'FFPROBE_TIMEOUT';
      error.statusCode = 504;
      reject(error);
    }, FFPROBE_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const duration = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) return resolve(duration);
      const error = new Error('Unable to determine Steam trailer duration');
      error.code = 'FFPROBE_FAILED';
      error.statusCode = 502;
      log('error', 'ffprobe_failed', { request_id: requestId, code, signal, output: stderr });
      reject(error);
    });
  });
}

function probeOutput(outputPath, requestId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height,avg_frame_rate,bit_rate',
      '-of', 'json',
      outputPath,
    ];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-20000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error('Output validation timed out');
      error.code = 'OUTPUT_VALIDATION_TIMEOUT';
      error.statusCode = 504;
      reject(error);
    }, FFPROBE_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          return resolve(JSON.parse(stdout));
        } catch {
          // handled below
        }
      }
      const error = new Error('Unable to validate converted trailer');
      error.code = 'OUTPUT_VALIDATION_FAILED';
      error.statusCode = 502;
      log('error', 'output_probe_failed', { request_id: requestId, code, signal, output: stderr });
      reject(error);
    });
  });
}

function buildEncodingProfile(durationSeconds, profileName = 'telegram') {
  const webProfile = profileName === 'web';
  const targetOutputBytes = webProfile
    ? Math.min(Number(process.env.WEB_TARGET_OUTPUT_MB || 36) * MIB, 40 * MIB)
    : TELEGRAM_TARGET_OUTPUT_BYTES;
  const maxOutputBytes = webProfile
    ? Math.min(Number(process.env.WEB_MAX_OUTPUT_MB || 42) * MIB, 46 * MIB)
    : MAX_OUTPUT_BYTES;
  const audioKbps = AUDIO_BITRATE_KBPS;
  const minVideoKbps = webProfile ? 700 : MIN_VIDEO_BITRATE_KBPS;
  const maxVideoKbps = webProfile ? 4000 : MAX_VIDEO_BITRATE_KBPS;
  const budgetKbps = Math.floor((targetOutputBytes * 8 * 0.96) / durationSeconds / 1000);
  const uncappedVideoKbps = budgetKbps - audioKbps;
  if (uncappedVideoKbps < minVideoKbps) {
    const error = new Error('Steam trailer is too long for the configured output limit');
    error.code = 'TRAILER_TOO_LONG';
    error.statusCode = 413;
    throw error;
  }
  const videoKbps = Math.min(maxVideoKbps, uncappedVideoKbps);
  return {
    name: webProfile ? 'web' : 'telegram',
    width: 1280,
    height: 720,
    audioKbps,
    targetOutputBytes,
    maxOutputBytes,
    preset: 'fast',
    videoKbps,
    maxrateKbps: Math.ceil(videoKbps * 1.1),
    bufsizeKbps: videoKbps * 2,
  };
}

async function runFfmpegFile(inputUrl, coverPath, outputPath, requestId, profile) {
    const filter = [
      `[0:v:0]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,` +
        `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[main]`,
      `[1:v:0]scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,` +
        `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[poster]`,
      `[main][poster]overlay=0:0:enable='lt(t,${POSTER_SECONDS})':shortest=1[v]`,
    ].join(';');
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', inputUrl,
      '-loop', '1',
      '-framerate', '30',
      '-i', coverPath,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', profile.preset,
      '-b:v', `${profile.videoKbps}k`,
      '-maxrate', `${profile.maxrateKbps}k`,
      '-bufsize', `${profile.bufsizeKbps}k`,
      '-profile:v', 'high',
      '-level:v', '4.0',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', `${profile.audioKbps}k`,
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '2048',
      '-y',
      outputPath,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);
    const childDone = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (timedOut) {
          const error = new Error('FFmpeg conversion timed out');
          error.code = 'FFMPEG_TIMEOUT';
          error.statusCode = 504;
          return reject(error);
        }
        if (code === 0) return resolve();
        const error = new Error(`FFmpeg failed with code ${code ?? 'null'} signal ${signal || 'none'}`);
        error.code = 'FFMPEG_FAILED';
        error.ffmpegOutput = stderr;
        log('error', 'ffmpeg_failed', { request_id: requestId, code, signal, output: stderr });
        reject(error);
      });
    });
    try {
      await childDone;
      return await fs.stat(outputPath);
    } catch (cause) {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      throw cause;
    } finally {
      clearTimeout(timer);
    }
}

async function validateOutput(outputPath, expectedDurationSeconds, profile, requestId) {
  const [probe, stat] = await Promise.all([
    probeOutput(outputPath, requestId),
    fs.stat(outputPath),
  ]);
  const durationSeconds = Number(probe?.format?.duration);
  const video = Array.isArray(probe?.streams)
    ? probe.streams.find((stream) => stream.codec_type === 'video')
    : null;
  const videoBitrateKbps = Math.floor(Number(video?.bit_rate || 0) / 1000);
  const allowedShortfall = Math.max(
    OUTPUT_DURATION_TOLERANCE_SECONDS,
    expectedDurationSeconds * 0.02,
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds < expectedDurationSeconds - allowedShortfall) {
    const error = new Error(
      `Converted trailer is incomplete: expected ${expectedDurationSeconds.toFixed(3)}s, got ${Number.isFinite(durationSeconds) ? durationSeconds.toFixed(3) : 'unknown'}s`,
    );
    error.code = 'OUTPUT_DURATION_MISMATCH';
    error.statusCode = 502;
    throw error;
  }
  if (stat.size <= 0 || stat.size > profile.maxOutputBytes) {
    const error = new Error(`Output size is outside the configured limit: ${stat.size} bytes`);
    error.code = 'OUTPUT_SIZE_INVALID';
    error.statusCode = 413;
    throw error;
  }
  if (!video || video.codec_name !== 'h264' || Number(video.width) !== profile.width || Number(video.height) !== profile.height) {
    const error = new Error('Converted trailer video stream does not match the required H.264 1280x720 profile');
    error.code = 'OUTPUT_VIDEO_PROFILE_INVALID';
    error.statusCode = 502;
    throw error;
  }
  const minimumVideoBitrateKbps = profile.name === 'web'
    ? MIN_WEB_OUTPUT_VIDEO_BITRATE_KBPS
    : Math.min(250, profile.videoKbps);
  if (!Number.isFinite(videoBitrateKbps) || videoBitrateKbps < minimumVideoBitrateKbps) {
    const error = new Error(`Converted trailer bitrate is too low: ${videoBitrateKbps || 0} kbps`);
    error.code = 'OUTPUT_BITRATE_TOO_LOW';
    error.statusCode = 502;
    throw error;
  }
  return { durationSeconds, sizeBytes: stat.size, videoBitrateKbps };
}

async function handleConvert(req, res) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let tempDir;
  if (!tokenMatches(req.headers.authorization)) {
    return sendJson(res, 401, { error: 'unauthorized', request_id: requestId });
  }
  if (activeConversion) {
    return sendJson(res, 429, { error: 'converter_busy', retry_after_seconds: 15, request_id: requestId });
  }
  activeConversion = true;
  try {
    const body = await readJson(req);
    const profileName = body.profile === 'web' ? 'web' : 'telegram';
    const inputUrl = validateSteamHls(body.hls_url);
    const coverUrl = validateSteamCover(body.cover_url);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdz-ffmpeg-'));
    const coverPath = path.join(tempDir, 'poster.jpg');
    const outputPath = path.join(tempDir, `steam-trailer-${profileName}.mp4`);
    const coverBytes = await downloadSteamCover(coverUrl, coverPath);
    const durationSeconds = await probeDuration(inputUrl, requestId);
    const profile = buildEncodingProfile(durationSeconds, profileName);
    log('info', 'conversion_started', {
      request_id: requestId,
      host: new URL(inputUrl).hostname,
      cover_host: new URL(coverUrl).hostname,
      cover_bytes: coverBytes,
      poster_seconds: POSTER_SECONDS,
      duration_seconds: Number(durationSeconds.toFixed(3)),
      profile: profile.name,
      target_output_mb: Number((profile.targetOutputBytes / MIB).toFixed(2)),
      video_bitrate_kbps: profile.videoKbps,
      encoding_preset: profile.preset,
      output_width: profile.width,
      output_height: profile.height,
      output_mode: 'validated_file',
    });
    const outputStat = await runFfmpegFile(inputUrl, coverPath, outputPath, requestId, profile);
    if (!outputStat.size) throw new Error('FFmpeg produced an empty output file');
    const validated = await validateOutput(outputPath, durationSeconds, profile, requestId);
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-disposition': `attachment; filename="steam-trailer-${profile.name}.mp4"`,
      'content-length': String(validated.sizeBytes),
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-request-id': requestId,
      'x-poster-seconds': String(POSTER_SECONDS),
      'x-video-bitrate-kbps': String(profile.videoKbps),
      'x-output-width': String(profile.width),
      'x-output-height': String(profile.height),
      'x-conversion-profile': profile.name,
      'x-output-duration-seconds': validated.durationSeconds.toFixed(3),
      'x-input-duration-seconds': durationSeconds.toFixed(3),
      'x-output-video-bitrate-kbps': String(validated.videoBitrateKbps),
      'x-output-mode': 'validated-file',
    });
    res.socket?.setKeepAlive(true, 30000);
    res.flushHeaders();
    await pipeline(createReadStream(outputPath), res);
    log('info', 'conversion_finished', {
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      output_bytes: validated.sizeBytes,
      output_duration_seconds: Number(validated.durationSeconds.toFixed(3)),
      output_video_bitrate_kbps: validated.videoBitrateKbps,
      video_bitrate_kbps: profile.videoKbps,
      output_width: profile.width,
      output_height: profile.height,
    });
  } catch (error) {
    const clientDisconnected = error.code === 'ERR_STREAM_PREMATURE_CLOSE';
    log(clientDisconnected ? 'warn' : 'error', clientDisconnected ? 'conversion_cancelled' : 'conversion_error', {
      request_id: requestId,
      message: error.message,
      code: error.code || null,
    });
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, {
        error: error.code || 'conversion_failed',
        message: error.message,
        request_id: requestId,
      });
    } else if (!res.writableEnded) {
      res.destroy(error);
    }
  } finally {
    activeConversion = false;
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok', service: 'gdz-steam-ffmpeg-converter', version: '1.2.1', profiles: ['telegram', 'web'], output_mode: 'validated_file' });
  }
  if (req.method === 'POST' && req.url === '/convert') {
    return handleConvert(req, res);
  }
  return sendJson(res, 404, { error: 'not_found' });
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30 * 1000;
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    if (!API_TOKEN) log('error', 'configuration_error', { message: 'CONVERTER_API_TOKEN is not set' });
    log('info', 'service_started', { port: PORT });
  });
}

module.exports = { buildEncodingProfile, probeDuration, probeOutput, runFfmpegFile, validateOutput, server };
