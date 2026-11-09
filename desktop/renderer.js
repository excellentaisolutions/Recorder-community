import { RecordingController } from './controller.js';
import { bindIntegrations } from './integrations.js';
import { captureSelection } from './capture-selection.js';
import { updateSelectionSummary } from './selection-summary.js';
import { bindHotkeys } from './hotkeys.js';

const api = window.recorder;
const engine = new RecordingController(api);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const defaults = { mode: 'screen', sourceId: '', fps: 30, systemAudio: true,
  microphone: false, microphoneId: '', cameraId: '', webcamOverlay: false,
  textOverlay: '', videoFormat: 'mp4', audioFormat: 'mp3', codec: 'h264',
  quality: 'balanced', countdown: 3, screenshotFormat: 'png', autoStop: 0,
  minimizeOnStart: false, scheduleAt: '' };
let settings = { ...defaults };
let sources = [];
let files = [];
let source = null;
let busy = true;
let saving = Promise.resolve();
let toastTimeout;
let scheduleTimer;
let screenshotBusy = false;
let selection;
let hotkeys;

function notify(message, error = false) {
  clearTimeout(toastTimeout);
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  toastTimeout = setTimeout(() => { toast.hidden = true; }, error ? 14000 : 6500);
}

function fail(error) {
  notify(error?.message || String(error), error?.name !== 'AbortError');
}

function persist() {
  const { agentEnabled, ...snapshot } = settings;
  saving = saving.catch(() => {}).then(() => api.saveConfig(snapshot));
  saving.catch(fail);
}

function page(name) {
  $('main').scrollTop = 0;
  $$('.page').forEach((section) => { section.hidden = section.id !== `page-${name}`; });
  $$('.nav-button').forEach((button) => {
    button.classList.toggle('selected', button.dataset.page === name);
    button.setAttribute('aria-current', button.dataset.page === name ? 'page' : 'false');
  });
}

function updateDuration() {
  const total = Math.min(86400, Math.max(0, Math.floor(Number(settings.autoStop) || 0)));
  const parts = { hours: Math.floor(total / 3600), minutes: Math.floor(total / 60) % 60, seconds: total % 60 };
  $$('[data-duration]').forEach(input => { input.value = String(parts[input.dataset.duration]); });
}

function changeDuration(input) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0 || value > Number(input.max)) {
    notify('Usa horas de 0 a 24 y minutos y segundos de 0 a 59, sin decimales.', true);
    updateDuration();
    return;
  }
  const total = $$('[data-duration]').reduce((sum, field) => sum + Number(field.value) * ({ hours: 3600, minutes: 60, seconds: 1 }[field.dataset.duration]), 0);
  if (total > 86400) {
    notify('La duración máxima es 24 horas.', true);
    updateDuration();
    return;
  }
  settings.autoStop = total;
  updateDuration();
  persist();
}

function updateSettings() {
  updateDuration();
  $$('[data-setting]').forEach((input) => {
    const value = settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (value !== undefined) {
      input.value = String(value);
      if (['cameraId', 'microphoneId'].includes(input.dataset.setting) && input.selectedIndex < 0) {
        input.add(new Option('Dispositivo no disponible — vuelve a seleccionar', value)); input.value = value;
      }
    }
  });
  $$('.mode-card').forEach((button) => {
    button.classList.toggle('selected', button.dataset.mode === settings.mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === settings.mode));
  });
  [['speaker-toggle', 'systemAudio'], ['mic-toggle', 'microphone']].forEach(([id, key]) => {
    $(`#${id}`).classList.toggle('active', settings[key]);
    $(`#${id}`).setAttribute('aria-pressed', String(Boolean(settings[key])));
  });
  $('#output-folder').textContent = settings.outputDir || 'Carpeta de vídeos de Windows';
  $('#output-folder').title = settings.outputDir || '';
  const formats = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };
  $('#footer-format').textContent = settings.mode === 'audio'
    ? `${settings.audioFormat.toUpperCase()} · Audio`
    : `${settings.videoFormat.toUpperCase()} · ${settings.videoFormat === 'webm' ? 'Original' : settings.videoFormat === 'avi' ? 'MPEG-4' : formats[settings.codec]} · ${settings.fps} FPS`;
  updateSourceLabel();
  const codecDisabled = !['mp4', 'mkv'].includes(settings.videoFormat) || settings.mode === 'audio';
  $('[data-setting="codec"]').disabled = codecDisabled;
  lockControls();
}

