const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
function connectionPath() {
  return process.env.RECORDER_CONNECTION || path.join(process.env.RECORDER_USER_DATA || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Recorder'), 'agent-connection.json');
}
async function call(method, params = {}, options = {}) {
  let config;
  try { config = JSON.parse(fs.readFileSync(connectionPath(), 'utf8')); }
  catch { throw new Error('Abre Recorder y activa Integraciones IA. No se encontró la conexión local.'); }
  if (!config.enabled) throw new Error('Las integraciones IA están desactivadas en Recorder.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Conexión local inválida. Reinicia Recorder.');
  const response = await fetch(`http://127.0.0.1:${config.port}/call`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({ method, params, client: options.client || process.env.RECORDER_CLIENT || 'default-agent', requestId: options.requestId || crypto.randomUUID() }),
    signal: AbortSignal.timeout(65000),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data.result;
}
module.exports = { call, connectionPath };
