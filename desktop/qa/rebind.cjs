const { _electron: electron } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHotkeys, normalize } = require('../hotkeys.cjs');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = { checks: [], errors: [] };
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };

function unit() {
  assert.equal(normalize('Ctrl+Shift+Alt+K'), 'Control+Alt+Shift+K');
  assert.equal(normalize('F7'), 'F7');
  assert.equal(normalize(''), '');
  for (const bad of ['K', 'Shift+K', 'Control+C', 'Alt+F4', 'Control+Alt+2', 'Control+Escape', 'Hyper+K', 'Control+Control+K', 'x'.repeat(65)]) assert.throws(() => normalize(bad), bad);
  pass('Validation rejects bare keys, system combos, AltGr symbols and malformed input');

  const registered = new Map(); let suspended = false; const taken = new Set(['Control+Alt+J']);
  const shortcuts = {
    register: (key, callback) => { if (suspended || taken.has(key) || registered.has(key)) return false; registered.set(key, callback); return true; },
    unregister: key => registered.delete(key), setSuspended: flag => { suspended = flag; }, isSuspended: () => suspended,
  };
  let config = { hotkeys: { record: 'Control+Alt+R', pause: 'bogus' } };
  const storage = { getConfig: () => config, saveConfig: patch => { config = { ...config, ...patch }; } };
  const fired = []; const warnings = [];
  const hotkeys = createHotkeys({ globalShortcut: shortcuts, storage, trigger: action => fired.push(action), warn: text => warnings.push(text) });
  hotkeys.start();
  assert.deepEqual([...registered.keys()].sort(), ['Control+Alt+R', 'F10', 'F11']);
  assert.equal(warnings.length, 1);
  registered.get('Control+Alt+R')();
  assert.deepEqual(fired, ['record']);
  hotkeys.suspend(true);
  const blocked = hotkeys.set('record', 'Control+Alt+J');
  assert.equal(blocked.ok, false); assert.equal(suspended, false);
  assert.equal(blocked.state.bindings.record, 'Control+Alt+R'); assert.ok(registered.has('Control+Alt+R'));
  assert.equal(config.hotkeys.record, 'Control+Alt+R');
  assert.throws(() => hotkeys.set('pause', 'Control+Alt+R'), /ya está asignado/);
  assert.equal(hotkeys.set('pause', '').ok, true); assert.equal(registered.has('F10'), false); assert.equal(config.hotkeys.pause, '');
  const failing = { ...storage, saveConfig: () => { throw new Error('disco lleno'); } };
  const fragile = createHotkeys({ globalShortcut: shortcuts, storage: failing, trigger: () => {} });
  registered.clear(); fragile.start();
  assert.throws(() => fragile.set('screenshot', 'Control+Alt+P'), /disco lleno/);
  assert.ok(registered.has('F11')); assert.equal(registered.has('Control+Alt+P'), false);
  pass('Registry keeps the previous shortcut when the new one is taken or cannot be saved');
}

function occupy() {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Occupy { [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk); }'; if ([Occupy]::RegisterHotKey([IntPtr]::Zero, 7, 7, 0x4A)) { 'held' } else { 'failed' }; Start-Sleep 120`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', data => String(data).includes('held') ? resolve(child) : reject(new Error(`No se pudo ocupar el atajo: ${data}`)));
    child.on('error', reject);
  });
}

function chord(keys) {
  const down = keys.map(code => `[K]::keybd_event(${code},0,0,[UIntPtr]::Zero)`).join(';');
  const up = [...keys].reverse().map(code => `[K]::keybd_event(${code},0,2,[UIntPtr]::Zero)`).join(';');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'; ${down}; ${up}`], { windowsHide: true });
}