function updateSourceLabel() { updateSelectionSummary(settings, sources); }

function selectMode(mode) {
  if (busy || screenshotBusy || !['idle', 'error'].includes(engine.state)) return;
  if (['screen', 'window', 'region', 'scene'].includes(mode)) { openSources(mode).catch(fail); return; }
  settings.mode = mode;
  if (mode === 'device') { settings.systemAudio = false; settings.microphone = true; }
  if (mode === 'audio' && !settings.microphone && !settings.systemAudio) settings.systemAudio = true;
  updateSettings();
  persist();
  if (mode === 'device') { page('video'); refreshDevices('video').catch(fail); }
}

async function loadSources() {
  sources = await api.listSources();
  source = sources.find((item) => item.id === settings.sourceId) || null;
  updateSourceLabel();
  return sources;
}

async function openSources(mode = settings.mode) {
  if (busy || screenshotBusy || !['idle', 'error'].includes(engine.state)) return;
  if (mode === 'device' && !settings.systemAudio) { page('video'); return; }
  return selection.open(mode);
}

async function refreshDevices(kind) {
  let permissionStream;
  try {
    if (kind) permissionStream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [selector, deviceKind, key] of [['.camera-select', 'videoinput', 'cameraId'], ['.microphone-select', 'audioinput', 'microphoneId']]) {
      const select = $(selector);
      select.replaceChildren(new Option('Predeterminado', ''));
      devices.filter((device) => device.kind === deviceKind).forEach((device, index) => {
        select.add(new Option(device.label || `Dispositivo ${index + 1}`, device.deviceId));
      });
      select.value = settings[key];
      if (select.selectedIndex < 0) { select.add(new Option('Dispositivo no disponible — vuelve a seleccionar', settings[key])); select.value = settings[key]; }
    }
    updateSourceLabel();
    if (kind) notify('Dispositivos actualizados.');
  } finally { permissionStream?.getTracks().forEach((track) => track.stop()); }
}

function currentOptions() {
  return { ...settings, format: settings.mode === 'audio' ? settings.audioFormat : settings.videoFormat };
}

async function record() {
  if (busy || screenshotBusy) return;
  if (['recording', 'paused'].includes(engine.state)) return stop();
  if (!['idle', 'error'].includes(engine.state)) return;
  const needsSource = !['device', 'audio'].includes(settings.mode) || settings.systemAudio;
  if (needsSource && !settings.sourceId) { await openSources(); return; }
  if (settings.mode === 'region' && !settings.region) { await openSources(); return; }
  busy = true;
  lockControls();
  try {
    await loadSources();
    await engine.start(currentOptions());
    if (settings.minimizeOnStart && engine.state === 'recording') api.minimize();
  } catch (error) { fail(error); }
  finally { busy = false; lockControls(); }
}

async function stop() {
  if (busy || !['recording', 'paused'].includes(engine.state)) return;
  busy = true;
  lockControls();
  try { await engine.stop(); }
  catch (error) { fail(error); }
  finally { busy = false; lockControls(); }
}

function pause() {
  if (busy) return;
  try {
    if (engine.state === 'paused') engine.resume();
    else if (engine.state === 'recording') engine.pause();
  } catch (error) { fail(error); }
}

