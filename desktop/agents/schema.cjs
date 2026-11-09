const { z } = require('zod');
const empty = z.object({}).strict();
const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, 'Región fuera de la fuente');
const session = z.object({ sessionId: z.string().uuid() }).strict();
const scene = z.object({
  items: z.array(z.object({ sourceId: z.string().min(1).max(256), label: z.string().max(100).default(''), region: region.optional() }).strict()).min(2).max(4)
    .refine(items => new Set(items.map(item => item.sourceId)).size === items.length, 'Fuentes duplicadas'),
  layout: z.enum(['horizontal', 'vertical', 'grid']).default('horizontal'),
  width: z.number().int().min(320).max(3840).multipleOf(2).default(1920), height: z.number().int().min(240).max(2160).multipleOf(2).default(1080),
}).strict();
const capture = z.object({
  mode: z.enum(['screen', 'window', 'region', 'device', 'audio', 'scene']).default('screen'),
  scene: scene.optional(),
  sourceId: z.string().max(256).optional(), region: region.optional(),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
  format: z.enum(['mp4', 'webm', 'mkv', 'avi', 'mp3', 'wav']).optional(),
  codec: z.enum(['h264', 'hevc', 'av1']).default('h264'), quality: z.enum(['high', 'balanced', 'small']).default('balanced'),
  systemAudio: z.boolean().default(false), microphone: z.boolean().default(false),
  microphoneId: z.string().max(256).optional(), cameraId: z.string().max(256).optional(),
  webcamOverlay: z.boolean().default(false), textOverlay: z.string().max(150).default(''),
  countdown: z.number().int().min(0).max(10).default(0), autoStop: z.number().int().min(0).max(86400).default(0),
  screenshotFormat: z.enum(['png', 'jpeg']).default('png'), sessionId: z.string().uuid().optional(),
}).strict();
const target = z.object({ role: z.string().max(80).optional(), name: z.string().max(300).optional(), testId: z.string().max(150).optional(), selector: z.string().max(500).optional() }).strict()
  .refine(t => Boolean(t.role || t.testId || t.selector), 'Se requiere role, testId o selector');
const step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), target }).strict(),
  z.object({ action: z.literal('fill'), target, value: z.string().max(10000) }).strict(),
  z.object({ action: z.literal('wait'), target }).strict(),
  z.object({ action: z.literal('expectText'), target, text: z.string().max(1000) }).strict(),
  z.object({ action: z.literal('hold'), milliseconds: z.number().int().min(0).max(10000) }).strict(),
  z.object({ action: z.literal('mark'), label: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('frame'), target, label: z.string().min(1).max(200), padding: z.number().min(0).max(100).default(16) }).strict(),
  z.object({ action: z.literal('screenshot'), target: target.optional() }).strict(),
]);
const viewId = z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/);
const routedStep = z.discriminatedUnion('action', step.options.map(option => option.extend({ view: viewId })));
const webUrl = z.url().refine(url => ['http:', 'https:'].includes(new URL(url).protocol));
const preferenceFields = Object.fromEntries(Object.entries(capture.shape)
  .filter(([key]) => !['sessionId', 'format'].includes(key))
  .map(([key, value]) => [key, (value instanceof z.ZodDefault ? value.removeDefault() : value).optional()]));
