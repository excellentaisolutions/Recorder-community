const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStorage } = require('../storage.cjs');
const { finishFile, exportArgs } = require('../exporter.cjs');
const { parseArgs } = require('../contracts.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-backend-'));
  const app = { getPath: key => path.join(directory, key), getAppPath: () => path.resolve(__dirname, '..') };
  const ffmpeg = path.resolve(__dirname, '../bin/ffmpeg.exe');
  const ffprobe = path.resolve(__dirname, '../bin/ffprobe.exe');
  const input = path.join(directory, 'input.webm');
  const audio = path.join(directory, 'audio.webm');
  const records = [];
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '0.6', '-c:v', 'libvpx', '-c:a', 'libopus', input], { windowsHide: true });
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-c:a', 'copy', audio], { windowsHide: true });
    const storage = createStorage(app);
    storage.saveConfig({ fps: 30, region: { x: 0, y: 0, width: 0.5, height: 0.5 } });
    assert.equal(createStorage(app).getConfig().fps, 30);
    assert.throws(() => storage.authorizedFile(input));
    assert.throws(() => storage.saveConfig({ outputDir: 'relative' }));
    assert.throws(() => parseArgs('startFile', [{ extension: 'exe', kind: 'video' }]));
    assert.throws(() => parseArgs('finishFile', ['not-a-uuid', {}]));
    assert.throws(() => exportArgs(input, 'x', { format: 'mp4', fps: 999 }, 'video'));
    const concurrent = await Promise.allSettled([storage.startFile({ extension: 'webm', kind: 'video' }), storage.startFile({ extension: 'webm', kind: 'video' })]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1);
    assert.equal(storage.listFiles().length, 0, 'Incomplete capture must not appear as a finished library artifact');
    await storage.abortFile(concurrent.find(result => result.status === 'fulfilled').value.id);
    for (const [format, codec, kind] of [['mp4', 'h264', 'video'], ['mkv', 'hevc', 'video'], ['mp4', 'av1', 'video'], ['avi', 'h264', 'video'], ['webm', 'h264', 'video'], ['mp3', 'h264', 'audio'], ['wav', 'h264', 'audio']]) {
      const data = fs.readFileSync(kind === 'audio' ? audio : input);
      const { id } = await storage.startFile({ extension: 'webm', kind });
      for (let offset = 0; offset < data.length; offset += 4096) await storage.appendChunk(id, data.subarray(offset, offset + 4096));
      const file = await finishFile(app, storage, id, { format, codec, quality: 'balanced', fps: 30 });
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file.path], { windowsHide: true, encoding: 'utf8' }));
      assert(probe.streams.some(stream => stream.codec_type === 'audio'));
      assert(probe.format.duration > 0.3);
      if (kind === 'video') assert(probe.streams.some(stream => stream.codec_type === 'video' && stream.width === 160 && stream.height === 90));
      assert.equal(storage.sessions.size, 0);
      records.push({ format, codec, bytes: file.size, duration: Number(probe.format.duration) });
    }
    const damaged = await storage.startFile({ extension: 'webm', kind: 'video' });
    await storage.appendChunk(damaged.id, Buffer.from('invalid-media'));
    const preserved = storage.sessions.get(damaged.id).file;
    await assert.rejects(() => finishFile(app, storage, damaged.id, { format: 'mp4', fps: 30 }), /Original conservado/);
    assert(fs.existsSync(preserved));
    assert.equal(storage.sessions.size, 0);
    const empty = await storage.startFile({ extension: 'webm', kind: 'video' });
    const abort = await storage.abortFile(empty.id);
    assert.equal(abort.preserved, null);
    const stat = fs.statSync;
    fs.statSync = function(file, ...args) {
      if (file === preserved) throw Object.assign(new Error('Removed concurrently'), { code: 'ENOENT' });
      return stat.call(fs, file, ...args);
    };
    try { assert.equal(storage.listFiles().length, 7); } finally { fs.statSync = stat; }
    const settings = path.join(app.getPath('userData'), 'settings.json');
    fs.writeFileSync(settings, '{broken');
    const repaired = createStorage(app);
    assert(repaired.getWarnings().length);
    assert.equal(fs.readFileSync(settings, 'utf8'), '{broken');
    assert(fs.readdirSync(path.dirname(settings)).some(name => name.endsWith('.bak')));
    fs.writeFileSync(settings, JSON.stringify({ outputDir: input }));
    const fallback = createStorage(app);
    assert(fallback.getWarnings().some(warning => warning.startsWith('Carpeta alternativa:')));
    assert.notEqual(fallback.getConfig().outputDir, input);
    console.log(JSON.stringify({ status: 'passed', exports: records, concurrentStartGuard: true, libraryDeletionRace: true, corruptConfigPreserved: true, outputFallback: true, corruptInputPreserved: true, pathValidation: true, configRoundTrip: true }, null, 2));
  } finally {
    const absolute = path.resolve(directory);
    assert(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('recorder-backend-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
