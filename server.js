'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createReadStream, promises: fs } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = String(process.env.CONVERTER_API_TOKEN || '');
const MAX_BODY_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_MB || 48) * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_SECONDS || 240) * 1000;
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

function runFfmpeg(inputUrl, outputPath, requestId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', inputUrl,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', 'scale=854:-2:force_original_aspect_ratio=decrease',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '2048',
      '-y', outputPath,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error('FFmpeg conversion timed out');
      error.code = 'FFMPEG_TIMEOUT';
      reject(error);
    }, FFMPEG_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const error = new Error(`FFmpeg failed with code ${code ?? 'null'} signal ${signal || 'none'}`);
      error.code = 'FFMPEG_FAILED';
      error.ffmpegOutput = stderr;
      log('error', 'ffmpeg_failed', { request_id: requestId, code, signal, output: stderr });
      reject(error);
    });
  });
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
    const inputUrl = validateSteamHls(body.hls_url);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdz-ffmpeg-'));
    const outputPath = path.join(tempDir, 'trailer.mp4');
    log('info', 'conversion_started', { request_id: requestId, host: new URL(inputUrl).hostname });
    await runFfmpeg(inputUrl, outputPath, requestId);
    const stat = await fs.stat(outputPath);
    if (!stat.size) throw new Error('FFmpeg produced an empty output file');
    if (stat.size > MAX_OUTPUT_BYTES) {
      const error = new Error(`Output exceeds ${Math.floor(MAX_OUTPUT_BYTES / 1024 / 1024)} MB limit`);
      error.statusCode = 413;
      throw error;
    }
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': stat.size,
      'content-disposition': 'attachment; filename="steam-trailer.mp4"',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      'x-conversion-ms': String(Date.now() - startedAt),
    });
    await pipeline(createReadStream(outputPath), res);
    log('info', 'conversion_finished', {
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      output_bytes: stat.size,
    });
  } catch (error) {
    log('error', 'conversion_error', {
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
    return sendJson(res, 200, { status: 'ok', service: 'gdz-steam-ffmpeg-converter' });
  }
  if (req.method === 'POST' && req.url === '/convert') {
    return handleConvert(req, res);
  }
  return sendJson(res, 404, { error: 'not_found' });
});

server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 30 * 1000;
server.listen(PORT, '0.0.0.0', () => {
  if (!API_TOKEN) log('error', 'configuration_error', { message: 'CONVERTER_API_TOKEN is not set' });
  log('info', 'service_started', { port: PORT });
});

