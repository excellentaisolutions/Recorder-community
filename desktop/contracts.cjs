const { z } = require('zod');

const id = z.string().uuid();
const config = z.object({
  outputDir: z.string().min(1).max(4096).optional(),
  fps: z.number().refine(value => [15, 24, 25, 30, 50, 60, 120].includes(value)).optional(),
  format: z.enum(['mp4', 'webm', 'mkv', 'avi', 'mp3', 'wav']).optional(),
  codec: z.enum(['h264', 'hevc', 'av1']).optional(),
  quality: z.enum(['high', 'balanced', 'small']).optional(),
  mode: z.enum(['screen', 'window', 'region', 'device', 'audio', 'scene']).optional(),
  countdown: z.number().min(0).max(10).optional(),
  systemAudio: z.boolean().optional(), microphone: z.boolean().optional(),
  webcamOverlay: z.boolean().optional(), camera: z.boolean().optional(),
  minimizeOnRecord: z.boolean().optional(),
  hotkeys: z.object({ record: z.string().max(64), pause: z.string().max(64), screenshot: z.string().max(64) }).partial().optional(),
}).catchall(z.unknown()).refine(value => JSON.stringify(value).length <= 32768, 'Configuración demasiado grande');
const file = z.string().min(1).max(32767);
const chunk = z.custom(value => value instanceof ArrayBuffer || ArrayBuffer.isView(value), 'Fragmento no válido').refine(value => value.byteLength <= 64 * 1024 * 1024, 'Fragmento demasiado grande');
const exportOptions = z.object({ format: z.enum(['mp4', 'webm', 'mkv', 'avi', 'mp3', 'wav']), codec: z.enum(['h264', 'hevc', 'av1']).default('h264'), quality: z.enum(['high', 'balanced', 'small']).default('balanced'), fps: z.coerce.number().refine(value => [15, 24, 25, 30, 50, 60, 120].includes(value)).default(30) }).strict();
const empty = z.tuple([]);
const schemas = {
  integrationStatus: empty, integrationCancel: empty, integrationSet: z.tuple([z.object({ enabled: z.boolean(), rotate: z.boolean() }).strict()]),
  getConfig: empty, saveConfig: z.tuple([config]), chooseFolder: empty, listSources: empty,
  selectSource: z.tuple([z.string().min(1).max(256)]),
  startFile: z.tuple([z.object({ extension: z.literal('webm'), kind: z.enum(['video', 'audio']) }).strict()]),
  appendChunk: z.tuple([id, chunk]), finishFile: z.tuple([id, exportOptions]), abortFile: z.tuple([id]),
  saveScreenshot: z.tuple([z.string().max(100 * 1024 * 1024).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/), z.enum(['png', 'jpeg'])]),
  listFiles: empty, openFile: z.tuple([file]), revealFile: z.tuple([file]), deleteFile: z.tuple([file]),
  openFolder: empty, minimize: empty, close: empty, getStatus: empty,
  getHotkeys: empty, resetHotkeys: empty, suspendHotkeys: z.tuple([z.boolean()]),
  setHotkey: z.tuple([z.enum(['record', 'pause', 'screenshot']), z.string().max(64)]),
};

function parseArgs(name, args) {
  const result = schemas[name].safeParse(args);
  if (!result.success) throw new Error(`Solicitud no válida (${name}): ${result.error.issues.map(issue => issue.message).join('; ')}`);
  return result.data;
}

module.exports = { parseArgs, configSchema: config };
