const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-ui-'));
const profile = path.join(temporary, 'profile');
const videos = path.join(temporary, 'videos');
fs.mkdirSync(profile); fs.mkdirSync(videos);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ outputDir: videos, countdown: 0, autoStop: 2, systemAudio: false }));
const artifacts = path.join(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const report = { checks: [], errors: [] };
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`); };

(async () => {
  const env = { ...process.env, RECORDER_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.env.RECORDER_EXE || require('electron'), args: process.env.RECORDER_EXE ? [] : [root], env });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#output-folder').textContent.includes('recorder-ui-'));
    for (const name of ['general', 'fps', 'video', 'image', 'audio', 'integrations', 'about', 'home']) {
      await page.locator(`[data-page="${name}"]`).click();
      assert.equal(await page.locator(`#page-${name}`).isVisible(), true);
      const overflows = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflows, false, `${name} must fit horizontally`);
    }
    pass('All eight sections navigate without horizontal overflow');
    await page.locator('[data-page="general"]').click();
    for (const [unit, value] of [['hours', '1'], ['minutes', '2'], ['seconds', '3']]) {
      await page.locator(`[data-duration="${unit}"]`).fill(value);
      await page.locator(`[data-duration="${unit}"]`).press('Tab');
    }
    await page.waitForFunction(async () => (await window.recorder.getConfig()).autoStop === 3723);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-duration="hours"]').value === '1');
    await page.locator('[data-page="general"]').click();
    assert.equal(await page.locator('[data-duration="minutes"]').inputValue(), '2');
    assert.equal(await page.locator('[data-duration="seconds"]').inputValue(), '3');
    for (const value of ['60', '-1', '1.5']) {
      await page.locator('[data-duration="minutes"]').fill(value);
      await page.locator('[data-duration="minutes"]').press('Tab');
      assert.equal(await page.locator('[data-duration="minutes"]').inputValue(), '2');
    }
    await page.locator('[data-duration="hours"]').fill('24');
    await page.locator('[data-duration="hours"]').press('Tab');
    assert.equal(await page.locator('[data-duration="hours"]').inputValue(), '1');
    for (const [unit, value] of [['hours', '0'], ['minutes', '0'], ['seconds', '0']]) {
      await page.locator(`[data-duration="${unit}"]`).fill(value);
      await page.locator(`[data-duration="${unit}"]`).press('Tab');
    }
    await page.waitForFunction(async () => (await window.recorder.getConfig()).autoStop === 0);
    await page.locator('[data-duration="hours"]').fill('24');
    await page.locator('[data-duration="hours"]').press('Tab');
    await page.waitForFunction(async () => (await window.recorder.getConfig()).autoStop === 86400);
    await page.locator('[data-duration="hours"]').fill('0');
    await page.locator('[data-duration="hours"]').press('Tab');
    await page.waitForFunction(async () => (await window.recorder.getConfig()).autoStop === 0);
    await page.locator('[data-duration="seconds"]').fill('2');
    await page.locator('[data-duration="seconds"]').press('Tab');
    await page.waitForFunction(async () => (await window.recorder.getConfig()).autoStop === 2);
    pass('Hours/minutes/seconds persist across reload; invalid values rejected; zero and 24h supported');
    await page.locator('#toast').evaluate(el => { el.hidden = true; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 620));
    await page.screenshot({ path: path.join(artifacts, 'general-duration.png') });
    await page.locator('[data-page="about"]').click();
    assert.match(await page.locator('#page-about').textContent(), /licencia Apache 2\.0/);
    assert.match(await page.locator('#page-about').textContent(), /Creado por Oscar García · Excellent AI Solutions/);
    assert.equal(await page.locator('#page-about a').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifacts, 'about.png') });
    pass('About page states the licences and the author, with no external links');
    await page.locator('[data-page="home"]').click();

    await page.locator('#source-button').click();
    await page.locator('.source-tile').first().click();
    await page.locator('#record').click();
    await page.waitForFunction(() => document.body.classList.contains('recording'));
    assert.equal(await page.locator('#source-button').isDisabled(), true);
    assert.equal(await page.locator('[data-duration="hours"]').isDisabled(), true);
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 1, null, { timeout: 60000 });
    pass('REC button records and auto-stop saves a real file');
    await page.locator('#snapshot').click();
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 2);
    pass('Screenshot button creates a real image in library');
    await page.locator('[data-page="general"]').click();
    await page.locator('[data-duration="seconds"]').fill('1');
    await page.locator('[data-duration="seconds"]').press('Tab');
    const when = new Date(Date.now() + 4000);
    const local = new Date(when.getTime() - when.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    await page.locator('#schedule-time').fill(local);
    await page.locator('#schedule-button').click();
    await page.waitForFunction(() => document.body.classList.contains('recording'), null, { timeout: 12000 });
    await page.waitForFunction(() => document.querySelectorAll('.file-row').length >= 3, null, { timeout: 60000 });
    pass('Scheduled capture starts and automatically finalizes');
    await page.locator('[data-page="video"]').click();
    await page.locator('[data-setting="videoFormat"]').selectOption('avi');
    assert.equal(await page.locator('[data-setting="codec"]').isDisabled(), true);
    assert.ok((await page.locator('#footer-format').textContent()).includes('MPEG'));
    pass('AVI accurately labels its fixed codec');
    await page.locator('[data-setting="videoFormat"]').selectOption('mp4');
    await page.locator('[data-page="home"]').click();
    await page.locator('[data-mode="region"]').click();
    await page.locator('.source-tile').first().click();
    const area = await page.locator('#region-image').boundingBox();
    await page.mouse.move(area.x + area.width * .15, area.y + area.height * .15);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * .7, area.y + area.height * .7, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.locator('#confirm-region').isEnabled(), true);
    await page.locator('#confirm-region').click();
    await page.waitForFunction(async () => {
      const config = await window.recorder.getConfig();
      return config.mode === 'region' && config.region?.width > .5 && config.region?.width < .6;
    });
    pass('Region drag selection updates real recording settings');
    await page.screenshot({ path: path.join(artifacts, 'desktop-final.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 620));
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(artifacts, 'desktop-compact.png') });
    pass('Minimum desktop window layout fits');
    assert.deepEqual(report.errors, []);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
  finally { await app.evaluate(({ app }) => app.exit()); await app.close(); fs.writeFileSync(path.join(artifacts, 'ui-report.json'), JSON.stringify(report, null, 2)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
