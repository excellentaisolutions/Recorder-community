const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { configSchema } = require('./contracts.cjs');

const mediaExtensions = new Set(['.mp4', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.png', '.jpg', '.jpeg']);
const defaults = { fps: 30, format: 'mp4', codec: 'h264', quality: 'balanced', systemAudio: true, microphone: false, camera: false, countdown: 3, autoStop: 0 };

function safeObject(value, depth = 0) {
  if (depth > 5) throw new Error('Configuración demasiado compleja.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 4096) return value;
  if (Array.isArray(value)) {
    if (value.length > 16) throw new Error('Lista de configuración demasiado grande.');
    return value.map(item => safeObject(item, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new Error('Configuración no válida.');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('Clave no válida.');
    result[key] = safeObject(item, depth + 1);
  }
  return result;
}

function createStorage(app) {
  const configPath = path.join(app.getPath('userData'), 'settings.json');
  let config = { ...defaults, outputDir: path.join(app.getPath('videos'), 'Recorder') };
  const warnings = [];
  let preserveFailure = false;
  try { config = { ...config, ...configSchema.parse(safeObject(JSON.parse(fs.readFileSync(configPath, 'utf8')))) }; }
  catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${configPath}.invalid-${Date.now()}.bak`;
      try { fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL); warnings.push(`La configuración no se pudo leer. Se usan valores iniciales y se conserva una copia en ${backup}.`); }
      catch { preserveFailure = true; warnings.push('La configuración no se pudo leer ni respaldar. No se sobrescribirá; comprueba los permisos de la carpeta de configuración.'); }
    }
  }
  function writableDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error('Selecciona una carpeta absoluta válida.');
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.recorder-write-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(probe, 'wx');
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  }
  try { writableDirectory(config.outputDir); }
  catch (error) {
    warnings.push(`No se puede usar la carpeta configurada: ${error.message}`);
    const candidates = [path.join(app.getPath('videos'), 'Recorder'), path.join(app.getPath('documents'), 'Recorder'), path.join(app.getPath('userData'), 'Recordings')];
    let found = false;
    for (const directory of candidates) {
      try { writableDirectory(directory); config.outputDir = directory; found = true; break; } catch {}
    }
    if (!found) throw new Error('No se encontró una carpeta con permisos para guardar grabaciones.');
    warnings.push(`Carpeta alternativa: ${config.outputDir}`);
  }
  const sessions = new Map();
  let starting = false;

  function saveConfig(input) {
    if (preserveFailure) throw new Error('La configuración anterior no se puede respaldar. Corrige los permisos antes de guardar cambios.');
    if (JSON.stringify(input).length > 32768) throw new Error('Configuración demasiado grande.');
    const next = { ...config, ...configSchema.parse(safeObject(input)) };
    if (next.outputDir !== config.outputDir && (starting || sessions.size)) throw new Error('No se puede cambiar de carpeta durante una grabación o exportación.');
    writableDirectory(next.outputDir);
    const temp = `${configPath}.${crypto.randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, configPath);
    config = next;
    return config;
  }

  function fileEntry(file) {
    const stat = fs.statSync(file);
    const ext = path.extname(file).toLowerCase();
    let kind = ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : ['.mp3', '.wav'].includes(ext) ? 'audio' : 'video';
    if (ext === '.webm') {
      try { if (JSON.parse(fs.readFileSync(`${file}.session.json`, 'utf8')).artifact?.kind === 'audio') kind = 'audio'; } catch {}
    }
    return { name: path.basename(file), path: file, size: stat.size, modified: stat.mtime.toISOString(), kind };
  }

  function authorizedFile(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Archivo no válido.');
    const real = fs.realpathSync(file);
    const base = fs.realpathSync(config.outputDir);
    if (path.dirname(real).toLowerCase() !== base.toLowerCase() || !mediaExtensions.has(path.extname(real).toLowerCase())) throw new Error('El archivo debe pertenecer a la carpeta de grabaciones.');
    if (!fs.statSync(real).isFile()) throw new Error('No es un archivo.');
    return real;
  }

  function freshPath(extension) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(config.outputDir, `Recorder-${stamp}-${crypto.randomBytes(3).toString('hex')}.${extension}`);
  }

  async function startFile(options) {
    if (starting || sessions.size) throw new Error('Ya hay una grabación o exportación en curso.');
    if (!options || options.extension !== 'webm' || !['video', 'audio'].includes(options.kind)) throw new Error('Formato de captura no válido.');
    starting = true;
    try {
      const file = freshPath('webm');
      const handle = await fs.promises.open(file, 'wx');
      const id = crypto.randomUUID();
      sessions.set(id, { id, file, handle, kind: options.kind, queue: Promise.resolve(), closed: false, bytes: 0, error: null });
      return { id };
    } finally { starting = false; }
  }

  function getSession(id) {
    const recording = sessions.get(id);
    if (!recording) throw new Error('La sesión de grabación no existe.');
    return recording;
  }

  async function appendChunk(id, bytes) {
    const recording = getSession(id);
    if (recording.closed) throw new Error('La grabación ya está cerrada.');
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new Error('Fragmento de vídeo no válido.');
    const data = bytes instanceof ArrayBuffer ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.length > 64 * 1024 * 1024) throw new Error('Fragmento demasiado grande.');
    recording.queue = recording.queue.then(async () => {
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await recording.handle.write(data, offset, data.length - offset);
        if (!bytesWritten) throw new Error('No se pudo escribir el vídeo.');
        offset += bytesWritten;
      }
      recording.bytes += data.length;
    });
    try { await recording.queue; } catch (error) {
      recording.error = error;
      recording.closed = true;
      try { if (recording.handle) await recording.handle.close(); } catch {}
      recording.handle = null;
      sessions.delete(id);
      throw new Error(`${error.message}. Captura parcial conservada: ${recording.file}`);
    }
    return { bytes: recording.bytes };
  }

  async function seal(id) {
    const recording = getSession(id);
    recording.closed = true;
    try { await recording.queue; } finally { if (recording.handle) { await recording.handle.close(); recording.handle = null; } }
    if (recording.error) throw recording.error;
    if (!recording.bytes) throw new Error('La grabación está vacía.');
    return recording;
  }

  async function abortFile(id) {
    const recording = getSession(id);
    if (recording.finalizing) throw new Error('Espera a que termine la exportación.');
    recording.closed = true;
    try { await recording.queue; } catch {}
    if (recording.handle) await recording.handle.close();
    sessions.delete(id);
    if (!recording.bytes) await fs.promises.unlink(recording.file);
    return { preserved: recording.bytes > 0 ? recording.file : null };
  }

  async function saveScreenshot(dataURL, format) {
    if (!['png', 'jpeg'].includes(format) || typeof dataURL !== 'string' || dataURL.length > 100 * 1024 * 1024) throw new Error('Captura no válida.');
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataURL);
    if (!match || match[1] !== format) throw new Error('Formato de imagen no válido.');
    const file = freshPath(format === 'jpeg' ? 'jpg' : 'png');
    await fs.promises.writeFile(file, Buffer.from(match[2], 'base64'), { flag: 'wx' });
    return fileEntry(file);
  }

  function listFiles() {
    const pending = new Set([...sessions.values()].flatMap(session => [session.file, session.output]));
    return fs.readdirSync(config.outputDir, { withFileTypes: true }).filter(item => item.isFile() && mediaExtensions.has(path.extname(item.name).toLowerCase()) && !pending.has(path.join(config.outputDir, item.name))).flatMap(item => {
      try { return [fileEntry(path.join(config.outputDir, item.name))]; }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }).sort((a, b) => b.modified.localeCompare(a.modified));
  }

  return { getConfig: () => ({ ...config }), getWarnings: () => [...warnings], isBusy: () => starting || sessions.size > 0, saveConfig, fileEntry, authorizedFile, freshPath, startFile, appendChunk, seal, abortFile, saveScreenshot, listFiles, sessions };
}

module.exports = { createStorage, safeObject };