async function screenshot() {
  if (screenshotBusy || busy || ['starting', 'stopping'].includes(engine.state)) return;
  if (settings.mode === 'audio') { notify('Selecciona pantalla, ventana, área o cámara para capturar una imagen.', true); return; }
  if (settings.mode !== 'device' && !settings.sourceId) { await openSources(); return; }
  screenshotBusy = true;
  lockControls();
  try { const file = await engine.screenshot(currentOptions()); notify(`Imagen guardada: ${file?.name || 'captura'}`); await refreshLibrary(); }
  catch (error) { fail(error); }
  finally { screenshotBusy = false; lockControls(); }
}

function lockControls() {
  const active = !['idle', 'error'].includes(engine.state) || busy || screenshotBusy;
  $$('[data-setting], [data-duration], .mode-card, #source-button, #choose-source, #choose-folder, #speaker-toggle, #mic-toggle, #refresh-cameras, #refresh-devices, #audio-mode').forEach((button) => { button.disabled = active; });
  $('#record').disabled = busy || screenshotBusy || ['starting', 'stopping'].includes(engine.state);
  $('#pause').disabled = busy || !['recording', 'paused'].includes(engine.state);
  $('#snapshot').disabled = settings.mode === 'audio' || screenshotBusy || busy || ['starting', 'stopping'].includes(engine.state);
  $('#take-screenshot').disabled = $('#snapshot').disabled;
  $('#record').classList.toggle('is-recording', ['recording', 'paused'].includes(engine.state));
  $('#record').setAttribute('aria-label', ['recording', 'paused'].includes(engine.state) ? 'Detener grabación' : 'Iniciar grabación');
  $('#pause-icon').setAttribute('href', engine.state === 'paused' ? '#i-play' : '#i-pause');
  $('#pause').setAttribute('aria-label', engine.state === 'paused' ? 'Continuar grabación' : 'Pausar');
  if (!active) $('[data-setting="codec"]').disabled = !['mp4', 'mkv'].includes(settings.videoFormat) || settings.mode === 'audio';
}

function time(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(safe / 3600), Math.floor(safe / 60) % 60, safe % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

function updateState(event) {
  const { state, elapsed, error } = event.detail;
  const labels = { idle: 'Listo para grabar', starting: 'Preparando captura…', recording: 'Grabando', paused: 'En pausa', stopping: 'Guardando y exportando…', error: 'No se pudo completar' };
  $('#timer').textContent = time(elapsed);
  $('#record-state').replaceChildren();
  const dot = document.createElement('span'); dot.className = 'status-dot';
  $('#record-state').append(dot, labels[state] || state);
  $('#footer-status').textContent = labels[state] || state;
  document.body.classList.toggle('recording', state === 'recording');
  document.body.classList.toggle('paused', state === 'paused');
  lockControls();
  if (!['idle', 'error'].includes(state)) for (const dialog of $$('dialog[open]')) dialog.close();
  if (error) fail(error);

}

async function refreshLibrary() {
  files = await api.listFiles();
  renderFiles();
}

function renderFiles() {
  const library = $('#library');
  const filter = $('#library-filter').value;
  const visible = files.filter((file) => filter === 'all' || file.kind === filter);
  library.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const title = document.createElement('strong'); title.textContent = 'Aquí vivirán tus capturas';
    const caption = document.createElement('span'); caption.textContent = 'Los archivos guardados aparecerán en esta lista.';
    empty.append(title, caption); library.append(empty); return;
  }
  visible.forEach((file) => {
    const row = document.createElement('div'); row.className = 'file-row';
    const icon = document.createElement('div'); icon.className = 'file-icon';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', file.kind === 'audio' ? '#i-volume' : file.kind === 'image' ? '#i-camera' : '#i-video');
    svg.append(use); icon.append(svg);
    const info = document.createElement('div'); info.className = 'file-info';
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name; name.title = file.name;
    const meta = document.createElement('span'); meta.className = 'file-meta';
    meta.textContent = `${(file.size / 1048576).toFixed(1)} MB · ${new Date(file.modified).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}`;
    info.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'file-actions';
    for (const [label, action] of [['Abrir', () => api.openFile(file.path)], ['Carpeta', () => api.revealFile(file.path)], ['Eliminar', async () => { await api.deleteFile(file.path); await refreshLibrary(); }]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.addEventListener('click', () => Promise.resolve(action()).catch(fail)); actions.append(button);
    }
    row.append(icon, info, actions); library.append(row);
  });
}

function cancelSchedule(announce = true) {
  clearTimeout(scheduleTimer);
  settings.scheduleAt = '';
  $('#schedule-status').textContent = '';
  $('#cancel-schedule').hidden = true;
  persist();
  if (announce) notify('Grabación programada cancelada.');
}

function schedule(restore = false) {
  const value = restore ? settings.scheduleAt : $('#schedule-time').value;
  const delay = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(delay) || delay <= 0 || delay > 2147483647) {
    if (restore) { cancelSchedule(false); return; }
    notify('Elige una fecha futura dentro de los próximos 24 días.', true); return;
  }
  clearTimeout(scheduleTimer);
  settings.scheduleAt = value;
  $('#schedule-time').value = value;
  $('#schedule-status').textContent = `Programada: ${new Date(value).toLocaleString('es-ES')}. Recorder debe permanecer abierto.`;
  $('#cancel-schedule').hidden = false;
  persist();
  scheduleTimer = setTimeout(async () => {
    cancelSchedule(false);
    if (!['idle', 'error'].includes(engine.state) || busy || screenshotBusy) { notify('No se inició la grabación programada: ya había una captura en curso.', true); return; }
    if ((!['device', 'audio'].includes(settings.mode) || settings.systemAudio) && !settings.sourceId) { notify('No se inició la grabación programada: no hay una fuente seleccionada.', true); return; }
    await record();
  }, delay);
}

