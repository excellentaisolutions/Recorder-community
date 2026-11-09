const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-hotkeys-'));
const profile = path.join(temporary, 'profile'), outputDir = path.join(temporary, 'videos');
fs.mkdirSync(profile); fs.mkdirSync(outputDir);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ outputDir, countdown: 0, autoStop: 0, systemAudio: false }));
function key(code) {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RecorderKeys { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'; [RecorderKeys]::keybd_event(${code},0,0,[UIntPtr]::Zero); [RecorderKeys]::keybd_event(${code},0,2,[UIntPtr]::Zero)`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
}
(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  const report = { checks: [], outputDir };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-hotkeys-'));
    const status = await page.evaluate(() => window.recorder.getStatus());
    assert.ok(Object.values(status.hotkeys).every(Boolean), 'Native test requires free F9/F10/F11');
    await page.locator('#source-button').click();
    await page.locator('.source-tile').first().click();
    await page.locator('#minimize').click();
    key(0x78);
    await page.waitForFunction(() => document.body.classList.contains('recording'), null, { polling: 100 });
    report.checks.push('F9 starts recording while minimized');
    key(0x79);
    await page.waitForFunction(() => document.body.classList.contains('paused'), null, { polling: 100 });
    report.checks.push('F10 pauses while minimized');
    key(0x79);
    await page.waitForFunction(() => document.body.classList.contains('recording'), null, { polling: 100 });
    key(0x7a);
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 1, null, { polling: 100 });
    report.checks.push('F11 writes screenshot while minimized');
    key(0x78);
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 2 && !document.body.classList.contains('recording'), null, { timeout: 60000, polling: 100 });
    report.checks.push('F9 stops and finalizes while minimized');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
  finally {
    console.log(`Native checks: ${report.status}; closing test fixture`);
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(String.fromCharCode(10))[0].trim();
    const closer = "const {chromium}=require('playwright');(async()=>{const b=await chromium.connectOverCDP('http://127.0.0.1:'+process.argv[1]);const p=b.contexts()[0].pages()[0];await p.evaluate(()=>window.recorder.close()).catch(()=>{});await b.close().catch(()=>{})})().catch(e=>{console.error(e);process.exitCode=1})";
    execFileSync(process.execPath, ['-e', closer, port], { cwd: root, windowsHide: true, timeout: 15000 });
    await app.close();
    fs.writeFileSync(path.join(__dirname, 'artifacts/hotkeys-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
