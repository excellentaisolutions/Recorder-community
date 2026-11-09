import { RecordingEngine, enumerateDevices } from './recording.js';

export class RecordingController extends EventTarget {
  constructor(api) {
    super();
    this.engine = new RecordingEngine(api);
    this.session = null;
    for (const name of ['state', 'countdown', 'finished']) this.engine.addEventListener(name, event => {
      if (name === 'finished' && this.session) this.session.artifact = event.detail;
      if (name === 'state' && this.session) this.session.error = event.detail.error || null;
      this.dispatchEvent(new CustomEvent(name, { detail: event.detail }));
      if (name === 'finished') this.dispatchEvent(new CustomEvent('state', { detail: { state: this.state, elapsed: this.engine.elapsed } }));
    });
  }
  get state() { return this.engine.state; }
  status() {
    return { ...this.session, state: this.state, elapsed: this.engine.elapsed,
      dimensions: this.engine._primary ? { width: this.engine._canvas?.width || this.engine._primary.videoWidth, height: this.engine._canvas?.height || this.engine._primary.videoHeight } : null };
  }
  authorize(owner, id) {
    if (owner !== 'local' && (!this.session || this.session.owner !== owner || this.session.id !== id))
      throw new Error('La sesión pertenece a otro controlador o el identificador no coincide.');
  }
  async start(options, owner = 'local') {
    if (!['idle', 'error'].includes(this.state) || this.engine._snapshotBusy) throw new Error('Recorder está ocupado.');
    this.session = { id: crypto.randomUUID(), owner, startedAt: new Date().toISOString(), marks: [], artifact: null };
    await this.engine.start(options);
    return this.status();
  }
  async stop(owner = 'local', id) {
    this.authorize(owner, id);
    const artifact = await this.engine.stop();
    return { ...this.status(), artifact: artifact || this.session?.artifact || null };
  }
  pause(owner = 'local', id) { this.authorize(owner, id); this.engine.pause(); return this.status(); }
  resume(owner = 'local', id) { this.authorize(owner, id); this.engine.resume(); return this.status(); }
  mark(label, owner, id) {
    this.authorize(owner, id);
    if (!['recording', 'paused'].includes(this.state)) throw new Error('No hay una grabación activa.');
    const mark = { label, seconds: this.engine.elapsed };
    this.session.marks.push(mark);
    return mark;
  }
  async screenshot(options, owner = 'local', id) {
    if (!['idle', 'error'].includes(this.state)) this.authorize(owner, id);
    return this.engine.screenshot(options);
  }
  async command({ method, params = {}, owner }) {
    if (method === 'devices.list') return enumerateDevices();
    if (method === 'recording.start') return this.start(params, owner);
    if (method === 'recording.status') return this.status();
    if (method === 'recording.stop') return this.stop(owner, params.sessionId);
    if (method === 'recording.pause') return this.pause(owner, params.sessionId);
    if (method === 'recording.resume') return this.resume(owner, params.sessionId);
    if (method === 'recording.mark') return this.mark(params.label, owner, params.sessionId);
    if (method === 'screenshot.capture') return this.screenshot(params, owner, params.sessionId);
    throw new Error('Operación desconocida.');
  }
}
