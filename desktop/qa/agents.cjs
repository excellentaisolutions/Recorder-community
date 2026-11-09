const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { _electron: electron } = require('playwright');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { call } = require('../agents/client.cjs');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-agents-'));
const profile = path.join(temp, 'profile'), output = path.join(temp, 'output');
fs.mkdirSync(profile); fs.mkdirSync(output);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ outputDir: output, countdown: 0, systemAudio: false }));
process.env.RECORDER_CONNECTION = path.join(profile, 'agent-connection.json');
process.env.RECORDER_CLIENT = 'qa-agent';
const report = { checks: [], errors: [] };
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(150); }
  throw new Error('Timed out');
}
async function job(id) {
  return until(async () => {
    const value = await call('jobs.status', { jobId: id });
    if (value.status === 'failed') throw new Error(value.error);
    return value.status === 'completed' && value.result;
  });
}
async function probe(file) {
  const result = await exec(path.join(root, 'bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true });
  return JSON.parse(result.stdout);
}
(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const executable = process.env.RECORDER_EXE || require('electron');
  const app = await electron.launch({ executablePath: executable, args: process.env.RECORDER_EXE ? [] : [root], env });
  let client, server;
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-agents-'));
    await assert.rejects(() => call('sources.list'), /desactivadas/);
    await page.locator('[data-page="integrations"]').click();
    await page.locator('#agent-enabled').check();
    await until(() => JSON.parse(fs.readFileSync(process.env.RECORDER_CONNECTION)).enabled);
    const connection = JSON.parse(fs.readFileSync(process.env.RECORDER_CONNECTION));
    const address = `http://127.0.0.1:${connection.port}/call`;
    assert.equal((await fetch(address, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(address, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, Origin: 'https://example.org' }, body: '{}' })).status, 403);
    await assert.rejects(() => call('recording.start', { autoStop: -1 }));
    pass('Disabled by default; missing auth, browser origins and invalid input rejected');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 620));
    await page.screenshot({ path: path.join(__dirname, 'artifacts', 'integrations.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const cliArgs = [...(process.env.RECORDER_EXE ? [] : [root]), '--cli', 'sources.list'];
    const cli = await exec(executable, cliArgs, { env, windowsHide: true, timeout: 30000 });
    const sources = JSON.parse(cli.stdout.trim()).result;
    const source = sources.find(s => s.kind === 'screen'); assert(source);
    pass('Packaged-compatible CLI returns JSON sources');
    client = new Client({ name: 'recorder-qa', version: '1' });
    const mcp = (await page.evaluate(() => window.recorder.integrationStatus())).mcp.mcpServers.recorder;
    const transport = new StdioClientTransport({ ...mcp, env: { ...env, ...mcp.env, RECORDER_CLIENT: 'qa-agent' }, stderr: 'pipe' });
    transport.stderr?.on('data', data => process.stderr.write(data));
    await client.connect(transport);
    const listed = await client.listTools();
    assert(listed.tools.some(t => t.name === 'recording_start'));
    for (const name of ['capabilities_get', 'devices_list', 'settings_get', 'settings_update', 'schedule_create']) assert(listed.tools.some(t => t.name === name));
    const capabilities = await client.callTool({ name: 'capabilities_get', arguments: {} });
    assert(JSON.parse(capabilities.content[0].text).monitors.length > 0);
    const preview = await client.callTool({ name: 'source_preview', arguments: { sourceId: source.id } });
    assert.equal(preview.content[0].type, 'image');
    pass('Real MCP stdio handshake, tool discovery and image preview');
    const requestId = crypto.randomUUID();
    const startOptions = { sourceId: source.id, format: 'webm', autoStop: 2 };
    const started = await call('recording.start', startOptions, { requestId });
    assert.equal(started.state, 'recording');
    assert.equal((await call('recording.start', startOptions, { requestId })).id, started.id);
    await assert.rejects(() => call('recording.start', { ...startOptions, autoStop: 5 }, { requestId }));
    await assert.rejects(() => call('recording.start', startOptions));
    await assert.rejects(() => call('recording.pause', { sessionId: started.id }, { client: 'other-agent' }));
    await call('recording.pause', { sessionId: started.id });
    const before = await call('recording.status'); await delay(350);
    assert.equal((await call('recording.status')).elapsed, before.elapsed);
    await call('recording.mark', { sessionId: started.id, label: 'Demo' });
    const screenshot = await call('screenshot.capture', { sessionId: started.id }); assert(fs.existsSync(screenshot.path));
    await call('recording.resume', { sessionId: started.id });
    const completed = await until(async () => { const s = await call('recording.status'); return s.state === 'idle' && s.artifact && s; });
    assert((await probe(completed.artifact.path)).streams.some(s => s.codec_type === 'video'));
    pass('Real desktop capture: idempotency, session ownership, pause timing, marks, screenshot and engine auto-stop');
    const region = await call('recording.start', { sourceId: source.id, mode: 'region', region: { x: .25, y: .25, width: .5, height: .5 }, format: 'mp4' });
    await delay(600);
    const stopping = await call('recording.stop', { sessionId: region.id });
    const stopped = await job(stopping.jobId);
    const info = await probe(stopped.artifact.path);
    assert.equal(info.streams.find(s => s.codec_type === 'video').width, Math.floor(source.width / 4) * 2);
    pass('Region capture and asynchronous MP4 export job');
    server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(`<!doctype html><html lang="es"><head><title>Demo Recorder</title></head><body style="background:#171b21;color:white;font:24px Segoe UI;padding:60px"><h1>Clientes</h1><label>Nombre <input aria-label="Nombre"></label><button onclick="document.querySelector('#result').textContent='Cliente creado: '+document.querySelector('input').value">Crear cliente</button><p id="result" role="status">Sin clientes</p></body></html>`); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const demo = await call('demo.run', { url: `http://127.0.0.1:${server.address().port}`, width: 960, height: 540, steps: [
      { action: 'fill', target: { role: 'textbox', name: 'Nombre' }, value: 'Cliente de demostración' },
      { action: 'hold', milliseconds: 500 },
      { action: 'click', target: { role: 'button', name: 'Crear cliente' } },
      { action: 'expectText', target: { role: 'status' }, text: 'Cliente creado' },
      { action: 'mark', label: 'Resultado' }, { action: 'frame', target: { role: 'status' }, label: 'Encuadre del resultado' },
      { action: 'screenshot', target: { role: 'status' } }, { action: 'hold', milliseconds: 1000 },
    ] });
    const demoResult = await job(demo.jobId);
    assert.equal(demoResult.steps.length, 8); assert.equal(demoResult.marks.length, 2);
    assert(demoResult.marks[1].region.width > 0 && demoResult.marks[1].region.width <= 1);
    const demoProbe = await probe(demoResult.artifact.path);
    assert.equal(demoProbe.streams.find(s => s.codec_type === 'video').width, 960);
    pass('Playwright declarative web demo produces actual MP4, screenshot and markers');
    const voices = await call('voices.list'); assert(voices.length > 0);
    const spoken = await call('narration.create', { text: 'Hola. Demo de Recorder.', rate: 1 });
    const narration = await job(spoken.jobId);
    assert((await probe(narration.artifact.path)).streams.some(s => s.codec_type === 'audio'));
    pass('Installed Windows voices and real local WAV narration');
    const montage = await call('media.compose', { clips: [
      { file: demoResult.artifact.path, duration: 1, title: 'Presentación' },
      { file: demoResult.artifact.path, start: .5, duration: 1, region: { x: 0, y: 0, width: .8, height: .8 }, title: 'Resultado' },
    ], width: 960, height: 540, branding: true, narration: narration.artifact.path, subtitles: [{ start: 0, end: 1.8, text: 'Demo automática · Recorder' }] });
    const montageResult = await job(montage.jobId);
    const expectedDuration = Math.min(1, Number(demoProbe.format.duration)) + Math.min(1, Number(demoProbe.format.duration) - .5);
    const montageProbe = await probe(montageResult.artifact.path);
    assert(Math.abs(Number(montageProbe.format.duration) - expectedDuration) < .2);
    assert(montageProbe.streams.some(s => s.codec_type === 'audio'));
    await exec(path.join(root, 'bin/ffmpeg.exe'), ['-y', '-i', montageResult.artifact.path, '-frames:v', '1', path.join(__dirname, 'artifacts', 'montage.png')], { windowsHide: true });
    pass('FFmpeg montage: multiple clips, crop, titles, branding and burned subtitles');
    const failed = await call('demo.run', { url: `http://127.0.0.1:${server.address().port}`, steps: [{ action: 'click', target: { testId: 'does-not-exist' } }] });
    const failure = await until(async () => { const item = await call('jobs.status', { jobId: failed.jobId }); return item.status === 'failed' && item; });
    assert(failure.error.includes('Paso 1'));
    assert(failure.error.includes('Grabación parcial conservada'));
    const cancelled = await call('demo.run', { url: `http://127.0.0.1:${server.address().port}`, steps: [{ action: 'hold', milliseconds: 10000 }] });
    await delay(1500);
    await assert.rejects(() => call('jobs.cancel', { jobId: cancelled.jobId }, { client: 'other-agent' }));
    await call('jobs.cancel', { jobId: cancelled.jobId });
    await until(async () => (await call('jobs.status', { jobId: cancelled.jobId })).status === 'cancelled');
    pass('Failed demo preserves recording; retry and cancellation finish cleanly');
    const last = await call('recording.start', { sourceId: source.id, format: 'webm' });
    assert.equal(last.state, 'recording');
    await delay(500);
    await page.locator('#agent-revoke').click();
    await until(() => !JSON.parse(fs.readFileSync(process.env.RECORDER_CONNECTION)).enabled);
    assert.equal((await fetch(address, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, body: '{}' })).status, 403);
    await page.waitForFunction(async () => !(await window.recorder.getStatus()).recording && document.querySelector('#record-state').textContent.includes('Listo'));
    pass('Revocation rejects prior credentials');
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
  finally {
    await client?.close().catch(() => {});
    server?.close();
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {});
    fs.writeFileSync(path.join(__dirname, 'artifacts', 'agents-report.json'), JSON.stringify(report, null, 2));
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('recorder-agents-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
