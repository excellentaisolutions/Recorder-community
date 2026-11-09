const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function speech(app, storage, options, allowed = () => true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-speech-'));
  const output = options.action === 'voices' ? undefined : storage.freshPath('wav');
  try {
    fs.copyFileSync(path.join(app.getAppPath(), 'agents', 'speech.ps1'), path.join(temp, 'speech.ps1'));
    fs.writeFileSync(path.join(temp, 'input.json'), JSON.stringify({ ...options, output }));
    const data = await new Promise((resolve, reject) => {
      const executable = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(temp, 'speech.ps1'), '-InputFile', path.join(temp, 'input.json')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const deadline = Date.now() + 120000;
      const poll = setInterval(() => { if (!allowed() || Date.now() > deadline) child.kill(); }, 250);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
      child.once('error', error => { clearInterval(poll); reject(error); });
      child.once('close', code => {
        clearInterval(poll);
        if (code !== 0) return reject(new Error(`No se completó la voz local: ${stderr || 'cancelada o tiempo agotado'}`));
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch (error) { reject(error); }
      });
    });
    return output ? { artifact: storage.fileEntry(output), ...data, provider: 'Windows System.Speech (local)' } : data;
  } finally {
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-speech-')) fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { speech };
