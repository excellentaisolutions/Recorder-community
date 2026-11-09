const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { encoderPath } = require('../exporter.cjs');

function transcode(app, args, allowed = () => true, cwd) {
  return new Promise((resolve, reject) => {
    if (!allowed()) return reject(new Error('Trabajo cancelado.'));
    const child = spawn(encoderPath(app), ['-hide_banner', '-nostdin', '-n', ...args], { windowsHide: true, cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '', cancelled = false;
    const poll = setInterval(() => { if (!allowed()) { cancelled = true; child.kill(); } }, 250);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-5000); });
    child.once('error', error => { clearInterval(poll); reject(error); });
    child.once('close', code => { clearInterval(poll); code === 0 ? resolve() : reject(new Error(cancelled ? 'Trabajo cancelado; fuentes conservadas.' : `FFmpeg ${code}: ${stderr}`)); });
  });
}

function timestamp(value) {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

async function compose(app, storage, options, allowed) {
  const inputs = options.clips.map(clip => ({ ...clip, file: storage.authorizedFile(clip.file) }));
  if (inputs.some(clip => !/\.(mp4|mkv|webm|avi)$/i.test(clip.file))) throw new Error('Los clips deben ser vídeos de la biblioteca.');
  const narration = options.narration && storage.authorizedFile(options.narration);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-compose-'));
  const output = storage.freshPath('mp4');
  try {
    fs.copyFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeui.ttf'), path.join(temp, 'font.ttf'));
    fs.copyFileSync(path.join(app.getAppPath(), 'assets', 'recorder.png'), path.join(temp, 'logo.png'));
    for (let index = 0; index < inputs.length; index++) {
      const clip = inputs[index];
      const ffprobe = app.isPackaged ? path.join(process.resourcesPath, 'ffprobe.exe') : path.join(app.getAppPath(), 'bin', 'ffprobe.exe');
      const inspected = await promisify(execFile)(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', clip.file], { windowsHide: true, timeout: 15000 });
      const media = JSON.parse(inspected.stdout);
      const sourceDuration = Number(media.format.duration);
      if (!media.streams.some(s => s.codec_type === 'video') || !Number.isFinite(sourceDuration) || clip.start >= sourceDuration)
        throw new Error('Clip sin vídeo o inicio fuera de su duración.');
      const duration = Math.min(clip.duration, sourceDuration - clip.start);
      const hasAudio = media.streams.some(s => s.codec_type === 'audio');
      const filters = [];
      if (clip.region) {
        const r = clip.region;
        filters.push(`crop=trunc(iw*${r.width}/2)*2:trunc(ih*${r.height}/2)*2:iw*${r.x}:ih*${r.y}`);
      }
      filters.push(`scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease`,
        `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:color=0x171b21`, 'setsar=1', 'fps=30');
      if (clip.title) {
        fs.writeFileSync(path.join(temp, `title-${index}.txt`), clip.title);
        filters.push(`drawtext=fontfile=font.ttf:textfile=title-${index}.txt:expansion=none:fontcolor=white:fontsize=28:box=1:boxcolor=black@0.65:boxborderw=12:x=24:y=24`);
      }
      await transcode(app, ['-ss', String(clip.start), '-i', clip.file,
        ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []), '-t', String(duration),
        '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
        '-vf', filters.join(','), '-af', 'apad', '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path.join(temp, `clip-${index}.mp4`)], allowed, temp);
    }
    fs.writeFileSync(path.join(temp, 'clips.txt'), inputs.map((_, i) => `file 'clip-${i}.mp4'`).join('\n'));
    const args = ['-f', 'concat', '-safe', '1', '-i', 'clips.txt'];
    let index = 1, filter = '[0:v]null[v0]', label = 'v0';
    if (options.branding) {
      args.push('-i', 'logo.png');
      filter += `;[${index++}:v]scale=54:54[logo];[${label}][logo]overlay=W-w-20:H-h-20[v1]`;
      label = 'v1';
    }
    if (options.subtitles.length) {
      fs.writeFileSync(path.join(temp, 'captions.srt'), options.subtitles.map((s, i) => `${i + 1}\n${timestamp(s.start)} --> ${timestamp(s.end)}\n${s.text.replace(/\r?\n\r?\n/g, '\n')}\n`).join('\n'));
      for (let n = 0; n < options.subtitles.length; n++) {
        const subtitle = options.subtitles[n];
        fs.writeFileSync(path.join(temp, `subtitle-${n}.txt`), subtitle.text);
        filter += `;[${label}]drawtext=fontfile=font.ttf:textfile=subtitle-${n}.txt:expansion=none:fontcolor=white:fontsize=24:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-tw)/2:y=h-th-30:enable='between(t,${subtitle.start},${subtitle.end})'[sub${n}]`;
        label = `sub${n}`;
      }
    }
    if (narration) {
      args.push('-i', narration);
      filter += `;[0:a]volume=0.25[bed];[${index}:a]apad[voice];[bed][voice]amix=inputs=2:duration=first:normalize=0[audio]`;
    }
    args.push('-filter_complex', filter, '-map', `[${label}]`);
    args.push('-map', narration ? '[audio]' : '0:a:0', '-c:a', 'aac');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
    await transcode(app, args, allowed, temp);
    if (!fs.statSync(output).size) throw new Error('Montaje vacío.');
    return { artifact: storage.fileEntry(output), originalAudio: true, narration: Boolean(narration), sourceFiles: inputs.map(c => c.file) };
  } finally {
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('recorder-compose-')) fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { compose, transcode };
