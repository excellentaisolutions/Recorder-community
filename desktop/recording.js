import { validateScene, drawScene } from './scene.js';
const STATES = new Set(['screen', 'window', 'region', 'device', 'audio', 'scene']);

function fail(message) { throw new Error(message); }

function normalize(options) {
  const value = { mode: 'screen', fps: 30, systemAudio: true, microphone: false,
    webcamOverlay: false, textOverlay: '', format: options.mode === 'audio' ? 'mp3' : 'mp4', codec: 'h264',
    quality: 'balanced', countdown: 0, screenshotFormat: 'png', ...options };
  if (!STATES.has(value.mode)) fail('Modo de captura no válido.');
  if (value.mode === 'audio' ? !['mp3', 'wav', 'webm'].includes(value.format) : !['mp4', 'webm', 'mkv', 'avi'].includes(value.format))
    fail('El formato no corresponde al modo de captura.');
  if (![15, 24, 25, 30, 50, 60].includes(Number(value.fps))) fail('FPS no válidos.');
  value.fps = Number(value.fps);
  value.countdown = Math.max(0, Math.min(10, Number(value.countdown) || 0));
  if (value.mode === 'scene') validateScene(value.scene);
  if (value.mode === 'region') {
    const r = value.region;
    if (!r || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])))
      fail('Selecciona un área de grabación.');
    if (r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 ||
        r.x + r.width > 1.001 || r.y + r.height > 1.001)
      fail('El área de grabación debe estar dentro de la pantalla.');
  }
  return value;
}

async function videoFor(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (video.videoWidth && video.videoHeight) return video;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('La fuente no entrega imagen.')), 10000);
    video.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  return video;
}

export async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => ['audioinput', 'videoinput'].includes(d.kind)).map(d => ({
    id: d.deviceId, deviceId: d.deviceId, kind: d.kind,
    label: d.label || (d.kind === 'audioinput' ? 'Micrófono' : 'Cámara')
  }));
}

export class RecordingEngine extends EventTarget {
  constructor(api = window.recorder) {
    super();
    this.api = api;
    this._state = 'idle';
    this._streams = [];
    this._videos = [];
    this._elapsed = 0;
    this._generation = 0;
    this._stopping = null;
  }

  get state() { return this._state; }
  get elapsed() {
    return this._elapsed + (this._state === 'recording' ? (performance.now() - this._started) / 1000 : 0);
  }

