const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { call } = require('../agents/client.cjs');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-multi-qa-'));
const output = path.join(temp, 'output');
fs.mkdirSync(output);
fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ outputDir: output, agentEnabled: true }));
process.env.RECORDER_CONNECTION = path.join(temp, 'agent-connection.json');
process.env.RECORDER_CLIENT = 'multi-qa';
const report = { checks: [] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitJob(id) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const item = await call('jobs.status', { jobId: id });
    if (['completed', 'failed', 'cancelled'].includes(item.status)) return item;
    await delay(150);
  }
  throw new Error('Multiview job timed out');
}
(async () => {
  let order = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const role = /role=(cliente|admin)/.exec(req.headers.cookie || '')?.[1] || 'sin-sesion';
    if (req.url === '/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ role, order })); return; }
    if (req.url === '/order') {
      if (req.method !== 'POST' || role !== 'cliente') { res.writeHead(403); res.end(); return; }
      order++; res.end('ok'); return;
    }
    const pageRole = req.url === '/admin' ? 'admin' : 'cliente';
    res.setHeader('Set-Cookie', `role=${pageRole}; Path=/; HttpOnly; SameSite=Lax`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="es"><head><title>Recorder · ${pageRole}</title></head><body style="margin:0;background:${pageRole === 'admin' ? '#1c233b' : '#172d2d'};color:white;font:22px Segoe UI;padding:40px"><h1>${pageRole === 'admin' ? 'Administración' : 'Portal del cliente'}</h1><p>Sesión: <strong data-testid="identity">cargando</strong></p><button style="padding:16px;border:0;border-radius:8px;font-size:18px;background:#7eacf4" onclick="fetch('/order',{method:'POST'})">Crear pedido</button><p role="status">Pedidos: 0</p><script>async function refresh(){const s=await(await fetch('/state')).json();document.querySelector('[data-testid=identity]').textContent=s.role;document.querySelector('[role=status]').textContent='Pedidos: '+s.order}setInterval(refresh,150);refresh();</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, RECORDER_USER_DATA: temp }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-multi-qa-'));
    const recipe = { views: [
      { id: 'cliente', label: 'CLIENTE', url: base + '/cliente', setup: [{ action: 'expectText', target: { testId: 'identity' }, text: 'cliente' }] },
      { id: 'admin', label: 'ADMINISTRACIÓN', url: base + '/admin', setup: [{ action: 'expectText', target: { testId: 'identity' }, text: 'admin' }] },
    ], width: 640, height: 480, steps: [
      { action: 'expectText', view: 'cliente', target: { testId: 'identity' }, text: 'cliente' },
      { action: 'expectText', view: 'admin', target: { testId: 'identity' }, text: 'admin' },
      { action: 'hold', view: 'cliente', milliseconds: 600 },
      { action: 'parallel', steps: [
        { action: 'expectText', view: 'admin', target: { role: 'status' }, text: 'Pedidos: 1' },
        { action: 'click', view: 'cliente', target: { role: 'button', name: 'Crear pedido' } },
      ] },
      { action: 'frame', view: 'admin', target: { role: 'status' }, label: 'Pedido recibido' },
      { action: 'hold', view: 'admin', milliseconds: 1600 },
    ] };
    await assert.rejects(() => call('demo.multiview', { ...recipe, views: [recipe.views[0], recipe.views[0]] }));
    await assert.rejects(() => call('demo.multiview', { ...recipe, steps: [{ action: 'hold', view: 'missing', milliseconds: 1 }] }));
    pass('Duplicate session ids and unknown targets rejected');
    const task = await call('demo.multiview', recipe);
    const item = await waitJob(task.jobId);
    if (item.status !== 'completed') throw new Error(item.error);
    const result = item.result;
    assert.equal(order, 1); assert.equal(result.views.length, 2);
    assert.equal(result.marks[0].view, 'admin');
    assert(result.views.every(view => fs.existsSync(view.artifact.path) && view.offsetSeconds >= 0));
    const info = JSON.parse((await exec(path.join(root, 'bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.artifact.path], { windowsHide: true })).stdout);
    assert.equal(info.streams[0].width, 1280); assert.equal(info.streams[0].height, 520);
    assert(Math.abs(Number(info.format.duration) - result.synchronization.durationSeconds) < .15);
    const preview = path.join(__dirname, 'artifacts', 'multiview.png');
    await exec(path.join(root, 'bin/ffmpeg.exe'), ['-y', '-ss', '1.5', '-i', result.artifact.path, '-frames:v', '1', preview], { windowsHide: true });
    fs.copyFileSync(result.artifact.path, path.join(root, '..', 'docs', 'qa', 'demo-multipantalla.mp4'));
    report.duration = Number(info.format.duration); report.offsets = result.views.map(view => view.offsetSeconds);
    pass('Two isolated cookies/sessions; customer POST visible to admin; parallel actions');
    pass('Shared-timeline split-screen MP4, labels, originals and semantic frame marker');
    const vertical = await call('demo.multiview', { ...recipe, layout: 'vertical', steps: [{ action: 'hold', view: 'cliente', milliseconds: 1000 }] });
    const second = await waitJob(vertical.jobId);
    if (second.status !== 'completed') throw new Error(second.error);
    const verticalInfo = JSON.parse((await exec(path.join(root, 'bin/ffprobe.exe'), ['-v', 'error', '-show_streams', '-of', 'json', second.result.artifact.path], { windowsHide: true })).stdout);
    assert.equal(verticalInfo.streams[0].width, 640); assert.equal(verticalInfo.streams[0].height, 1040);
    pass('Vertical layout exported and verified');
    const cancelled = await call('demo.multiview', { ...recipe, steps: [{ action: 'hold', view: 'cliente', milliseconds: 10000 }] });
    await delay(2500); await call('jobs.cancel', { jobId: cancelled.jobId });
    assert.equal((await waitJob(cancelled.jobId)).status, 'cancelled');
    pass('Multi-session cancellation closes both contexts');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
  finally {
    server.close(); await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {});
    fs.writeFileSync(path.join(__dirname, 'artifacts', 'multiview-report.json'), JSON.stringify(report, null, 2));
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-multi-qa-')) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
