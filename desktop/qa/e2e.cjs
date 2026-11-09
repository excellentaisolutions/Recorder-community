const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-e2e-'));
const output = path.join(workspace, 'videos');
fs.mkdirSync(output);
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = { started: new Date().toISOString(), checks: [], output, errors: [] };
const executablePath = process.env.RECORDER_EXE || require('electron');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function probe(file) {
  return JSON.parse(execFileSync(path.join(root, 'bin/ffprobe.exe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
}
function checked(name, details) { report.checks.push({ name, details }); console.log(`PASS ${name}`); }

(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: path.join(workspace, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath, args: process.env.RECORDER_EXE ? [] : [root], env, timeout: 60000 });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => !!window.recorder);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(artifacts, 'home.png') });
    checked('Desktop starts', { title: await page.title() });
    const security = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: prefs.sandbox, isolation: prefs.contextIsolation, node: prefs.nodeIntegration };
    });
    assert.deepEqual(security, { sandbox: true, isolation: true, node: false });
    checked('Isolated renderer', security);
    await page.evaluate(dir => window.recorder.saveConfig({ outputDir: dir, countdown: 0 }), output);
    const sources = await page.evaluate(() => window.recorder.listSources());
    const source = sources.find(item => item.kind === 'screen');
    assert.ok(source, 'Windows screen must be available');
    checked('Windows capture sources', { count: sources.length, display: { width: source.width, height: source.height } });
    const denied = await page.evaluate(async () => {
      try { await window.recorder.openFile('C:\\Windows\\System32\\cmd.exe'); return false; } catch { return true; }
    });
    assert.equal(denied, true);
    checked('IPC rejects external executable paths');
    await page.evaluate(async () => {
      const { RecordingEngine } = await import('./recording.js');
      window.qaEngine = new RecordingEngine(window.recorder);
    });
    const options = { mode: 'screen', sourceId: source.id, fps: 30, systemAudio: false, microphone: false, format: 'mp4', codec: 'h264', quality: 'balanced', countdown: 0 };
    await page.evaluate(opts => window.qaEngine.start(opts), options);
    await sleep(2200);
    await page.evaluate(() => window.qaEngine.pause());
    const paused = await page.evaluate(() => window.qaEngine.elapsed);
    await sleep(1100);
    const stillPaused = await page.evaluate(() => window.qaEngine.elapsed);
    assert.ok(Math.abs(stillPaused - paused) < 0.1);
    const screenshot = await page.evaluate(() => window.qaEngine.screenshot({ screenshotFormat: 'png' }));
    assert.ok(fs.statSync(screenshot.path).size > 1000);
    await page.evaluate(() => window.qaEngine.resume());
    await sleep(2000);
    const movie = await page.evaluate(() => window.qaEngine.stop());
    const media = probe(movie.path);
    assert.ok(Number(media.format.duration) >= 3.5 && Number(media.format.duration) < 7.5);
    assert.equal(media.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    checked('Real screen MP4 with pause/resume and screenshot', { duration: media.format.duration, bytes: movie.size });
    await page.evaluate(opts => window.qaEngine.start(opts), { ...options, mode: 'region', region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, format: 'webm', textOverlay: 'Recorder · prueba de captura' });
    await sleep(2200);
    const region = await page.evaluate(() => window.qaEngine.stop());
    const crop = probe(region.path).streams.find(s => s.codec_type === 'video');
    const full = media.streams.find(s => s.codec_type === 'video');
    assert.ok(Math.abs(crop.width - full.width / 2) <= 2);
    assert.ok(Math.abs(crop.height - full.height / 2) <= 2);
    checked('Region and text composition', { width: crop.width, height: crop.height });
    await app.evaluate(async ({ BrowserWindow }) => {
      const target = new BrowserWindow({ width: 480, height: 320, title: 'Recorder QA target', webPreferences: { sandbox: true } });
      await target.loadURL('data:text/html,<title>Recorder QA target</title><body style="margin:0;background:%23194365;color:white;font:32px sans-serif">Captura de ventana verificada</body>');
    });
    const windowSources = await page.evaluate(() => window.recorder.listSources());
    const target = windowSources.find(item => item.kind === 'window' && item.name === 'Recorder QA target');
    assert.ok(target, 'QA target window must appear');
    await page.evaluate(opts => window.qaEngine.start(opts), { ...options, mode: 'window', sourceId: target.id, format: 'webm' });
    await sleep(1800);
    const windowMovie = await page.evaluate(() => window.qaEngine.stop());
    const windowMedia = probe(windowMovie.path);
    assert.ok(Number(windowMedia.format.size) > 1000);
    checked('Actual Windows application-window capture', { width: windowMedia.streams[0].width, height: windowMedia.streams[0].height });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Recorder QA target')?.destroy());
    await page.evaluate(() => {
      window.qaTone = new AudioContext();
      const oscillator = window.qaTone.createOscillator();
      const gain = window.qaTone.createGain();
      gain.gain.value = 0.08; oscillator.frequency.value = 440;
      oscillator.connect(gain).connect(window.qaTone.destination); oscillator.start();
    });
    await page.evaluate(opts => window.qaEngine.start(opts), { ...options, mode: 'audio', format: 'wav', systemAudio: true });
    await sleep(2300);
    const audio = await page.evaluate(() => window.qaEngine.stop());
    await page.evaluate(() => window.qaTone.close());
    const sound = probe(audio.path);
    assert.equal(sound.streams[0].codec_type, 'audio');
    assert.ok(Number(sound.format.duration) >= 1.5);
    const volume = spawnSync(path.join(root, 'bin/ffmpeg.exe'), ['-hide_banner', '-i', audio.path, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8', windowsHide: true });
    assert.equal(volume.status, 0);
    const meanVolume = Number(/mean_volume: ([-.\d]+) dB/.exec(volume.stderr)?.[1]);
    assert.ok(Number.isFinite(meanVolume) && meanVolume > -80, 'Loopback recording must contain an audible test signal');
    checked('Windows loopback audio to WAV', { duration: sound.format.duration, channels: sound.streams[0].channels, meanVolumeDb: meanVolume });
    const files = await page.evaluate(() => window.recorder.listFiles());
    assert.ok(files.length >= 4);
    checked('Real output library', { files: files.length });
    const persisted = JSON.parse(fs.readFileSync(path.join(workspace, 'profile', 'settings.json'), 'utf8'));
    assert.equal(persisted.outputDir, output);
    checked('Settings persist to disk');
    assert.deepEqual(report.errors, []);
    checked('No renderer exceptions');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack; throw error;
  } finally {
    await app.close();
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(artifacts, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.log(`Report: ${path.join(artifacts, 'e2e-report.json')}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