function bindEvents() {
  $$('[data-duration]').forEach(input => input.addEventListener('change', () => changeDuration(input)));
  $$('.nav-button').forEach((button) => button.addEventListener('click', () => page(button.dataset.page)));
  $$('.mode-card').forEach((button) => button.addEventListener('click', () => selectMode(button.dataset.mode)));
  $$('[data-setting]').forEach((input) => input.addEventListener('change', () => {
    settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : ['fps', 'countdown', 'autoStop'].includes(input.dataset.setting) ? Number(input.value) : input.value;
    updateSettings(); persist();
  }));
  for (const id of ['source-button', 'choose-source']) $(`#${id}`).addEventListener('click', () => openSources().catch(fail));
  for (const id of ['snapshot', 'take-screenshot']) $(`#${id}`).addEventListener('click', () => screenshot().catch(fail));
  $('#record').addEventListener('click', () => record().catch(fail));
  $('#pause').addEventListener('click', pause);
  $('#minimize').addEventListener('click', () => api.minimize());
  $('#close').addEventListener('click', () => api.close());
  for (const [id, key] of [['speaker-toggle', 'systemAudio'], ['mic-toggle', 'microphone']]) $(`#${id}`).addEventListener('click', () => { settings[key] = !settings[key]; updateSettings(); persist(); });
  $('#choose-folder').addEventListener('click', async () => { try { const folder = await api.chooseFolder(); if (folder) { settings.outputDir = folder; updateSettings(); await refreshLibrary(); } } catch (error) { fail(error); } });
  $('#open-folder').addEventListener('click', () => api.openFolder().catch(fail));
  $('#refresh-devices').addEventListener('click', () => refreshDevices('audio').catch(fail));
  $('#refresh-cameras').addEventListener('click', () => refreshDevices('video').catch(fail));
  $('#audio-mode').addEventListener('click', () => { selectMode('audio'); page('home'); });
  $('#refresh-library').addEventListener('click', () => refreshLibrary().catch(fail));
  $('#library-filter').addEventListener('change', renderFiles);
  $('#schedule-button').addEventListener('click', () => schedule());
  $('#cancel-schedule').addEventListener('click', () => cancelSchedule());
  $$('.dialog-close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
}

async function init() {
  selection = captureSelection({ getSettings: () => settings, loadSources, fail, commit: patch => {
    settings = { ...settings, ...patch }; updateSettings(); persist();
  } });
  bindEvents();
  bindIntegrations(api, engine);
  hotkeys = bindHotkeys(api, { notify, fail, isBusy: () => busy || !['idle', 'error'].includes(engine.state) });
  api.onMetadataWarning(message => notify(message, true));
  const completedJobs = new Set();
  api.onIntegrationChanged(state => {
    const fresh = state.jobs.filter(job => job.status === 'completed' && !completedJobs.has(job.id));
    for (const job of fresh) completedJobs.add(job.id);
    if (fresh.length) refreshLibrary().catch(fail);
  });
  api.onAgentCommand(async ({ id, ...command }) => {
    try {
      if (busy && ['recording.start', 'screenshot.capture'].includes(command.method)) throw new Error('Recorder está actualizando su estado.');
      let result;
      if (command.method === 'settings.get') result = { ...settings };
      else if (command.method === 'settings.update') {
        if (!['idle', 'error'].includes(engine.state) || busy || screenshotBusy) throw new Error('Espera a que termine la captura.');
        busy = true; lockControls();
        try {
          await saving;
          const next = { ...settings, ...command.params };
          const { agentEnabled, ...preferences } = next;
          await api.saveConfig(preferences); settings = next;
          await loadSources(); updateSettings(); result = { ...settings };
        } finally { busy = false; lockControls(); }
      } else result = await engine.command(command);
      if (command.method === 'recording.start') {
        settings = { ...settings, ...command.params };
        settings.sourceId = command.params.sourceId || command.params.scene?.items[0]?.sourceId || '';
        settings.cameraId = command.params.cameraId || ''; settings.microphoneId = command.params.microphoneId || '';
        settings.region = command.params.region || null;
        if (settings.mode === 'audio') settings.audioFormat = command.params.format;
        else settings.videoFormat = command.params.format;
        source = sources.find(item => item.id === settings.sourceId) || null;
        updateSettings(); lockControls();
        loadSources().catch(fail);
      }
      api.agentReply({ id, result });
    }
    catch (error) { api.agentReply({ id, error: error.message }); }
  });
  engine.addEventListener('state', () => api.agentState(engine.status()));
  engine.addEventListener('state', updateState);
  engine.addEventListener('countdown', (event) => { $('#record-state').textContent = `Grabación en ${event.detail}…`; });
  engine.addEventListener('finished', (event) => { notify(`Grabación guardada: ${event.detail?.name || 'archivo listo'}`); refreshLibrary().catch(fail); loadSources().catch(fail); });
  api.onShortcut((action) => {
    if (action === 'record') record().catch(fail);
    else if (action === 'pause') pause();
    else if (action === 'screenshot') screenshot().catch(fail);
    else if (action === 'stop') stop().catch(fail);
  });
  api.onExportProgress?.((value) => { $('#footer-status').textContent = typeof value === 'number' ? `Exportando… ${Math.round(value)} %` : 'Exportando vídeo…'; });
  settings = { ...defaults, ...await api.getConfig() };
  delete settings.agentEnabled; delete settings.hotkeys;
  updateSettings();
  await Promise.allSettled([loadSources(), refreshLibrary(), refreshDevices()]);
  updateSettings();
  if (settings.scheduleAt) schedule(true);
  const status = await api.getStatus();
  await hotkeys.load().catch(fail);
  const unavailable = hotkeys.unavailable();
  const warnings = [...(status.warnings || [])];
  if (unavailable.length) warnings.push(`Atajos ocupados por otra aplicación: ${unavailable.join(', ')}. Cámbialos en General › Atajos de teclado o usa los botones de Recorder.`);
  if (warnings.length) notify(warnings.join('\n'), true);
  busy = false; lockControls(); document.body.dataset.ready = 'true';
}

init().catch(fail);
