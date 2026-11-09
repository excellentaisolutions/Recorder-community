const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { envelope, parse, tools } = require('./schema.cjs');

function createAgentService({ app, storage, listSources, command, emit, demo, multiview, compose, speech, capabilities }) {
  const file = path.join(app.getPath('userData'), 'agent-connection.json');
  let token = crypto.randomBytes(32).toString('hex');
  let enabled = storage.getConfig().agentEnabled === true;
  let port;
  let generation = 0;
  let mediaBusy = false;
  const pendingJobs = new Set();
  const jobs = new Map(), requests = new Map(), activity = [];
  const writeConnection = () => fs.writeFileSync(file, JSON.stringify({ port, token, enabled, version: 1 }), { mode: 0o600 });
  const state = () => ({ enabled, activity: activity.slice(0, 20), jobs: [...jobs.values()].slice(-10).map(({ id, owner, status, error }) => ({ id, owner, status, error })),
    mcp: { mcpServers: { recorder: { command: process.execPath,
      args: [path.join(app.getAppPath(), 'agents', 'entry.cjs'), '--mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1', RECORDER_CONNECTION: file, RECORDER_CLIENT: 'my-agent' } } } } });
  function log(client, method, status) {
    activity.unshift({ at: new Date().toISOString(), client, method, status });
    activity.splice(40); emit('recorder:integrationChanged', state());
  }
  function job(owner, run, cancellable = false) {
    if (jobs.size >= 100) {
      const old = [...jobs].find(([, item]) => item.status !== 'running');
      if (!old) throw new Error('Demasiados trabajos activos');
      jobs.delete(old[0]);
    }
    const item = { id: crypto.randomUUID(), owner, status: 'running', cancelled: false, cancellable, createdAt: new Date().toISOString() };
    jobs.set(item.id, item);
    const pending = Promise.resolve().then(() => run(item)).then(result => { item.status = 'completed'; item.result = result; }, error => {
      item.status = item.cancelled ? 'cancelled' : 'failed'; item.error = error.message;
    }).finally(() => { pendingJobs.delete(pending); log(owner, 'job', item.status); });
    pendingJobs.add(pending);
    return { jobId: item.id, status: item.status };
  }
  async function dispatch(method, params, owner) {
    const dispatchedGeneration = generation;
    if (method === 'capabilities.get') return capabilities();
    if (method === 'schedule.create') {
      const at = Date.parse(params.at), wait = at - Date.now();
      if (wait <= 0 || wait > 24 * 86400000) throw new Error('Programa una fecha futura dentro de 24 días.');
      return job(owner, async item => {
        item.scheduledAt = params.at;
        while (Date.now() < at) {
          if (!enabled || generation !== dispatchedGeneration || item.cancelled) { item.cancelled = true; throw new Error('Programación cancelada.'); }
          await new Promise(resolve => setTimeout(resolve, Math.min(250, at - Date.now())));
        }
        if (!enabled || generation !== dispatchedGeneration || item.cancelled) { item.cancelled = true; throw new Error('Programación cancelada.'); }
        await listSources();
        if (!enabled || generation !== dispatchedGeneration || item.cancelled) { item.cancelled = true; throw new Error('Programación cancelada.'); }
        return command({ method: 'recording.start', params: params.capture, owner });
      }, true);
    }
    if (method === 'sources.list') return (await listSources()).map(({ thumbnail, dataURL, ...source }) => source);
    if (method === 'source.preview') {
      const source = (await listSources()).find(s => s.id === params.sourceId);
      if (!source) throw new Error('Fuente no disponible. Actualiza sources.list.');
      return { sourceId: source.id, thumbnail: source.thumbnail, geometry: source.kind === 'screen' ? { width: source.width, height: source.height } : null };
    }
    if (method === 'artifacts.list') return storage.listFiles();
    if (method === 'voices.list') return speech({ action: 'voices' });
    if (method === 'jobs.status' || method === 'jobs.cancel') {
      const item = jobs.get(params.jobId);
      if (!item || item.owner !== owner) throw new Error('Trabajo no disponible para este cliente.');
      if (method === 'jobs.cancel') {
        if (!item.cancellable) throw new Error('La exportación de una grabación debe terminar para conservar el archivo.');
        if (item.status === 'running') item.cancelled = true;
      }
      return item;
    }
    if (method === 'recording.stop') {
      const status = await command({ method: 'recording.status', owner });
      if (status.owner !== owner || status.id !== params.sessionId) throw new Error('La sesión pertenece a otro controlador.');
      return job(owner, () => command({ method, params, owner }, 3600000));
    }
    if (['demo.run', 'demo.multiview', 'media.compose', 'narration.create'].includes(method)) {
      if (mediaBusy) throw new Error('Ya hay una demo o montaje en curso.');
      mediaBusy = true;
      const currentGeneration = generation;
      try { return job(owner, async item => {
        try { return await ({ 'demo.run': demo, 'demo.multiview': multiview, 'media.compose': compose, 'narration.create': speech }[method])(params, () => enabled && generation === currentGeneration && !item.cancelled); }
        finally { mediaBusy = false; }
      }, true); } catch (error) { mediaBusy = false; throw error; }
    }
    if (['recording.start', 'screenshot.capture'].includes(method)) await listSources();
    if (!enabled || generation !== dispatchedGeneration) throw new Error('Acceso revocado durante la solicitud.');
    return command({ method, params, owner });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const reply = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    const received = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(token);
    if (!enabled || req.headers.origin || req.headers.host !== `127.0.0.1:${port}` || received.length !== expected.length || !crypto.timingSafeEqual(received, expected))
      return reply(403, { error: 'Acceso local no autorizado. Activa Integraciones IA y usa una conexión vigente.' });
    if (req.method !== 'POST' || req.url !== '/call') return reply(404, { error: 'Ruta desconocida' });
    let body = '';
    try {
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Petición demasiado grande'); }
      const input = envelope.parse(JSON.parse(body));
      const params = parse(input.method, input.params);
      const key = `${input.client}:${input.requestId}`;
      const signature = JSON.stringify({ method: input.method, params });
      let cached = requests.get(key);
      if (cached && cached.signature !== signature) throw new Error('requestId reutilizado con parámetros diferentes');
      if (!cached) {
        if (requests.size >= 1000) {
          const old = [...requests].find(([, item]) => item.done);
          if (!old) throw new Error('Demasiadas solicitudes pendientes');
          requests.delete(old[0]);
        }
        cached = { signature, done: false, result: dispatch(input.method, params, input.client).then(result => ({ result }), error => ({ error: error.message })) };
        cached.result.finally(() => { cached.done = true; });
        requests.set(key, cached);
      }
      const result = await cached.result;
      log(input.client, input.method, result.error ? 'error' : 'ok');
      reply(result.error ? 400 : 200, result);
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  server.maxConnections = 16;
  return {
    state, tools,
    hasRunning: () => pendingJobs.size > 0,
    settle: () => Promise.allSettled([...pendingJobs]),
    cancel() { for (const item of jobs.values()) if (item.cancellable && item.status === 'running') item.cancelled = true; return state(); },
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      port = server.address().port; writeConnection();
    },
    set({ enabled: next, rotate }) {
      enabled = next; generation++;
      if (rotate) { token = crypto.randomBytes(32).toString('hex'); requests.clear(); }
      storage.saveConfig({ agentEnabled: enabled }); writeConnection();
      if (!enabled) command({ method: 'recording.status', owner: 'local' }).then(status => {
        if (status.owner && status.owner !== 'local' && ['starting', 'recording', 'paused'].includes(status.state))
          return command({ method: 'recording.stop', owner: 'local' }, 3600000);
      }).catch(() => {});
      emit('recorder:integrationChanged', state()); return state();
    },
    close() { enabled = false; generation++; server.close(); try { writeConnection(); } catch {} },
  };
}
module.exports = { createAgentService };
