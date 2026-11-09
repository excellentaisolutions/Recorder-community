const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { _electron: electron, chromium } = require('playwright');
const { call } = require('../agents/client.cjs');
const { displayInfo } = require('../agents/capabilities.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-compatibility-'));
const output = path.join(temp, 'output'); fs.mkdirSync(output);
fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ outputDir: output, countdown: 0, systemAudio: false, agentEnabled: true }));
process.env.RECORDER_CONNECTION = path.join(temp, 'agent-connection.json'); process.env.RECORDER_CLIENT = 'qa-compatibility';
const report = { checks: [], errors: [], limitations: ['Mixed-DPI display metadata tested synthetically; physical monitors reported separately.', 'No claim of support for every application, DRM content, physical camera or capture card.'] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const deadline = Date.now() + 60000; while (Date.now() < deadline) { const v = await fn(); if (v) return v; await delay(150); } throw new Error('Timed out'); }
async function job(id) { return until(async () => { const j = await call('jobs.status', { jobId: id }); if (j.status === 'failed') throw new Error(j.error); return j.status === 'completed' && j.result; }); }
(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: temp }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  let browser;
  try {
    const page = await app.firstWindow(); page.on('pageerror', e => report.errors.push(e.message));
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-compatibility-'));
    const caps = await call('capabilities.get');
    assert(caps.monitors.length >= 1); assert(caps.demoBrowsers.some(b => b.channel === 'msedge' && b.installed));
    report.physicalMonitors = caps.monitors.map(({ name, ...m }) => m);
    const devices = await call('devices.list'); assert(Array.isArray(devices)); report.deviceKinds = devices.map(d => d.kind);
    const mixed = displayInfo({ id: 2, bounds: { x: -1280, y: -100, width: 1280, height: 720 }, workArea: {}, scaleFactor: 1.5, rotation: 90 }, 1);
    assert.equal(mixed.width, 1920); assert.equal(mixed.bounds.x, -1280); assert.equal(mixed.primary, false);
    pass('Capabilities: actual monitor inventory, installed browser and media devices; negative coordinates/mixed DPI metadata');
    await call('settings.update', { autoStop: 3661 });
    await call('settings.update', { fps: 60 });
    assert.equal((await call('settings.get')).autoStop, 3661);
    assert.equal(await page.locator('[data-duration="hours"]').inputValue(), '1');
    assert.equal(await page.locator('[data-setting="fps"]').inputValue(), '60');
    await assert.rejects(() => call('settings.update', { agentEnabled: false }));
    await call('settings.update', { fps: 30, autoStop: 0 });
    pass('AI preferences update the same UI, HMS controls and persisted settings; restricted fields rejected');
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ width: 520, height: 420, x: 20, y: 20, title: 'Recorder QA App', webPreferences: { backgroundThrottling: false } });
      await w.loadURL('data:text/html;charset=utf-8,<title>Recorder QA App</title><body style="margin:0;background:rgb(0,80,220);color:white"><h1>Aplicación de escritorio</h1></body>');
    });
    browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--window-position=580,20'] });
    const web = await browser.newPage({ viewport: { width: 520, height: 420 } });
    await web.goto('data:text/html;charset=utf-8,<title>Recorder QA Browser</title><body style="margin:0;background:rgb(230,80,0);color:white"><h1>Navegador independiente</h1></body>');
    const sources = await until(async () => { const list = await call('sources.list'); return list.some(s => s.name.includes('Recorder QA Browser')) && list.some(s => s.name.includes('Recorder QA App')) && list; });
    const a = sources.find(s => s.name.includes('Recorder QA App')), b = sources.find(s => s.name.includes('Recorder QA Browser'));
    const screen = sources.find(s => s.kind === 'screen');
    assert.equal(a.width, null); assert(screen.displayId); assert.equal(sources.filter(s => s.kind === 'screen').length, caps.monitors.length);
    pass('Real application and Edge browser windows detected independently alongside all connected monitors');
    const scene = { width: 1280, height: 720, layout: 'horizontal', items: [{ sourceId: a.id, label: 'APLICACIÓN' }, { sourceId: b.id, label: 'NAVEGADOR' }] };
    for (const layout of ['horizontal', 'vertical', 'grid']) {
      const image = await call('screenshot.capture', { mode: 'scene', scene: { ...scene, layout } });
      const pixels = await app.evaluate(({ nativeImage }, file) => {
        const img = nativeImage.createFromPath(file), data = img.toBitmap(); let blue = 0, orange = 0;
        for (let i = 0; i < data.length; i += 4) { if (data[i] > 150 && data[i + 2] < 40) blue++; if (data[i + 2] > 180 && data[i] < 40) orange++; }
        return { size: img.getSize(), blue, orange };
      }, image.path);
      assert.deepEqual(pixels.size, { width: 1280, height: 720 }); assert(pixels.blue > 10000 && pixels.orange > 10000, JSON.stringify(pixels));
      fs.copyFileSync(image.path, path.join(__dirname, 'artifacts', `scene-${layout}.png`));
    }
    pass('Real mult-source screenshots in three layouts contain both distinct sources, with proportion preserved');
    await assert.rejects(() => call('recording.start', { mode: 'scene', scene: { ...scene, items: [scene.items[0], scene.items[0]] } }));
    const started = await call('recording.start', { mode: 'scene', scene, format: 'mp4' });
    assert.deepEqual(started.dimensions, { width: 1280, height: 720 });
    await assert.rejects(() => call('settings.update', { fps: 60 }));
    await delay(1200); await call('recording.pause', { sessionId: started.id }); await call('recording.resume', { sessionId: started.id });
    const done = await job((await call('recording.stop', { sessionId: started.id })).jobId);
    const { stdout } = await exec(path.join(root, 'bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-of', 'json', done.artifact.path], { windowsHide: true });
    const video = JSON.parse(stdout).streams.find(s => s.codec_type === 'video'); assert.equal(video.width, 1280); assert.equal(video.height, 720);
    pass('Combined MP4 recording, pause/resume, export dimensions; duplicate sources and preference mutation during capture rejected');
    const scheduled = await call('schedule.create', { at: new Date(Date.now() + 1500).toISOString(), capture: { sourceId: screen.id, autoStop: 1, format: 'webm' } });
    const session = await job(scheduled.jobId); assert.equal(session.owner, 'qa-compatibility');
    await until(async () => (await call('recording.status')).state === 'idle');
    const cancelled = await call('schedule.create', { at: new Date(Date.now() + 60000).toISOString(), capture: { sourceId: screen.id } });
    await call('jobs.cancel', { jobId: cancelled.jobId }); await until(async () => (await call('jobs.status', { jobId: cancelled.jobId })).status === 'cancelled');
    pass('Scheduled capture retains agent ownership, auto-stops and supports cancellation');
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')); w.setSize(760, 620); w.focus(); });
    await page.locator('#source-button').click(); await page.locator('.source-tile').first().waitFor();
    await page.locator('#combine-sources').check(); await page.locator('#source-search').fill('Recorder QA');
    assert.equal(await page.locator('.source-tile').count(), 2);
    for (const tile of await page.locator('.source-tile').all()) if (await tile.getAttribute('aria-pressed') !== 'true') await tile.click();
    await page.screenshot({ path: path.join(__dirname, 'artifacts', 'scene-picker.png') });
    await page.locator('#confirm-scene').click();
    assert((await page.locator('#selected-source').textContent()).includes('2 fuentes'));
    await until(() => JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'))).mode === 'scene');
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'))).scene.items.length, 2);
    pass('Compact source selector: search, multiselect, apply and persist scene');
    assert.deepEqual(report.errors, []); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
  finally {
    await browser?.close(); await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {});
    fs.writeFileSync(path.join(__dirname, 'artifacts', 'compatibility-report.json'), JSON.stringify(report, null, 2));
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-compatibility-')) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
