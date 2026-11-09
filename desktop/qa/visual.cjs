const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-visual-'));
const output = path.join(temp, 'output'); fs.mkdirSync(output);
fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ outputDir: output, countdown: 0, systemAudio: false, autoStop: 0 }));
for (const name of ['Vídeo de ejemplo.mp4', 'Captura de ejemplo.png', 'Audio de ejemplo.wav']) fs.writeFileSync(path.join(output, name), 'Visual fixture only');
const artifacts = path.join(__dirname, 'artifacts', 'visual'); fs.mkdirSync(artifacts, { recursive: true });
const report = { checks: [], errors: [], screenshots: [] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: temp }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-visual-'));
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    await page.locator('#toast').evaluate(el => { el.hidden = true; });
    for (const [size, width, height] of [['normal', 1040, 760], ['compact', 760, 620]]) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
      for (const name of ['home', 'general', 'fps', 'video', 'image', 'audio', 'integrations', 'about']) {
        await page.locator(`[data-page="${name}"]`).click();
        await page.locator('main').evaluate(el => { el.scrollTop = 0; });
        const issues = await page.evaluate(() => {
          const main = document.querySelector('main');
          const visible = [...document.querySelectorAll('button,input,select')].filter(el => el.getClientRects().length);
          return {
            overflow: main.scrollWidth > main.clientWidth || document.documentElement.scrollWidth > innerWidth,
            badText: /[\u00c3\u00c2\u00e2\ufffd]/.test(document.body.innerText),
            clipped: visible.filter(el => { const r = el.getBoundingClientRect(); return r.x < -1 || r.right > innerWidth + 1; }).map(el => el.id || el.dataset.setting),
          };
        });
        assert.deepEqual(issues, { overflow: false, badText: false, clipped: [] }, `${size}/${name}`);
        const screenshot = `${size}-${name}.png`;
        await page.screenshot({ path: path.join(artifacts, screenshot) }); report.screenshots.push(screenshot);
        if (['general', 'integrations', 'about'].includes(name)) {
          await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight; });
          const bottom = `${size}-${name}-bottom.png`;
          await page.screenshot({ path: path.join(artifacts, bottom) }); report.screenshots.push(bottom);
        }
      }
    }
    pass('All eight sections at normal/minimum size: no mojibake, clipped controls or horizontal overflow');
    await page.locator('[data-page="home"]').click();
    assert.deepEqual(await page.locator('.file-icon use').evaluateAll(uses => uses.map(use => use.getAttribute('href')).sort()), ['#i-camera', '#i-video', '#i-volume']);
    pass('Video, image and audio library icons use SVG symbols');
    await page.locator('#source-button').click();
    await page.locator('.source-tile').first().waitFor();
    await page.screenshot({ path: path.join(artifacts, 'source-dialog.png') });
    await page.locator('.source-tile').first().click();
    await page.locator('#record').click();
    await page.waitForFunction(() => document.body.classList.contains('recording'));
    assert.equal(await page.locator('#pause-icon').getAttribute('href'), '#i-pause');
    assert.equal(await page.locator('#pause').getAttribute('aria-label'), 'Pausar');
    assert.equal((await page.locator('#pause').textContent()).trim(), '');
    await page.screenshot({ path: path.join(artifacts, 'recording.png') });
    await page.locator('#pause').click();
    await page.waitForFunction(() => document.body.classList.contains('paused'));
    assert.equal(await page.locator('#pause-icon').getAttribute('href'), '#i-play');
    assert.equal(await page.locator('#pause').getAttribute('aria-label'), 'Continuar grabación');
    await page.screenshot({ path: path.join(artifacts, 'paused.png') });
    await page.locator('#pause').click();
    await page.waitForFunction(() => document.body.classList.contains('recording'));
    assert.equal(await page.locator('#pause-icon').getAttribute('href'), '#i-pause');
    await page.screenshot({ path: path.join(artifacts, 'resumed.png') });
    await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#record-state').textContent.includes('Listo'), null, { timeout: 60000 });
    assert.equal(await page.locator('#pause').isDisabled(), true);
    pass('Real recording: SVG pause, resume, pause again, idle disabled and accessible labels');
    await page.locator('[data-mode="region"]').click(); await page.locator('.source-tile').first().click();
    await page.locator('#region-image').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'region-dialog.png') });
    await page.locator('#region-dialog .dialog-close').click();
    pass('Source selector and region dialog render in compact window');
    assert.deepEqual(report.errors, []); report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
  finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {});
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-visual-')) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
