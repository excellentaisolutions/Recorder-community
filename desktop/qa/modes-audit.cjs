const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { call } = require('../agents/client.cjs');
const { parse } = require('../agents/schema.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-modes-'));
const output = path.join(temp, 'output'); fs.mkdirSync(output);
fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ outputDir: output, countdown: 0, agentEnabled: true, systemAudio: false }));
process.env.RECORDER_CONNECTION = path.join(temp, 'agent-connection.json'); process.env.RECORDER_CLIENT = 'modes-audit';
const report = { checks: [], media: [], errors: [], limits: ['Camera and microphone use Chromium synthetic devices; desktop/windows are real.', 'One physical monitor; mixed physical DPI, HDR and long recordings not established.'] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(120); } throw new Error('Timed out'); }
async function probe(file) { return JSON.parse((await exec(path.join(root, 'bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true })).stdout); }
(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: temp }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: ['--use-fake-device-for-media-stream', ...(process.env.RECORDER_EXE ? [] : [root])], env });
  try {
    const page = await app.firstWindow(); page.on('pageerror', e => report.errors.push(e.message));
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    await app.evaluate(async ({ BrowserWindow }) => {
      globalThis.auditWindows = [];
      for (const [i, color] of ['#004fdd', '#ee6600', '#22aa55'].entries()) {
        const w = new BrowserWindow({ width: 420, height: 340, x: 50 + i * 450, y: 100, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } });
        globalThis.auditWindows.push(w);
        await w.loadURL(`data:text/html;charset=utf-8,<title>Audit source ${i + 1}</title><body style="background:${encodeURIComponent(color)};color:white"><h1>Panel ${i + 1}</h1></body>`);
      }
    });
    const sources = await call('sources.list'), screen = sources.find(s => s.kind === 'screen');
    const windows = [1, 2, 3].map(i => sources.find(s => s.name === `Audit source ${i}`)); assert(windows.every(Boolean));
    const devices = await call('devices.list'); const camera = devices.find(d => d.kind === 'videoinput'), mic = devices.find(d => d.kind === 'audioinput'); assert(camera && mic);
    await call('settings.update', { countdown: 2 });
    assert.equal(await page.locator('[data-setting="countdown"]').inputValue(), '2');
    assert.equal(parse('recording.start', { mode: 'audio', microphone: true }).format, 'mp3');
    assert.throws(() => parse('recording.start', { mode: 'audio', format: 'mp4' }));
    assert.throws(() => parse('recording.start', { mode: 'screen', format: 'mp3' }));
    await assert.rejects(() => call('recording.start', { mode: 'window', sourceId: screen.id }));
    pass('Every countdown value reflects in UI; invalid source/mode and format combinations are rejected before recording');
    const defaults = { fps: 30, videoFormat: 'mp4', audioFormat: 'mp3', codec: 'h264', quality: 'balanced', countdown: 0, autoStop: 0,
      systemAudio: false, microphone: false, webcamOverlay: false, textOverlay: '', cameraId: camera.id, microphoneId: mic.id, screenshotFormat: 'png' };
    const scenes = { layout: 'grid', width: 1280, height: 720, items: windows.map(w => ({ sourceId: w.id, label: w.name })) };
    const cases = [
      { mode: 'screen', sourceId: screen.id, webcamOverlay: true, textOverlay: 'Auditoría de pantalla', microphone: true },
      { mode: 'window', sourceId: windows[0].id, fps: 24, videoFormat: 'mkv' },
      { mode: 'region', sourceId: screen.id, region: { x: .25, y: .25, width: .5, height: .5 }, fps: 60, screenshotFormat: 'jpeg' },
      { mode: 'device', videoFormat: 'avi', microphone: true },
      { mode: 'audio', audioFormat: 'mp3', microphone: true },
      { mode: 'audio', audioFormat: 'wav', microphone: true },
      { mode: 'audio', audioFormat: 'webm', microphone: true },
      { mode: 'scene', scene: scenes, sourceId: windows[0].id, videoFormat: 'webm' },
    ];
    for (const item of cases) {
      await call('settings.update', { ...defaults, ...item });
      assert.equal(await page.locator(`[data-mode="${item.mode}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-setting="fps"]').inputValue(), String(item.fps || 30));
      assert((await page.locator('#footer-format').textContent()).includes((item.mode === 'audio' ? item.audioFormat : item.videoFormat || 'mp4').toUpperCase()));
      if (item.mode === 'scene') {
        for (const w of windows) assert((await page.locator('#selection-details').textContent()).includes(w.name));
        assert((await page.locator('#source-label').textContent()).includes('3 fuentes'));
      }
      await page.locator('#record').click();
      await until(async () => (await call('recording.status')).state === 'recording');
      const session = await call('recording.status');
      const unlocked = await page.locator('[data-setting], [data-duration], .mode-card').evaluateAll(nodes => nodes.filter(n => !n.disabled).map(n => n.dataset.setting || n.dataset.mode || n.dataset.duration));
      assert.deepEqual(unlocked, []);
      await page.locator('[data-page="video"]').click(); assert.equal(await page.locator('[data-setting="codec"]').isDisabled(), true);
      await page.locator('[data-page="home"]').click();
      await delay(600); await page.locator('#pause').click();
      const paused = await call('recording.status'); assert.equal(paused.state, 'paused'); await delay(250);
      assert.equal((await call('recording.status')).elapsed, paused.elapsed);
      assert.equal(await page.locator('#pause-icon').getAttribute('href'), '#i-play');
      if (item.mode !== 'audio') {
        const imagesBefore = (await call('artifacts.list')).filter(f => f.kind === 'image').length;
        await page.locator('#snapshot').click();
        await until(async () => (await call('artifacts.list')).filter(f => f.kind === 'image').length > imagesBefore);
      } else assert.equal(await page.locator('#snapshot').isDisabled(), true);
      await page.locator('#pause').click(); await delay(400); await page.locator('#record').click();
      const finished = await until(async () => { const s = await call('recording.status'); if (s.state === 'error') throw new Error(s.error); return s.state === 'idle' && s.artifact && s; });
      const media = await probe(finished.artifact.path), video = media.streams.find(s => s.codec_type === 'video');
      assert.equal(finished.artifact.kind, item.mode === 'audio' ? 'audio' : 'video');
      assert.equal((await call('artifacts.list')).find(file => file.path === finished.artifact.path).kind, item.mode === 'audio' ? 'audio' : 'video');
      if (item.mode === 'audio') { assert(!video); assert(media.streams.some(s => s.codec_type === 'audio')); }
      else { assert(video); assert(video.width > 0 && video.height > 0); }
      if (item.mode === 'region') { assert.equal(video.width, Math.floor(screen.width / 4) * 2); assert.equal(video.height, Math.floor(screen.height / 4) * 2); }
      if (item.mode === 'scene') { assert.equal(video.width, 1280); assert.equal(video.height, 720); }
      assert(fs.statSync(finished.artifact.path).size > 500);
      assert.equal(await page.locator('#pause').isDisabled(), true);
      assert.equal(await page.locator('#record').getAttribute('aria-label'), 'Iniciar grabación');
      report.media.push({ mode: item.mode, format: path.extname(finished.artifact.path), duration: Number(media.format.duration), width: video?.width, height: video?.height, streams: media.streams.map(s => s.codec_type), session: session.id });
      pass(`${item.mode}/${path.extname(finished.artifact.path)}: visible configuration, UI record/pause/resume/stop, locks, screenshot availability, library and decoded media`);
    }
    await call('settings.update', { ...defaults, mode: 'window', sourceId: windows[2].id });
    await page.locator('#record').click(); await until(async () => (await call('recording.status')).state === 'recording');
    await delay(500); await app.evaluate(() => globalThis.auditWindows[2].close());
    await until(async () => (await call('recording.status')).state === 'idle');
    await page.waitForFunction(() => document.querySelector('#selection-status').textContent.includes('Revisar'));
    pass('Closing a source finalizes recording and visible selection becomes unavailable');
    await call('settings.update', { ...defaults, mode: 'device', cameraId: 'missing-device' });
    await page.locator('#record').click(); await until(async () => (await call('recording.status')).state === 'error');
    assert.equal(await page.locator('#record').isEnabled(), true); assert.equal(await page.locator('#source-button').isEnabled(), true);
    await call('settings.update', { cameraId: camera.id, autoStop: 1 });
    await page.locator('#record').click(); await until(async () => (await call('recording.status')).state === 'idle');
    pass('Unavailable camera reports error, releases controls and permits successful retry');
    await call('settings.update', { ...defaults, mode: 'screen', sourceId: screen.id, countdown: 2 });
    await page.locator('#record').click(); await until(async () => (await call('recording.status')).state === 'starting');
    await page.locator('[data-page="integrations"]').click(); await page.locator('#agent-stop').click();
    await until(async () => (await call('recording.status')).state === 'idle');
    assert.equal(await page.locator('#record').isEnabled(), true);
    pass('Countdown can be cancelled from integration controls without leaving recording controls locked');
    const filesBefore = (await call('artifacts.list')).length;
    const voice = await call('narration.create', { text: 'Comprobación de la biblioteca.' });
    await until(async () => { const j = await call('jobs.status', { jobId: voice.jobId }); if (j.status === 'failed') throw new Error(j.error); return j.status === 'completed'; });
    await page.locator('[data-page="home"]').click();
    await page.waitForFunction(n => document.querySelectorAll('.file-row').length > n, filesBefore);
    await page.locator('#library-filter').selectOption('audio');
    assert(await page.locator('.file-row').count() > 0);
    assert((await page.locator('.file-icon use').evaluateAll(items => items.every(item => item.getAttribute('href') === '#i-volume'))));
    pass('Agent-generated artifacts appear automatically and library filtering matches actual media kind');
    await page.locator('#library-filter').selectOption('all');
    await call('settings.update', { ...defaults, mode: 'scene', scene: { ...scenes, items: scenes.items.slice(0, 2) }, sourceId: windows[0].id });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')).setSize(760, 620));
    await page.locator('main').evaluate(el => { el.scrollTop = 0; });
    await page.locator('#toast').evaluate(el => { el.hidden = true; });
    await page.screenshot({ path: path.join(__dirname, 'artifacts/audit-selection-summary.png') });
    const removed = (await call('artifacts.list')).find(file => file.kind === 'video');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    assert.equal(await page.evaluate(file => window.recorder.deleteFile(file), removed.path), false);
    assert(fs.existsSync(removed.path));
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    assert.equal(await page.evaluate(file => window.recorder.deleteFile(file), removed.path), true);
    assert(!fs.existsSync(removed.path)); assert(!fs.existsSync(`${removed.path}.session.json`));
    pass('Library deletion: cancellation preserves media; confirmation trashes media and its metadata');
    const beforeClose = new Set(fs.readdirSync(output)), appProcess = app.process();
    await page.locator('#record').click(); await until(async () => (await call('recording.status')).state === 'recording');
    await delay(700);
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.locator('#close').click(); assert.equal((await call('recording.status')).state, 'recording');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).isVisible()), false);
    await app.evaluate(({ app, BrowserWindow }) => { app.emit('before-quit', { preventDefault() {} }); BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).close(); }); await delay(300); assert.equal((await call('recording.status')).state, 'recording');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    await app.evaluate(({ app, BrowserWindow }) => { app.emit('before-quit', { preventDefault() {} }); BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).close(); });
    await until(() => appProcess.exitCode !== null);
    const savedOnClose = fs.readdirSync(output).find(file => !beforeClose.has(file) && file.endsWith('.mp4'));
    assert(savedOnClose); assert((await probe(path.join(output, savedOnClose))).streams.some(s => s.codec_type === 'video'));
    pass('Close during recording: × hides to tray; Salir asks, cancel keeps recording; save-and-close exports valid media before exit');
    assert.deepEqual(report.errors, []); report.status = 'passed';
  } catch (e) { report.status = 'failed'; report.error = e.stack; throw e; }
  finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {});
    fs.writeFileSync(path.join(__dirname, 'artifacts/modes-audit-report.json'), JSON.stringify(report, null, 2));
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-modes-')) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
