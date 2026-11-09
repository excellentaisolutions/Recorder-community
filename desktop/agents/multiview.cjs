const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { transcode } = require('./media.cjs');
const { executeStep } = require('./demo-steps.cjs');

async function splitVideo(app, storage, recipe, views, timing, allowed) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-multiview-'));
  try {
    fs.copyFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeui.ttf'), path.join(temp, 'font.ttf'));
    const args = [], filters = [];
    views.forEach((view, index) => {
      const offset = Math.max(0, (timing.start - view.firstFrame) / 1000);
      view.offsetSeconds = offset;
      args.push('-ss', String(offset), '-i', view.file);
      fs.writeFileSync(path.join(temp, `label-${index}.txt`), view.label);
      filters.push(`[${index}:v]setpts=PTS-STARTPTS,fps=30,scale=${recipe.width}:${recipe.height},tpad=stop_mode=clone:stop_duration=2,trim=duration=${timing.duration},pad=iw:ih+40:0:40:color=0x171b21,drawtext=fontfile=font.ttf:textfile=label-${index}.txt:expansion=none:fontcolor=white:fontsize=22:x=12:y=6[v${index}]`);
    });
    filters.push(`[v0][v1]${recipe.layout === 'vertical' ? 'vstack' : 'hstack'}=inputs=2:shortest=1[out]`);
    const output = storage.freshPath('mp4');
    await transcode(app, [...args, '-filter_complex', filters.join(';'), '-map', '[out]', '-an', '-t', String(timing.duration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], allowed, temp);
    return storage.fileEntry(output);
  } finally {
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-multiview-')) fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function runMultiview(app, storage, recipe, allowed) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged ? path.join(process.resourcesPath, 'playwright') : path.join(app.getAppPath(), 'bin', 'playwright');
  const { chromium } = require('playwright');
  let browser, failure, cancellation, startingCapture = false, openingPage = false;
  const views = [], marks = [], screenshots = [], steps = [];
  const timing = { start: 0, duration: 0 };
  let started = performance.now();
  const guard = () => { if (!allowed()) throw new Error('Demo multipantalla cancelada.'); };
  const stopViews = async () => {
    await Promise.allSettled(views.map(async view => {
      if (view.recording) { await view.page.screencast.stop(); view.recording = false; }
    }));
    await Promise.allSettled(views.map(view => view.context?.close()));
  };
  const cancelTimer = setInterval(() => {
    if (!allowed() && !startingCapture && !openingPage && !cancellation) cancellation = stopViews();
  }, 250);
  try {
    guard();
    browser = await chromium.launch({ channel: recipe.browser, headless: false });
    guard();
    for (const definition of recipe.views) {
      const view = { id: definition.id, label: definition.label, file: storage.freshPath('webm'), recording: false };
      views.push(view);
      openingPage = true;
      try {
        view.context = await browser.newContext({ viewport: { width: recipe.width, height: recipe.height }, acceptDownloads: false });
        guard();
        view.page = await view.context.newPage();
      } finally { openingPage = false; }
      view.page.setDefaultTimeout(10000);
      guard();
      await view.page.goto(definition.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (const step of definition.setup) {
        guard();
        await executeStep(view.page, step, { storage, width: recipe.width, height: recipe.height, started, guard, marks: [], screenshots: [], view: view.id });
      }
      guard();
    }
    startingCapture = true;
    const starts = await Promise.allSettled(views.map(async view => {
      await view.page.screencast.start({ path: view.file, size: { width: recipe.width, height: recipe.height }, fps: 30,
        onFrame: frame => { view.firstFrame ??= frame.timestamp; } });
      view.recording = true;
    }));
    startingCapture = false;
    const failedStart = starts.find(result => result.status === 'rejected');
    if (failedStart) throw failedStart.reason;
    const deadline = Date.now() + 10000;
    while (views.some(view => !view.firstFrame)) {
      guard();
      if (Date.now() > deadline) throw new Error('No llegaron fotogramas de ambas sesiones.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    guard(); timing.start = Date.now(); started = performance.now();
    for (let index = 0; index < recipe.steps.length; index++) {
      guard();
      const step = recipe.steps[index];
      const actions = step.action === 'parallel' ? step.steps : [step];
      const results = await Promise.allSettled(actions.map(async action => {
        const view = views.find(view => view.id === action.view);
        await executeStep(view.page, action, { storage, width: recipe.width, height: recipe.height, started, guard, marks, screenshots, view: view.id });
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw new Error(`Paso ${index + 1} (${step.action}) falló: ${failed.reason.message}`);
      steps.push({ index, action: step.action, views: actions.map(action => action.view), seconds: (performance.now() - started) / 1000, status: 'completed' });
    }
    guard(); timing.duration = Math.max(.1, (performance.now() - started) / 1000);
  } catch (error) { failure = error; }
  finally {
    clearInterval(cancelTimer);
    if (cancellation) await cancellation;
    await stopViews();
    await browser?.close().catch(() => {});
  }
  const originals = views.filter(view => fs.existsSync(view.file) && fs.statSync(view.file).size);
  if (failure) throw new Error(`${failure.message}${originals.length ? '. Tomas conservadas: ' + originals.map(view => view.file).join(', ') : ''}`);
  if (originals.length !== 2) throw new Error('No se produjeron las dos tomas de vídeo.');
  const artifact = await splitVideo(app, storage, recipe, views, timing, allowed);
  for (const mark of marks.filter(mark => mark.region)) {
    const index = views.findIndex(view => view.id === mark.view), r = mark.region;
    const panelHeight = recipe.height + 40;
    mark.compositeRegion = recipe.layout === 'horizontal'
      ? { x: (index + r.x) / 2, y: (40 + r.y * recipe.height) / panelHeight, width: r.width / 2, height: r.height * recipe.height / panelHeight }
      : { x: r.x, y: (index * panelHeight + 40 + r.y * recipe.height) / (2 * panelHeight), width: r.width, height: r.height * recipe.height / (2 * panelHeight) };
  }
  const result = { title: recipe.title, artifact, layout: recipe.layout, capture: 'two-isolated-browser-viewports', audio: false,
    views: views.map(view => ({ id: view.id, label: view.label, artifact: storage.fileEntry(view.file), offsetSeconds: view.offsetSeconds, firstFrameTimestamp: view.firstFrame })),
    synchronization: { method: 'browser-frame-timestamps', startEpochMs: timing.start, durationSeconds: timing.duration, frameAccurate: false },
    marks, screenshots, steps };
  fs.writeFileSync(`${artifact.path}.demo.json`, JSON.stringify(result, null, 2));
  return result;
}
module.exports = { runMultiview };