async function electronFlow() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-rebind-'));
  const profile = path.join(temporary, 'profile'), videos = path.join(temporary, 'videos');
  fs.mkdirSync(profile); fs.mkdirSync(videos);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ outputDir: videos, countdown: 0, systemAudio: false }));
  const env = { ...process.env, RECORDER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  let occupier;
  const launch = () => electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    const main = fn => app.evaluate(fn);
    await page.locator('[data-page="general"]').click();
    const row = action => page.locator(`[data-action="${action}"]`);

    await row('record').locator('[data-change]').click();
    await page.waitForFunction(() => document.querySelector('.hotkey-row.capturing'));
    assert.equal(await main(({ globalShortcut }) => globalShortcut.isSuspended()), true);
    await page.keyboard.press('F10');
    await row('record').locator('.hotkey-error').waitFor();
    assert.match(await row('record').locator('.hotkey-error').textContent(), /Pausar/);
    await page.keyboard.press('Control+C');
    await page.waitForFunction(() => /sistema/.test(document.querySelector('[data-action="record"] .hotkey-error')?.textContent));
    assert.equal(await row('record').evaluate(element => element.classList.contains('capturing')), true);
    pass('Capture mode suspends global shortcuts and keeps listening after a rejected combination');

    await page.keyboard.press('Control+Alt+Shift+K');
    await page.waitForFunction(async () => (await window.recorder.getConfig()).hotkeys?.record === 'Control+Alt+Shift+K');
    assert.deepEqual(await main(({ globalShortcut }) => [globalShortcut.isRegistered('Control+Alt+Shift+K'), globalShortcut.isSuspended()]), [true, false]);
    assert.equal((await page.evaluate(() => window.recorder.getHotkeys())).active.record, true);
    assert.equal(await page.locator('.key-badge').textContent(), 'Ctrl+Alt+Mayús+K');
    assert.match(await page.locator('#record').getAttribute('title'), /Ctrl\+Alt\+Mayús\+K$/);
    pass('New shortcut is registered globally, persisted and shown everywhere');

    occupier = await occupy();
    await row('record').locator('[data-change]').click();
    await page.keyboard.press('Control+Alt+Shift+J');
    await page.waitForFunction(() => /Windows u otra aplicación/.test(document.querySelector('[data-action="record"] .hotkey-error')?.textContent));
    assert.deepEqual(await main(({ globalShortcut }) => [globalShortcut.isRegistered('Control+Alt+Shift+K'), globalShortcut.isRegistered('Control+Alt+Shift+J')]), [true, false]);
    assert.equal((await page.evaluate(() => window.recorder.getConfig())).hotkeys.record, 'Control+Alt+Shift+K');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.hotkey-row.capturing'));
    assert.equal(await main(({ globalShortcut }) => globalShortcut.isSuspended()), false);
    pass('A combination held by another process is refused and the previous one stays active');

    await row('pause').locator('[data-change]').click();
    await page.keyboard.press('Control+Alt+Shift+L');
    await page.waitForFunction(async () => (await window.recorder.getConfig()).hotkeys?.pause === 'Control+Alt+Shift+L');
    await page.evaluate(() => { window.__shortcuts = []; window.recorder.onShortcut(action => window.__shortcuts.push(action)); });
    await page.locator('#minimize').click();
    chord([0x11, 0x12, 0x10, 0x4C]);
    await page.waitForFunction(() => window.__shortcuts.includes('pause'), null, { polling: 100 });
    assert.deepEqual(await page.evaluate(() => window.__shortcuts), ['pause']);
    await main(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    pass('Real key presses reach the new shortcut while minimized');

    await row('screenshot').locator('[data-clear]').click();
    await page.waitForFunction(async () => (await window.recorder.getConfig()).hotkeys?.screenshot === '');
    assert.equal((await page.evaluate(() => window.recorder.getHotkeys())).active.screenshot, false);
    assert.equal(await page.locator('#take-screenshot kbd').isHidden(), true);
    await page.evaluate(() => window.recorder.saveConfig({ fps: 60, hotkeys: { record: 'F1' } }));
    assert.equal((await page.evaluate(() => window.recorder.getConfig())).hotkeys.record, 'Control+Alt+Shift+K');
    pass('A shortcut can be disabled and general settings cannot overwrite shortcuts');

    await main(({ app }) => app.exit());
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    assert.deepEqual(await app.evaluate(({ globalShortcut }) => [globalShortcut.isRegistered('Control+Alt+Shift+K'), globalShortcut.isRegistered('Control+Alt+Shift+L')]), [true, true]);
    assert.equal((await page.evaluate(() => window.recorder.getConfig())).hotkeys.screenshot, '');
    await page.locator('[data-page="general"]').click();
    await page.locator('#hotkeys-reset').click();
    await page.waitForFunction(async () => (await window.recorder.getConfig()).hotkeys?.record === 'F9');
    const restored = await page.evaluate(() => window.recorder.getHotkeys());
    assert.deepEqual(restored.bindings, restored.defaults);
    assert.deepEqual(await app.evaluate(({ globalShortcut }) => ['F9', 'F10', 'F11', 'Control+Alt+Shift+K', 'Control+Alt+Shift+L'].map(key => globalShortcut.isRegistered(key))), [...['record', 'pause', 'screenshot'].map(action => restored.active[action]), false, false]);
    report.defaultsFree = restored.active;
    await page.locator('#hotkeys-card').screenshot({ path: path.join(artifacts, 'hotkeys-card.png') });
    pass('Custom shortcuts survive a restart and reset restores the originals');
    assert.deepEqual(report.errors, []);
  } finally {
    occupier?.kill();
    await app.evaluate(({ app }) => app.exit()).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

(async () => {
  try { unit(); await electronFlow(); report.status = 'passed'; }
  catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
  finally { fs.writeFileSync(path.join(artifacts, 'rebind-report.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