  _emit(state = this._state, error) {
    this._state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, elapsed: this.elapsed,
      ...(error ? { error: error.message || String(error) } : {}) } }));
  }

  async _screen(options) {
    if (!options.sourceId) fail('Selecciona una pantalla o una ventana.');
    if (['screen', 'window'].includes(options.mode) && !options.sourceId.startsWith(`${options.mode}:`))
      fail('La fuente no corresponde al modo seleccionado. Vuelve a seleccionarla.');
    await this.api.selectSource(options.sourceId);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: options.fps, max: options.fps } },
      audio: !!options.systemAudio
    });
    this._streams.push(stream);
    if (options.systemAudio && !stream.getAudioTracks().length)
      fail('Windows no ha entregado audio del sistema. Desactívalo o comprueba el dispositivo de salida.');
    return stream;
  }

  async _camera(id, fps) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { ...(id ? { deviceId: { exact: id } } : {}),
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: fps } } });
    this._streams.push(stream);
    return stream;
  }

  async _microphone(id) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false,
      audio: { ...(id ? { deviceId: { exact: id } } : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this._streams.push(stream);
    return stream;
  }

  async _mix(streams) {
    const audible = streams.filter(s => s && s.getAudioTracks().length);
    if (!audible.length) return [];
    this._audio = new AudioContext();
    await this._audio.resume();
    const output = this._audio.createMediaStreamDestination();
    this._audioNodes = audible.map(s => {
      const node = this._audio.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
      node.connect(output);
      return node;
    });
    this._streams.push(output.stream);
    return output.stream.getAudioTracks();
  }

  async _capture(options) {
    if (options.mode === 'scene') return this._captureScene(options);
    const needsScreen = options.mode !== 'device' && (options.mode !== 'audio' || options.systemAudio);
    const primary = needsScreen ? await this._screen(options) :
      options.mode === 'device' ? await this._camera(options.cameraId, options.fps) : null;
    const loopback = options.mode === 'device' && options.systemAudio ? await this._screen(options) : null;
    const microphone = options.microphone ? await this._microphone(options.microphoneId) : null;
    const audio = await this._mix([primary, loopback, microphone]);
    if (options.mode === 'audio') {
      if (!audio.length) fail('Activa el micrófono o el audio del sistema para grabar audio.');
      return new MediaStream(audio);
    }
    this._primary = await videoFor(primary);
    this._videos.push(this._primary);
    if (options.webcamOverlay && options.mode !== 'device') {
      this._webcam = await videoFor(await this._camera(options.cameraId, options.fps));
      this._videos.push(this._webcam);
    }
    const compose = options.mode === 'region' || this._webcam || options.textOverlay;
    const video = compose ? this._compose(options).getVideoTracks() : primary.getVideoTracks();
    return new MediaStream([...video, ...audio]);
  }

  async _captureScene(options) {
    this._sceneVideos = [];
    let primary;
    for (const [index, item] of options.scene.items.entries()) {
      const stream = await this._screen({ ...options, sourceId: item.sourceId, systemAudio: index === 0 && options.systemAudio });
      primary ||= stream;
      const video = await videoFor(stream);
      this._videos.push(video); this._sceneVideos.push(video);
    }
    this._primary = this._sceneVideos[0];
    const microphone = options.microphone ? await this._microphone(options.microphoneId) : null;
    const audio = await this._mix([primary, microphone]);
    if (options.webcamOverlay) {
      this._webcam = await videoFor(await this._camera(options.cameraId, options.fps));
      this._videos.push(this._webcam);
    }
    return new MediaStream([...this._compose(options).getVideoTracks(), ...audio]);
  }

  _draw(options) {
    const video = this._primary;
    if (!video?.videoWidth || !this._canvas) return;
    const { width, height } = this._canvas;
    const r = options.mode === 'region' ? options.region : { x: 0, y: 0, width: 1, height: 1 };
    const ctx = this._canvas.getContext('2d', { alpha: false });
    if (options.mode === 'scene') drawScene(ctx, this._canvas, this._sceneVideos, options.scene);
    else ctx.drawImage(video, r.x * video.videoWidth, r.y * video.videoHeight,
      r.width * video.videoWidth, r.height * video.videoHeight, 0, 0, width, height);
    if (this._webcam?.videoWidth) {
      const w = Math.round(width * 0.23), h = w * this._webcam.videoHeight / this._webcam.videoWidth;
      ctx.drawImage(this._webcam, width - w - 16, height - h - 16, w, h);
    }
    if (options.textOverlay) {
      const size = Math.max(16, Math.round(height * 0.035));
      ctx.font = `600 ${size}px Segoe UI, sans-serif`;
      const label = String(options.textOverlay).slice(0, 200);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(12, 12, Math.min(width - 24, ctx.measureText(label).width + 24), size + 20);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, 24, size + 16, width - 48);
    }
  }

  _compose(options) {
    const region = options.mode === 'region' ? options.region : { width: 1, height: 1 };
    this._canvas = document.createElement('canvas');
    this._canvas.width = Math.max(2, Math.floor(this._primary.videoWidth * region.width / 2) * 2);
    this._canvas.height = Math.max(2, Math.floor(this._primary.videoHeight * region.height / 2) * 2);
    if (options.mode === 'scene') { this._canvas.width = options.scene.width; this._canvas.height = options.scene.height; }
    this._draw(options);
    this._drawTimer = setInterval(() => this._draw(options), 1000 / options.fps);
    const stream = this._canvas.captureStream(options.fps);
    this._streams.push(stream);
    return stream;
  }

  _mime(audioOnly) {
    const values = audioOnly ? ['audio/webm;codecs=opus', 'audio/webm'] :
      ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return values.find(v => MediaRecorder.isTypeSupported(v)) || fail('Este equipo no admite la codificación WebM.');
  }

  async start(options = {}) {
    if (!['idle', 'error'].includes(this.state)) fail('Ya hay una captura en curso.');
    if (this._snapshotBusy) fail('Espera a que termine la captura de imagen.');
    const generation = ++this._generation;
    this._options = normalize(options);
    this._elapsed = 0;
    this._stopping = null;
    this._writeError = null;
    this._fileId = null;
    this._recordedBytes = 0;
    this._emit('starting');
    try {
      this._output = await this._capture(this._options);
      for (let n = this._options.countdown; n > 0; n--) {
        this.dispatchEvent(new CustomEvent('countdown', { detail: n }));
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (generation !== this._generation) fail('Inicio de grabación cancelado.');
      }
      if (generation !== this._generation) fail('Inicio de grabación cancelado.');
      const file = await this.api.startFile({ extension: 'webm', kind: this._options.mode === 'audio' ? 'audio' : 'video' });
      this._fileId = file.id;
      if (generation !== this._generation) fail('Inicio de grabación cancelado.');
      this._launchRecorder();
    } catch (error) {
      await this._releaseFile(error);
      await this._cleanup();
      if (generation !== this._generation) { error.name = 'AbortError'; this._emit('idle'); }
      else this._emit('error', error);
      throw error;
    }
  }

  _launchRecorder() {
    const options = this._options;
    const bitrate = { high: 18000000, balanced: 10000000, small: 4000000 }[options.quality] || 10000000;
    this._recorder = new MediaRecorder(this._output, {
      mimeType: this._mime(options.mode === 'audio'), videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000
    });
    this._writes = Promise.resolve();
    this._recordedBytes = 0;
    this._recorder.ondataavailable = event => this._queueChunk(event.data);
    this._recorder.onerror = event => {
      this._writeError ||= event.error || new Error('Ha fallado el codificador de captura.');
      this.stop().catch(() => {});
    };
    this._recorder.start(1000);
    this._started = performance.now();
    this._emit('recording');
    this._ticker = setInterval(() => {
      this._emit();
      if (this.state === 'recording' && Number(this._options.autoStop) > 0 && this.elapsed >= Number(this._options.autoStop))
        this.stop().catch(() => {});
    }, 100);
    for (const track of this._output.getTracks()) track.addEventListener('ended', () => {
      if (['recording', 'paused'].includes(this.state)) this.stop().catch(() => {});
    }, { once: true });
    for (const stream of this._streams) for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (['recording', 'paused'].includes(this.state)) this.stop().catch(() => {});
      }, { once: true });
    }
  }

  _queueChunk(blob) {
    if (!blob.size) return;
    this._recordedBytes += blob.size;
    this._writes = this._writes.then(async () => {
      if (this._writeError) return;
      const bytes = await blob.arrayBuffer();
      await this.api.appendChunk(this._fileId, bytes);
    }).catch(error => {
      this._writeError = error;
      if (['recording', 'paused'].includes(this.state)) this.stop().catch(() => {});
    });
  }

  pause() {
    if (this.state !== 'recording') return;
    this._elapsed = this.elapsed;
    this._recorder.pause();
    this._emit('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this._recorder.resume();
    this._started = performance.now();
    this._emit('recording');
  }

  async stop() {
    if (this._stopping) return this._stopping;
    if (this.state === 'starting') { ++this._generation; return null; }
    if (!['recording', 'paused'].includes(this.state)) return null;
    this._elapsed = this.elapsed;
    this._emit('stopping');
    this._stopping = this._finish();
    return this._stopping;
  }

  async _finish() {
    try {
      await new Promise((resolve, reject) => {
        if (this._recorder.state === 'inactive') return resolve();
        this._recorder.addEventListener('stop', resolve, { once: true });
        try { this._recorder.stop(); } catch (error) { reject(error); }
      });
      await this._writes;
      if (this._writeError) throw this._writeError;
      if (!this._recordedBytes) fail('La fuente no ha producido datos. No se ha creado una grabación vacía.');
      await this._cleanup();
      const file = await this.api.finishFile(this._fileId, {
        format: this._options.format, codec: this._options.codec,
        quality: this._options.quality, fps: this._options.fps
      });
      this._fileId = null;
      this._emit('idle');
      this.dispatchEvent(new CustomEvent('finished', { detail: file }));
      return file;
    } catch (error) {
      await this._releaseFile(error);
      await this._cleanup();
      this._emit('error', error);
      throw error;
    } finally { this._stopping = null; }
  }

  async _releaseFile(error) {
    if (!this._fileId) return;
    const id = this._fileId;
    this._fileId = null;
    try {
      const result = await this.api.abortFile(id);
      if (result?.preserved) error.message += ` Captura parcial conservada: ${result.preserved}`;
    } catch (cleanupError) {
      if (!cleanupError.message?.includes('La sesión de grabación no existe.'))
        error.message += ` No se pudo cerrar la captura: ${cleanupError.message || cleanupError}`;
    }
  }

  async screenshot(options = {}) {
    if (this._snapshotBusy) fail('Ya hay una captura de imagen en curso.');
    if (this._primary?.videoWidth) {
      const canvas = this._canvas || this._frame(this._primary);
      return this.api.saveScreenshot(canvas.toDataURL(options.screenshotFormat === 'jpeg' ? 'image/jpeg' : 'image/png', 0.95),
        options.screenshotFormat === 'jpeg' ? 'jpeg' : 'png');
    }
    if (!['idle', 'error'].includes(this.state)) fail('La captura de imagen no está disponible en este momento.');
    const capture = normalize({ ...options, systemAudio: false, microphone: false,
      mode: options.mode === 'audio' ? 'screen' : options.mode || 'screen' });
    this._snapshotBusy = true;
    try {
      await this._capture(capture);
      const canvas = this._canvas || this._frame(this._primary);
      return await this.api.saveScreenshot(canvas.toDataURL(capture.screenshotFormat === 'jpeg' ? 'image/jpeg' : 'image/png', 0.95),
        capture.screenshotFormat === 'jpeg' ? 'jpeg' : 'png');
    } finally { await this._cleanup(); this._snapshotBusy = false; }
  }

  _frame(video) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas;
  }

  async _cleanup() {
    clearInterval(this._ticker);
    clearInterval(this._drawTimer);
    for (const stream of this._streams) for (const track of stream.getTracks()) track.stop();
    for (const video of this._videos) { video.pause(); video.srcObject = null; }
    this._streams = [];
    this._videos = [];
    this._output = null;
    this._primary = null;
    this._sceneVideos = null;
    this._webcam = null;
    this._canvas = null;
    if (this._audio && this._audio.state !== 'closed') await this._audio.close().catch(() => {});
    this._audio = null;
    this._audioNodes = [];
  }

  async dispose() {
    ++this._generation;
    if (['recording', 'paused', 'stopping'].includes(this.state)) await this.stop();
    else await this._cleanup();
  }
}
