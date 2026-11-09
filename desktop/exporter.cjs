const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function encoderPath(app) {
  const candidates = [path.join(process.resourcesPath || '', 'ffmpeg.exe'), path.join(process.resourcesPath || '', 'bin', 'ffmpeg.exe'), path.join(app.getAppPath().replace(/\.asar$/, '.asar.unpacked'), 'bin', 'ffmpeg.exe'), path.join(__dirname, 'bin', 'ffmpeg.exe')];
  return candidates.find(file => fs.existsSync(file)) || 'ffmpeg';
}

function exportArgs(input, output, options, kind) {
  const { format, codec = 'h264', quality = 'balanced', fps = 30 } = options || {};
  if (!['mp4', 'webm', 'mkv', 'avi', 'mp3', 'wav'].includes(format) || !['h264', 'hevc', 'av1'].includes(codec) || !['high', 'balanced', 'small'].includes(quality) || ![15, 24, 25, 30, 50, 60, 120].includes(Number(fps))) throw new Error('Opciones de exportación no válidas.');
  if (kind === 'audio' && !['mp3', 'wav', 'webm'].includes(format)) throw new Error('Selecciona MP3, WAV o WebM para grabar audio.');
  const args = ['-hide_banner', '-nostdin', '-n', '-i', input];
  if (['mp3', 'wav'].includes(format)) args.push('-vn', '-c:a', format === 'mp3' ? 'libmp3lame' : 'pcm_s16le', ...(format === 'mp3' ? ['-b:a', '192k'] : []));
  else if (format === 'webm') args.push('-c', 'copy');
  else {
    const crf = { high: '18', balanced: '23', small: '28' }[quality];
    const encoder = format === 'avi' ? 'mpeg4' : { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' }[codec];
    args.push('-map', '0:v:0', '-map', '0:a?', '-c:v', encoder, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', String(fps), '-pix_fmt', 'yuv420p');
    if (format === 'avi') args.push('-q:v', quality === 'high' ? '3' : quality === 'small' ? '8' : '5');
    else args.push('-crf', crf, '-preset', codec === 'av1' ? '10' : 'veryfast');
    args.push('-c:a', format === 'avi' ? 'libmp3lame' : 'aac', '-b:a', '192k');
    if (format === 'mp4') args.push('-movflags', '+faststart');
    if (codec === 'hevc' && format === 'mp4') args.push('-tag:v', 'hvc1');
  }
  return [...args, '-progress', 'pipe:1', output];
}

async function finishFile(app, storage, id, options, report) {
  const pending = storage.sessions.get(id);
  if (!pending) throw new Error('La sesión de grabación no existe.');
  if (pending.finalizing) throw new Error('La grabación ya se está exportando.');
  pending.finalizing = true;
  let recording;
  try {
    recording = await storage.seal(id);
    const output = storage.freshPath(options?.format || 'mp4');
    recording.output = output;
    const args = exportArgs(recording.file, output, options, recording.kind);
    if (options.format === 'webm') {
      storage.sessions.delete(id);
      return { ...storage.fileEntry(recording.file), kind: recording.kind };
    }
    await new Promise((resolve, reject) => {
      const child = spawn(encoderPath(app), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      recording.process = child;
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
      child.stdout.on('data', chunk => report?.({ id, status: 'exporting', detail: chunk.toString().slice(-2000) }));
      child.once('error', error => reject(new Error(`No se pudo iniciar FFmpeg: ${error.message}. Original conservado: ${recording.file}`)));
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg terminó con código ${code}. Original conservado: ${recording.file}. ${stderr.slice(-1800)}`)));
    });
    if (!fs.existsSync(output) || !fs.statSync(output).size) throw new Error(`La exportación está vacía. Original conservado: ${recording.file}`);
    await fs.promises.unlink(recording.file);
    storage.sessions.delete(id);
    return storage.fileEntry(output);
  } catch (error) {
    storage.sessions.delete(id);
    throw error;
  }
}

module.exports = { encoderPath, exportArgs, finishFile };