const schemas = {
  'capabilities.get': empty,
  'devices.list': empty,
  'settings.get': empty,
  'settings.update': z.object(preferenceFields).extend({
    videoFormat: z.enum(['mp4', 'webm', 'mkv', 'avi']).optional(), audioFormat: z.enum(['mp3', 'wav', 'webm']).optional(),
    minimizeOnStart: z.boolean().optional(),
  }).strict(),
  'schedule.create': z.object({ at: z.iso.datetime({ offset: true }), capture }).strict(),
  'sources.list': empty,
  'source.preview': z.object({ sourceId: z.string().max(256) }).strict(),
  'recording.start': capture,
  'recording.status': empty,
  'recording.pause': session, 'recording.resume': session, 'recording.stop': session,
  'recording.mark': session.extend({ label: z.string().min(1).max(200) }),
  'screenshot.capture': capture,
  'jobs.status': z.object({ jobId: z.string().uuid() }).strict(),
  'jobs.cancel': z.object({ jobId: z.string().uuid() }).strict(),
  'artifacts.list': empty,
  'voices.list': empty,
  'narration.create': z.object({ text: z.string().min(1).max(10000), voice: z.string().min(1).max(200).optional(), rate: z.number().int().min(-5).max(5).default(0) }).strict(),
  'demo.run': z.object({ url: z.url().refine(url => ['http:', 'https:'].includes(new URL(url).protocol)),
    browser: z.enum(['chrome', 'msedge']).default('msedge'),
    width: z.number().int().min(640).max(2560).default(1280), height: z.number().int().min(480).max(1440).default(720),
    steps: z.array(step).min(1).max(100), title: z.string().max(120).default('Demo Recorder'),
    format: z.enum(['mp4', 'webm']).default('mp4'),
  }).strict(),
  'demo.multiview': z.object({
    views: z.array(z.object({ id: viewId, label: z.string().min(1).max(50), url: webUrl, setup: z.array(step).max(30).default([]) }).strict()).length(2),
    browser: z.enum(['chrome', 'msedge']).default('msedge'),
    width: z.number().int().min(640).max(1920).multipleOf(2).default(960),
    height: z.number().int().min(480).max(1080).multipleOf(2).default(540),
    layout: z.enum(['horizontal', 'vertical']).default('horizontal'),
    title: z.string().max(120).default('Demo multipantalla'),
    steps: z.array(z.union([routedStep, z.object({ action: z.literal('parallel'), steps: z.array(routedStep).length(2) }).strict()])).min(1).max(100),
  }).strict().superRefine((recipe, context) => {
    const ids = new Set(recipe.views.map(view => view.id));
    if (ids.size !== 2) context.addIssue({ code: 'custom', message: 'Las sesiones deben tener ids diferentes' });
    for (const step of recipe.steps) {
      const actions = step.action === 'parallel' ? step.steps : [step];
      if (actions.some(action => !ids.has(action.view))) context.addIssue({ code: 'custom', message: 'Paso dirigido a una sesión inexistente' });
      if (actions.length === 2 && actions[0].view === actions[1].view) context.addIssue({ code: 'custom', message: 'Las acciones paralelas deben usar sesiones distintas' });
    }
  }),
  'media.compose': z.object({ clips: z.array(z.object({ file: z.string().min(1).max(32767),
    start: z.number().min(0).max(86400).default(0), duration: z.number().positive().max(3600),
    region: region.optional(), title: z.string().max(150).default('') }).strict()).min(1).max(30),
    width: z.number().int().min(320).max(3840).multipleOf(2).default(1280),
    height: z.number().int().min(240).max(2160).multipleOf(2).default(720),
    branding: z.boolean().default(false), narration: z.string().max(32767).optional(),
    subtitles: z.array(z.object({ start: z.number().min(0), end: z.number().positive(), text: z.string().max(500) }).strict().refine(s => s.end > s.start)).max(200).default([]),
  }).strict(),
};
const descriptions = {
  'capabilities.get': 'Discover actual monitors, installed demo browsers, supported operations and platform limitations. Refresh when displays change.',
  'devices.list': 'Enumerate Windows camera/capture-card and microphone inputs. Device ids belong to this profile; missing labels can indicate device permissions.',
  'settings.get': 'Read current capture preferences and output folder.',
  'settings.update': 'Update persistent capture preferences and refresh the app UI. Only while idle; access credentials and output folder are not changed.',
  'schedule.create': 'Schedule one capture at an ISO date with timezone, within 24 days. App and Windows session must remain open. Returns cancellable job; completion contains the started session id. Revoking access cancels pending schedules.',
  'sources.list': 'List capture sources. Window geometry is unknown until capture; normalized regions avoid thumbnail coordinates.',
  'source.preview': 'Return a source thumbnail as image data. Not full-resolution geometry.',
  'recording.start': 'Start recording and return only when recording. autoStop is seconds of active recording; 0 means unlimited. Save returned session id.',
  'recording.status': 'Get current state, owner, active elapsed time, dimensions, marks and last artifact.',
  'recording.pause': 'Pause your recording session.', 'recording.resume': 'Resume your recording session.',
  'recording.stop': 'Stop your session. Returns a job; poll jobs.status until completed to get the exported artifact.',
  'recording.mark': 'Add an editing marker at current active recording time.',
  'screenshot.capture': 'Capture PNG/JPEG. During recording supply your sessionId; current capture composition is used.',
  'jobs.status': 'Get completion, result or error for your export/demo/montage job.',
  'jobs.cancel': 'Cancel your demo or montage job. Recording exports finish to preserve media.',
  'artifacts.list': 'List local captures and exports in Recorder output folder.',
  'voices.list': 'List installed Windows speech voices; entirely local.',
  'narration.create': 'Synthesize narration as WAV using an installed Windows voice. Defaults to a Spanish voice when available. Returns job.',
  'demo.run': 'Run a declarative Playwright demo in a separate browser. Records the browser viewport, not the desktop; no computer use. Returns job.',
  'demo.multiview': 'Record two isolated browser sessions (e.g. customer/admin) on a shared timeline. Steps target a view id; parallel groups run one action per view. Returns split-screen MP4 plus separate originals, marks and timing metadata. Setup actions run before capture.',
  'media.compose': 'Make a new MP4 from local Recorder videos, trims/crops/titles, EAS logo, subtitles and optional local narration audio. Sources preserved. Returns job.',
};
const envelope = z.object({ method: z.enum(Object.keys(schemas)), params: z.record(z.string(), z.unknown()).default({}),
  client: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/), requestId: z.string().uuid() }).strict();
function parse(method, params) {
  if (!schemas[method]) throw new Error('Método desconocido');
  const result = schemas[method].parse(params);
  const capture = method === 'schedule.create' ? result.capture : ['recording.start', 'screenshot.capture'].includes(method) ? result : null;
  if (capture) {
    capture.format ||= capture.mode === 'audio' ? 'mp3' : 'mp4';
    if (capture.mode === 'audio' ? !['mp3', 'wav', 'webm'].includes(capture.format) : ['mp3', 'wav'].includes(capture.format))
      throw new Error('El formato no corresponde al modo de captura.');
    if (capture.mode === 'region' && !capture.region) throw new Error('Selecciona un área de grabación.');
    if (capture.mode === 'scene' && !capture.scene) throw new Error('Selecciona las fuentes de la composición.');
  }
  return result;
}
function tools() { return Object.entries(schemas).map(([name, schema]) => ({ name: name.replaceAll('.', '_'), description: descriptions[name], inputSchema: z.toJSONSchema(schema, { unrepresentable: 'any' }) })); }
module.exports = { schemas, parse, envelope, tools, descriptions };
