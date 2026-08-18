'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildEncodingProfile, validateOutput } = require('./server');

async function main() {
  const web = buildEncodingProfile(134.289, 'web');
  assert.equal(web.name, 'web');
  assert.equal(web.preset, 'fast');
  assert.equal(web.videoKbps, 2030);
  assert.equal(Math.round(web.targetOutputBytes / 1024 / 1024), 36);
  assert.equal(Math.round(web.maxOutputBytes / 1024 / 1024), 42);

  const telegram = buildEncodingProfile(134.289, 'telegram');
  assert.equal(telegram.name, 'telegram');
  assert.equal(telegram.preset, 'fast');
  assert.equal(Math.round(telegram.targetOutputBytes / 1024 / 1024), 44);
  assert.equal(Math.round(telegram.maxOutputBytes / 1024 / 1024), 48);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdz-v121-test-'));
  const outputPath = path.join(tempDir, 'valid.mp4');
  try {
    const encoded = spawnSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x720:rate=30:duration=3',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', '1400k',
      '-maxrate', '1600k',
      '-bufsize', '2800k',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.stderr);

    const validation = await validateOutput(outputPath, 3, web, 'local-test');
    assert.ok(validation.durationSeconds >= 2.9);
    assert.ok(validation.sizeBytes > 0);
    assert.ok(validation.videoBitrateKbps >= 900);

    await assert.rejects(
      () => validateOutput(outputPath, 10, web, 'local-truncated-test'),
      (error) => error.code === 'OUTPUT_DURATION_MISMATCH',
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    status: 'passed',
    web_video_kbps: web.videoKbps,
    telegram_video_kbps: telegram.videoKbps,
    validation_cases: ['valid_full_file', 'truncated_file_rejected'],
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
