import { packager } from '@electron/packager';
import { existsSync, writeFileSync, cpSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'bin/ffmpeg.exe'))) throw new Error('Falta desktop/bin/ffmpeg.exe. Ejecuta prepare-tools.ps1 antes de empaquetar.');
const output = await packager({
  dir: root, name: 'Recorder', executableName: 'Recorder', platform: 'win32', arch: 'x64',
  out: path.resolve(root, '../dist'), overwrite: true, asar: true,
  icon: path.join(root, 'assets/recorder.ico'),
  appVersion: '1.1.1', appCopyright: 'Copyright 2026 Oscar Garcia · Apache-2.0',
  win32metadata: { CompanyName: 'Recorder', FileDescription: 'Recorder — estudio de captura', ProductName: 'Recorder', InternalName: 'Recorder' },
  ignore: [/^\/qa($|\/)/, /^\/scripts($|\/)/, /^\/bin($|\/)/, /^\/tsconfig/, /^\/package-lock\.json$/, /^\/electron-builder\.json$/],
  extraResource: [path.join(root, 'bin/ffmpeg.exe'), path.join(root, 'bin/ffprobe.exe'), path.join(root, 'bin/playwright')],
});
for (const directory of output) {
  cpSync(path.join(root, 'agent-skill'), path.join(directory, 'skills'), { recursive: true });
  cpSync(path.join(root, 'examples'), path.join(directory, 'examples'), { recursive: true });
  cpSync(path.join(root, 'licenses'), path.join(directory, 'licenses'), { recursive: true });
  copyFileSync(path.join(root, 'bin/playwright/ffmpeg-1013/COPYING.LGPLv2.1'), path.join(directory, 'licenses/Playwright-FFmpeg-LGPLv2.1.txt'));
  for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) copyFileSync(path.resolve(root, '..', name), path.join(directory, 'licenses', name === 'LICENSE' ? 'Recorder-LICENSE.txt' : name));
  writeFileSync(path.join(directory, 'INTEGRACIONES-IA.txt'), 'RECORDER 1.1 — INTEGRACIONES IA\r\n\r\nAbre Recorder y activa Integraciones IA. Copia la configuración MCP al cliente de tu agente. No requiere Node externo.\r\nSkill portable: skills/recorder-control/SKILL.md\r\nRecetas de ejemplo: examples/demo.json y examples/multiview.json (adaptar URLs y controles).\r\nCLI: Recorder.exe --cli tools\r\nLos agentes cloud necesitan un puente local: no se abre acceso público.\r\n');
  writeFileSync(path.join(directory, 'LEEME.txt'), 'RECORDER PARA WINDOWS\r\n\r\nAbre Recorder.exe. No necesita Node ni servidor web.\r\nMantén todos los archivos de esta carpeta juntos.\r\nAtajos por defecto: F9 grabar/detener · F10 pausar/reanudar · F11 captura.\r\nSi chocan con Windows u otra aplicación, cámbialos en General › Atajos de teclado.\r\nLicencias: carpeta licenses (Recorder bajo Apache 2.0; FFmpeg bajo GPLv3).\r\n');
}
console.log(JSON.stringify({ packaged: output }));
