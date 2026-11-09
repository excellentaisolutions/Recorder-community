const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { call } = require('../agents/client.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-selection-'));
const output = path.join(temp, 'output'); fs.mkdirSync(output);
process.env.RECORDER_CONNECTION = path.join(temp, 'agent-connection.json');
fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ outputDir: output, systemAudio: false, countdown: 0, agentEnabled: false }));
const report = { checks: [], failures: [], errors: [] };
const artifacts = path.join(__dirname, 'artifacts');
async function check(name, fn) { try { await fn(); report.checks.push(name); console.log('PASS ' + name); } catch (e) { report.failures.push({ name, error: e.message }); console.log('FAIL ' + name + ': ' + e.message); } }
(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: temp }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  try {
    const page = await app.firstWindow(); page.on('pageerror', e => report.errors.push(e.message));
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-selection-'));
    await page.locator('[data-page="integrations"]').click(); await page.locator('#agent-enabled').check();
    await page.waitForFunction(async () => (await window.recorder.integrationStatus()).enabled);
    await page.locator('[data-page="fps"]').click(); await page.locator('[data-setting="fps"]').selectOption('60');
    await page.waitForFunction(async () => (await window.recorder.getConfig()).fps === 60);
    await check('Changing capture preferences preserves agent activation', async () => assert.equal(await page.evaluate(async () => (await window.recorder.getConfig()).agentEnabled), true));
    const sources = await page.evaluate(() => window.recorder.listSources()); const screen = sources.find(s => s.kind === 'screen');
    const reset = async overrides => {
      await page.evaluate(async opts => window.recorder.saveConfig(opts), { mode: 'screen', sourceId: screen.id, region: null, scene: null, systemAudio: false, microphone: false, webcamOverlay: false, countdown: 0, autoStop: 0, fps: 30, agentEnabled: true, ...overrides });
      await page.reload(); await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-selection-'));
      await page.waitForFunction(() => document.body.dataset.ready === 'true');
    };
    await reset({});
    await page.locator('#source-button').click(); await page.locator('.source-tile').first().waitFor();
    await check('Current source is visibly selected when reopening selector', async () => assert.equal(await page.locator('.source-tile[aria-pressed="true"]').count(), 1));
    await page.locator('#sources-dialog .dialog-close').first().click();
    await page.locator('[data-mode="window"]').click(); await page.locator('#sources-dialog').waitFor(); await page.locator('#sources-dialog .dialog-close').first().click();
    await check('Cancel mode selection retains the previous applied mode', async () => assert.equal(await page.locator('[data-mode="screen"]').getAttribute('aria-pressed'), 'true'));
    await reset({ mode: 'region', region: { x: .1, y: .1, width: .5, height: .5 } });
    const before = await page.locator('#selected-source').textContent();
    await page.locator('#source-button').click(); await page.locator('.source-tile').first().click(); await page.locator('#region-dialog').waitFor();
    await page.locator('#region-dialog .dialog-close').click();
    await check('Cancel region editing retains applied dimensions and runtime crop', async () => {
      assert.equal(await page.locator('#selected-source').textContent(), before);
      assert.deepEqual((await call('settings.get')).region, { x: .1, y: .1, width: .5, height: .5 });
    });
    await reset({});
    await page.locator('#source-button').click(); await page.locator('.source-tile').first().waitFor();
    await page.locator('#combine-sources').check(); await page.locator('.source-tile').first().click();
    await page.locator('#scene-layout').selectOption('vertical'); await page.locator('#refresh-sources').click();
    await page.locator('.source-tile').first().waitFor();
    await check('Refresh preserves pending multiselect mode, selection and layout', async () => {
      assert.equal(await page.locator('#combine-sources').isChecked(), true);
      assert.equal(await page.locator('#scene-layout').inputValue(), 'vertical');
      assert.equal(await page.locator('.source-tile[aria-pressed="true"]').count(), 1);
    });
    await page.locator('#sources-dialog .dialog-close').first().click();
    await reset({});
    await page.locator('#source-button').click(); await page.locator('.source-tile').first().waitFor();
    await page.locator('#source-search').fill('NONEXISTENT-QA'); await page.locator('#sources-dialog .dialog-close').first().click();
    await page.locator('#source-button').click();
    await check('A fresh selection dialog resets a stale search', async () => { await page.waitForTimeout(300); assert.equal(await page.locator('#source-search').inputValue(), ''); });
    await page.locator('#sources-dialog .dialog-close').first().click();
    await app.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ width: 400, height: 300, title: 'Selection audit fixture' });
      await fixture.loadURL('data:text/html,<title>Selection audit fixture</title><body style="background:teal">Source</body>');
    });
    const fixtureSource = (await page.evaluate(() => window.recorder.listSources())).find(s => s.name.includes('Selection audit fixture'));
    assert(fixtureSource);
    const customScene = { layout: 'grid', width: 1280, height: 720, items: [
      { sourceId: screen.id, label: 'Screen', region: { x: .1, y: .1, width: .5, height: .5 } },
      { sourceId: fixtureSource.id, label: 'Window' }
    ] };
    await reset({ mode: 'scene', scene: customScene });
    await page.locator('#source-button').click(); await page.locator('.source-tile').first().waitFor();
    await page.locator('#confirm-scene').click();
    await check('Confirming an existing composition preserves output dimensions and source crops', async () => {
      const actual = (await call('settings.get')).scene;
      assert.equal(actual.width, 1280); assert.equal(actual.height, 720);
      assert.deepEqual(actual.items[0].region, customScene.items[0].region);
    });
    await reset({ cameraId: 'unplugged-camera', microphoneId: 'unplugged-mic' });
    await check('Unavailable devices are shown explicitly instead of a false default', async () => {
      const text = await page.locator('.camera-select').evaluate(el => el.selectedOptions[0]?.textContent || '');
      assert.match(text, /no disponible/i);
    });
    await reset({ mode: 'audio', microphone: true });
    await check('Audio-only mode disables image capture controls', async () => assert.equal(await page.locator('#snapshot').isDisabled(), true));
    await check('No uncaught renderer errors', async () => assert.deepEqual(report.errors, []));
    report.status = report.failures.length ? 'failed' : 'passed';
    if (report.failures.length) process.exitCode = 1;
  } finally {
    await app.evaluate(({ app }) => app.exit()).catch(() => {}); await app.close().catch(() => {});
    fs.writeFileSync(path.join(artifacts, process.env.AUDIT_BASELINE ? 'selection-baseline.json' : 'selection-report.json'), JSON.stringify(report, null, 2));
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-selection-')) fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
