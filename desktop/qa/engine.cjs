const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { _electron: electron } = require('playwright');

async function run() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'recorder-engine-qa-'));
  let app;
  try {
    const main = path.join(temporary, 'main.cjs');
    await fs.writeFile(path.join(temporary, 'index.html'), '<!doctype html><html lang="es"><body>Recorder engine QA</body></html>');
    await fs.writeFile(main, `
      const {app,BrowserWindow,session}=require('electron');
      app.commandLine.appendSwitch('use-fake-device-for-media-stream');
      app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
      app.whenReady().then(()=>{
        session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(permission==='media'));
        const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
        window.loadFile(${JSON.stringify(path.join(temporary, 'index.html'))});
      });
      app.on('window-all-closed',()=>app.quit());
    `);
    app = await electron.launch({ args: [main], timeout: 30000 });
    const page = await app.firstWindow();
    const result = await page.evaluate(async moduleUrl => {
      const { RecordingEngine } = await import(moduleUrl);
      const cases = [];
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async predicate => {
        const deadline = Date.now() + 12000;
        while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for engine'); await delay(25); }
      };
      let sequence = 0, activeWrites = 0, maxWrites = 0, failWrite = false, failExport = false;
      let delayStart = false, releaseStart;
      const data = new Map();
      const activeIds = new Set(), abortedIds = new Set();
      const api = {
        selectSource: async () => {},
        startFile: async () => {
          check(activeIds.size === 0, 'Previous backend session was not released');
          const id = String(++sequence); data.set(id, []); activeIds.add(id);
          if (delayStart) await new Promise(resolve => { releaseStart = resolve; });
          return { id };
        },
        appendChunk: async (id, buffer) => {
          activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
          try { await delay(15); if (failWrite) throw new Error('simulated disk full'); data.get(id).push(buffer.byteLength); }
          finally { activeWrites--; }
        },
        finishFile: async id => {
          check(activeWrites === 0, 'Export began before writes completed');
          activeIds.delete(id);
          if (failExport) throw new Error('simulated codec failure');
          return { id, name: `capture-${id}.webm`, size: data.get(id).reduce((a, b) => a + b, 0) };
        },
        abortFile: async id => {
          if (!activeIds.has(id)) throw new Error('La sesión de grabación no existe.');
          activeIds.delete(id); abortedIds.add(id);
          if (!data.get(id).length) data.delete(id);
        },
        saveScreenshot: async (url, format) => {
          check(url.startsWith(`data:image/${format === 'jpeg' ? 'jpeg' : 'png'}`), 'Screenshot image format mismatch');
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          check(bitmap.width > 0 && bitmap.height > 0, 'Empty screenshot'); bitmap.close();
          return { name: `screenshot.${format}` };
        }
      };
      const engine = new RecordingEngine(api);
      await engine.start({ mode: 'screen', sourceId: '', systemAudio: false }).then(
        () => { throw new Error('Missing source was accepted'); },
        error => check(error.message.includes('Selecciona'), 'Unexpected missing-source error'));
      check(engine.state === 'error' && engine._streams.length === 0, 'Failed start leaked a stream');
      cases.push('Missing source reports an error and releases resources');

      const syntheticCapture = async function() {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext('2d'); let frame = 0;
        const draw = () => { context.fillStyle = frame++ % 2 ? '#2184d8' : '#9525b8'; context.fillRect(0,0,320,180); };
        draw(); this._drawTimer = setInterval(draw, 33);
        const stream = canvas.captureStream(30); this._streams.push(stream);
        const video = document.createElement('video'); video.muted = true; video.srcObject = stream;
        await video.play(); this._primary = video; this._videos.push(video);
        return stream;
      };
      engine._capture = syntheticCapture;
      await engine.start({ systemAudio: false, format: 'webm' });
      await delay(1150); engine.pause(); const paused = engine.elapsed;
      await delay(200); check(engine.elapsed === paused, 'Elapsed time increased while paused');
      const screenshot = await engine.screenshot({ screenshotFormat: 'png' });
      check(screenshot.name === 'screenshot.png', 'Screenshot did not complete during pause');
      engine.resume(); await delay(250); const first = await engine.stop();
      check(first.size > 0 && engine.state === 'idle', 'No genuine MediaRecorder bytes');
      check(maxWrites === 1 && engine._streams.length === 0, 'Concurrent writes or leaked stream');
      cases.push('Real canvas MediaRecorder, pause/resume timing, PNG screenshot, queued writes and stop');

      failWrite = true; await engine.start({ systemAudio: false, format: 'webm' });
      await until(() => engine.state === 'error'); await until(() => !engine._stopping);
      check(engine._streams.length === 0, 'Write failure leaked tracks');
      failWrite = false; await engine.start({ systemAudio: false, format: 'webm' });
      await delay(250); const retry = await engine.stop(); check(retry.size > 0, 'Could not retry after disk error');
      cases.push('Asynchronous disk-write error stops capture and allows a clean retry');

      failExport = true; await engine.start({ systemAudio: false, format: 'webm' }); await delay(250);
      await engine.stop().then(() => { throw new Error('Export failure ignored'); }, error => {
        check(error.message.includes('codec failure'), 'Wrong export error');
      });
      check(engine.state === 'error' && !engine._stopping, 'Export error left stop stuck');
      failExport = false; await engine.start({ systemAudio: false, format: 'webm' });
      await delay(250); await engine.stop();
      cases.push('Export failure is surfaced and subsequent recording remains functional');

      const camera = new RecordingEngine(api);
      await camera.start({ mode: 'device', systemAudio: false, microphone: true, format: 'webm' });
      await delay(350); const jpg = await camera.screenshot({ screenshotFormat: 'jpeg' });
      const cameraFile = await camera.stop();
      check(cameraFile.size > 0 && jpg.name.endsWith('.jpeg'), 'Camera/microphone capture failed');
      check(camera._streams.length === 0 && !camera._audio, 'Camera/audio resources leaked');
      cases.push('Chromium synthetic camera and microphone, mixed audio, JPEG screenshot and cleanup');

      const audio = new RecordingEngine(api);
      await audio.start({ mode: 'audio', systemAudio: false, microphone: true, format: 'wav' });
      await delay(350); const audioFile = await audio.stop(); check(audioFile.size > 0, 'Audio-only empty');
      cases.push('Chromium synthetic microphone audio-only recording');
      const composite = new RecordingEngine(api);
      composite._screen = function(options) { return this._camera('', options.fps); };
      await composite.start({ mode: 'region', sourceId: 'fixture', systemAudio: false,
        region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        webcamOverlay: true, textOverlay: 'Prueba de región', format: 'webm' });
      check(composite._canvas.width === Math.floor(composite._primary.videoWidth / 4) * 2,
        'Region canvas dimensions do not reflect the selected crop');
      await delay(300); await composite.screenshot({ screenshotFormat: 'png' });
      const compositeFile = await composite.stop(); check(compositeFile.size > 0, 'Composite capture empty');
      cases.push('Normalized region crop, webcam and text composition with real canvas encoding');

      await engine.start({ systemAudio: false, format: 'webm' }); await delay(250);
      engine._output.getVideoTracks()[0].dispatchEvent(new Event('ended'));
      await until(() => engine.state === 'idle');
      cases.push('Source-ended event finalizes the recording and releases capture');

      const beforeCancel = sequence;
      const starting = engine.start({ systemAudio: false, countdown: 2, format: 'webm' });
      await delay(100); await engine.stop();
      await starting.then(() => { throw new Error('Cancelled countdown still started recording'); },
        error => check(error.message.includes('cancelado'), 'Wrong countdown cancellation error'));
      check(sequence === beforeCancel && engine._streams.length === 0, 'Countdown cancellation opened a file or leaked tracks');
      cases.push('Countdown cancellation does not create a recording or leak tracks');

      for (const action of ['stop', 'dispose']) {
        delayStart = true; releaseStart = null;
        const pending = engine.start({ systemAudio: false, format: 'webm' });
        await until(() => typeof releaseStart === 'function');
        const pendingId = String(sequence);
        await engine[action](); releaseStart();
        await pending.then(() => { throw new Error('Cancelled startFile launched MediaRecorder'); },
          error => check(error.message.includes('cancelado'), 'Wrong pending-start cancellation error'));
        check(abortedIds.has(pendingId) && activeIds.size === 0 && !data.has(pendingId),
          'Cancelled pending startFile leaked its empty backend session');
        check(engine.state === 'idle' && engine._streams.length === 0, 'Cancelled pending startFile must return idle and release media');
        delayStart = false;
        cases.push(`${action} during pending startFile aborts the late empty file without recording`);
      }

      await engine.start({ systemAudio: false, format: 'webm' });
      const emptyId = String(sequence);
      engine._recorder.ondataavailable = () => {};
      await engine.stop().then(() => { throw new Error('Empty recording finalized'); },
        error => check(error.message.includes('no ha producido datos'), 'Wrong empty recording error'));
      check(abortedIds.has(emptyId) && activeIds.size === 0, 'Empty recording left backend busy');
      await engine.start({ systemAudio: false, format: 'webm' }); await delay(100); await engine.stop();
      cases.push('Zero-byte recording releases backend session and permits retry');
      await engine.dispose(); await camera.dispose(); await audio.dispose(); await composite.dispose();
      return { passed: cases, maximumConcurrentWrites: maxWrites,
        limitations: ['Camera/microphone supplied by Chromium fake-device flags; physical hardware not established.',
          'Disk/export bridge simulated; real filesystem and FFmpeg are covered by separate integration tests.'] };
    }, pathToFileURL(path.resolve(__dirname, '../recording.js')).href);
    assert.equal(result.passed.length, 12);
    await fs.writeFile(path.join(__dirname, 'engine-report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (app) await app.close();
    const resolved = path.resolve(temporary);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('recorder-engine-qa-'))
      await fs.rm(resolved, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
