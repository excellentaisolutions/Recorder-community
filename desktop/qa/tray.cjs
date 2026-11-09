const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = { checks: [], errors: [] };
const osVisible = hwnd => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class V { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'; [V]::IsWindowVisible([IntPtr]${hwnd})`], { windowsHide: true, encoding: 'utf8' }).trim() === 'True';
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-tray-'));
  const profile = path.join(temporary, 'profile'), videos = path.join(temporary, 'videos');
  fs.mkdirSync(profile); fs.mkdirSync(videos);
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ outputDir: videos, countdown: 0, systemAudio: false }));
  const env = { ...process.env, RECORDER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  const win = fn => app.evaluate(({ BrowserWindow }, body) => new Function('w', body)(BrowserWindow.getAllWindows()[0]), fn);
  const waitWin = async (body, label) => {
    for (let i = 0; i < 50; i++) { if (await win(body)) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`Timeout: ${label}`);
  };
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    await page.locator('[data-page="general"]').click();
    assert.equal(await page.locator('[data-setting="closeToTray"]').isChecked(), true);
    pass('Close-to-tray is on by default');

    await win('globalThis.hides = 0; w.on("hide", () => globalThis.hides++); return true');
    await page.locator('#close').click();
    await waitWin('return globalThis.hides === 1', 'window hidden');
    assert.equal(app.process().exitCode, null);
    const hwnd = await win('const b = w.getNativeWindowHandle(); return String(b.length === 8 ? b.readBigUInt64LE() : b.readUInt32LE())');
    assert.equal(osVisible(hwnd), false);
    const stored = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
    assert.equal(stored.trayHintShown, true);
    pass('Close hides the window in the tray, the app keeps running and the hint is shown once');

    await win('if (w.isMinimized()) w.restore(); w.show(); w.focus(); return true');
    await waitWin('return w.isVisible() && !w.isMinimized()', 'window restored');
    assert.equal(osVisible(hwnd), true);
    pass('The window comes back from the tray');

    await page.locator('#minimize').click();
    await waitWin('return w.isMinimized()', 'window minimized');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await win('return globalThis.hides'), 1);
    await win('w.restore(); return true');
    pass('Minimize still goes to the taskbar');

    await page.locator('[data-setting="closeToTray"]').click();
    await page.waitForFunction(async () => (await window.recorder.getConfig()).closeToTray === false);
    const proc = app.process();
    await page.locator('#close').click().catch(() => {});
    for (let i = 0; i < 100 && proc.exitCode === null; i++) await new Promise(r => setTimeout(r, 100));
    assert.notEqual(proc.exitCode, null);
    pass('With the option off, close quits the app');
    assert.deepEqual(report.errors, []);

    const second = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
    try {
      await (await second.firstWindow()).waitForFunction(() => document.body.dataset.ready === 'true');
      const late = await second.evaluate(({ BrowserWindow, ipcMain }) => {
        BrowserWindow.getAllWindows()[0].destroy();
        try { ipcMain.emit('recorder:agentState', { sender: {}, senderFrame: { url: '' } }, { state: 'idle' }); return 'ok'; }
        catch (error) { return error.message; }
      });
      assert.equal(late, 'ok');
    } finally { await second.close().catch(() => {}); }
    pass('An IPC message arriving after the window is destroyed does not crash the main process');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
  finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.writeFileSync(path.join(artifacts, 'tray-report.json'), JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
