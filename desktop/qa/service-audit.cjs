const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAgentService } = require('../agents/service.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-service-audit-'));
const report = { checks: [], failures: [] };
const service = createAgentService({ app: { getPath: () => temp, getAppPath: () => temp }, storage: { getConfig: () => ({ agentEnabled: true }), saveConfig: () => {} },
  listSources: async () => [], command: async () => ({ state: 'idle' }), emit: () => {}, speech: async () => ({ name: 'qa.wav' }) });
(async () => {
  await service.start(); const { port, token } = JSON.parse(fs.readFileSync(path.join(temp, 'agent-connection.json')));
  async function call(method, params = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ client: 'audit', requestId: crypto.randomUUID(), method, params }) });
    return res.json();
  }
  try {
    for (let i = 0; i < 100; i++) assert((await call('schedule.create', { at: new Date(Date.now() + 600000).toISOString(), capture: { sourceId: 'screen:1:0' } })).result);
    assert.match((await call('narration.create', { text: 'test' })).error, /Demasiados/);
    service.cancel(); await service.settle();
    const retry = await call('narration.create', { text: 'test' });
    assert(retry.result?.jobId, `Media lock remains after quota rejection: ${retry.error}`);
    await service.settle();
    report.checks.push('Job quota rejection does not poison subsequent media jobs'); report.status = 'passed';
  } catch (error) { report.failures.push(error.message); report.status = 'failed'; process.exitCode = 1; }
  finally { service.cancel(); await service.settle(); service.close(); if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-service-audit-')) fs.rmSync(temp, { recursive: true, force: true }); }
  fs.writeFileSync(path.join(__dirname, 'artifacts/service-audit-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(e => { console.error(e); process.exitCode = 1; });
