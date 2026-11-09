const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, dialog, shell, globalShortcut, powerSaveBlocker, Tray, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStorage } = require('./storage.cjs');
const { finishFile } = require('./exporter.cjs');
const { parseArgs } = require('./contracts.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createAgentService } = require('./agents/service.cjs');
const { runDemo } = require('./agents/demo.cjs');
const { runMultiview } = require('./agents/multiview.cjs');
const { compose } = require('./agents/media.cjs');
const { speech } = require('./agents/speech.cjs');
const { capabilities, displayInfo } = require('./agents/capabilities.cjs');
const { tools: agentTools } = require('./agents/schema.cjs');
const { createHotkeys } = require('./hotkeys.cjs');
let hotkeys;
const hotkeyWarnings = [];
let agents;
const pendingCommands = new Map();
let agentStatus = { state: 'idle', elapsed: 0 };
function agentCommand(command, timeout = 60000) {
  if (!window || window.isDestroyed()) return Promise.reject(new Error('Recorder no está disponible.'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pendingCommands.delete(id); reject(new Error('Tiempo agotado; consulta recording.status antes de reintentar.')); }, timeout);
    pendingCommands.set(id, { resolve, reject, timer });
    emit('recorder:agentCommand', { id, ...command });
  });
}


app.setName('Recorder');
if (process.env.RECORDER_USER_DATA) app.setPath('userData', process.env.RECORDER_USER_DATA);
const ownsInstance = Boolean(process.env.RECORDER_USER_DATA) || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let window;
let storage;
let selectedSource = null;
let quitAfterSave = false;
let closeDialogOpen = false;
let sleepBlocker;
let tray;
let quitting = false;
const pageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const knownSources = new Map();

function liveContents() {
  return window && !window.isDestroyed() ? window.webContents : null;
}

function fromPage(event) {
  return Boolean(liveContents()) && event.sender === liveContents() && event.senderFrame?.url.split('#')[0] === pageUrl;
}

function emit(channel, value) {
  liveContents()?.send(channel, value);
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function closesToTray() {
  return !quitting && tray && !tray.isDestroyed() && storage.getConfig().closeToTray !== false;
}

function hideToTray() {
  window.hide();
  if (storage.getConfig().trayHintShown) return;
  tray.displayBalloon({ iconType: 'info', title: 'Recorder sigue abierto', content: 'Está en la bandeja del sistema, junto al reloj. Para cerrarlo: clic derecho en el icono › Salir.' });
  try { storage.saveConfig({ trayHintShown: true }); } catch {}
}

function withKey(text, action) {
  const key = hotkeys?.label(action);
  return key ? `${text} (${key})` : text;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const busy = storage.isBusy();
  const exporting = [...storage.sessions.values()].some(item => item.closed);
  tray.setToolTip(exporting ? 'Recorder — Exportando' : busy ? 'Recorder — Grabación en curso' : 'Recorder — Listo para grabar');
  tray.setContextMenu(Menu.buildFromTemplate([
    liveContents() && window.isVisible() ? { label: 'Ocultar en la bandeja', click: () => window.hide() } : { label: 'Mostrar Recorder', click: showWindow },
    { type: 'separator' },
    { label: withKey(busy ? 'Detener grabación' : 'Grabar', 'record'), enabled: !exporting, click: () => emit('recorder:shortcut', 'record') },
    { label: withKey('Pausar / reanudar', 'pause'), enabled: busy && !exporting, click: () => emit('recorder:shortcut', 'pause') },
    { label: withKey('Capturar imagen', 'screenshot'), enabled: !exporting, click: () => emit('recorder:shortcut', 'screenshot') },
    { type: 'separator' },
    { label: 'Salir', click: () => app.quit() },
  ]));
}

function handle(name, action) {
  ipcMain.handle(`recorder:${name}`, async (event, ...args) => {
    if (!fromPage(event)) throw new Error('Origen no autorizado.');
    try { return await action(...parseArgs(name, args)); }
    finally {
      if (storage?.sessions.size && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!storage?.sessions.size && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
      if (!['appendChunk', 'listFiles'].includes(name)) refreshTray();
    }
  });
}

async function listSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 640, height: 360 }, fetchWindowIcons: false });
  knownSources.clear();
  const displays = screen.getAllDisplays();
  return sources.filter(source => source.id !== (liveContents() && window.getMediaSourceId())).map(source => {
    knownSources.set(source.id, source);
    const display = displays.find(item => String(item.id) === source.display_id);
    const thumbnail = source.thumbnail.toDataURL();
    const info = display ? displayInfo(display, screen.getPrimaryDisplay().id) : {};
    return { ...info, id: source.id, displayId: source.display_id || null, name: display ? `${display.label || source.name}${info.primary ? ' (principal)' : ''}` : source.name,
      thumbnail, dataURL: thumbnail, width: info.width || null, height: info.height || null, scaleFactor: info.scaleFactor || null,
      bounds: info.bounds || null, kind: source.id.startsWith('screen:') ? 'screen' : 'window' };
  });
}

async function requestClose(event) {
  if (closesToTray()) {
    event.preventDefault();
    hideToTray();
    return;
  }
  if (!storage.isBusy() && agents?.hasRunning()) {
    event.preventDefault();
    if (closeDialogOpen) return;
    closeDialogOpen = true;
    agents.cancel();
    try { await agents.settle(); } finally { closeDialogOpen = false; }
    window.close();
    return;
  }
  if (!storage.isBusy()) return;
  event.preventDefault();
  if (closeDialogOpen || quitAfterSave) return;
  closeDialogOpen = true;
  try {
    const exporting = [...storage.sessions.values()].some(item => item.closed);
    showWindow();
    const result = await dialog.showMessageBox(window, { type: 'question', title: 'Grabación en curso', message: exporting ? 'El vídeo se está exportando. ¿Cerrar cuando termine?' : '¿Detener, guardar la grabación y cerrar?', buttons: ['Continuar trabajando', 'Guardar y cerrar'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) {
      quitAfterSave = true;
      if (!exporting) emit('recorder:shortcut', 'stop');
    } else quitting = false;
  } finally { closeDialogOpen = false; }
}

function bindIpc() {
  handle('getConfig', () => storage.getConfig());
  handle('integrationStatus', () => agents.state());
  handle('integrationCancel', () => agents.cancel());
  handle('integrationSet', options => agents.set(options));
  for (const channel of ['agentReply', 'agentState']) ipcMain.on(`recorder:${channel}`, (event, value) => {
    if (!fromPage(event)) return;
    if (channel === 'agentState') {
      agentStatus = value;
      return;
    }
    const pending = pendingCommands.get(value?.id);
    if (!pending) return;
    pendingCommands.delete(value.id); clearTimeout(pending.timer);
    if (value.error) pending.reject(new Error(value.error)); else pending.resolve(value.result);
  });
  handle('saveConfig', ({ hotkeys: _ignored, ...input }) => storage.saveConfig(input));
  handle('getHotkeys', () => hotkeys.state());
  handle('setHotkey', (action, accelerator) => hotkeys.set(action, accelerator));
  handle('resetHotkeys', () => hotkeys.reset());
  handle('suspendHotkeys', flag => hotkeys.suspend(flag));
  handle('chooseFolder', async () => {
    const choice = await dialog.showOpenDialog(window, { title: 'Carpeta de grabaciones', defaultPath: storage.getConfig().outputDir, properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return null;
    storage.saveConfig({ outputDir: choice.filePaths[0] });
    return choice.filePaths[0];
  });
  handle('listSources', listSources);
  handle('selectSource', id => {
    if (typeof id !== 'string' || !knownSources.has(id)) throw new Error('Actualiza la lista y selecciona una fuente disponible.');
    selectedSource = knownSources.get(id);
    return true;
  });
  handle('startFile', options => storage.startFile(options));
  handle('appendChunk', (id, bytes) => storage.appendChunk(id, bytes));
  handle('finishFile', async (id, options) => {
    try {
      const result = await finishFile(app, storage, id, options, detail => { refreshTray(); emit('recorder:exportProgress', detail); });
      try {
        const metadata = agentStatus.state === 'stopping' ? { ...agentStatus, state: 'idle', artifact: result } : { artifact: result };
        fs.writeFileSync(`${result.path}.session.json`, JSON.stringify(metadata, null, 2), { flag: 'wx' });
      } catch (error) { emit('recorder:metadataWarning', 'No se pudieron guardar las marcas: ' + error.message); }
      if (quitAfterSave) setTimeout(() => app.quit(), 750);
      return result;
    } catch (error) { quitAfterSave = false; throw error; }
  });
  handle('abortFile', async id => { quitAfterSave = false; return storage.abortFile(id); });
  handle('saveScreenshot', (data, format) => storage.saveScreenshot(data, format));
  handle('listFiles', () => storage.listFiles());
  handle('openFile', async file => { const error = await shell.openPath(storage.authorizedFile(file)); if (error) throw new Error(error); return true; });
  handle('revealFile', file => { shell.showItemInFolder(storage.authorizedFile(file)); return true; });
  handle('openFolder', async () => { const error = await shell.openPath(storage.getConfig().outputDir); if (error) throw new Error(error); return true; });
  handle('deleteFile', async file => {
    const target = storage.authorizedFile(file);
    if ([...storage.sessions.values()].some(item => item.file === target)) throw new Error('La grabación todavía está en curso.');
    const answer = await dialog.showMessageBox(window, { type: 'question', message: `¿Enviar ${path.basename(target)} a la papelera?`, buttons: ['Cancelar', 'Enviar a la papelera'], cancelId: 0, defaultId: 0 });
    if (answer.response !== 1) return false;
    await shell.trashItem(target);
    const metadata = `${target}.session.json`;
    if (fs.existsSync(metadata)) await shell.trashItem(metadata);
    return true;
  });
  handle('minimize', () => window.minimize());
  handle('close', () => window.close());
  handle('getStatus', () => ({ recording: storage.isBusy(), warnings: [...storage.getWarnings(), ...hotkeyWarnings], hotkeys: hotkeys.state().active }));
}

async function createWindow() {
  window = new BrowserWindow({ width: 1040, height: 760, minWidth: 760, minHeight: 620, title: 'Recorder — Captura de pantalla', icon: path.join(__dirname, 'assets', 'recorder.ico'), backgroundColor: '#191c20', frame: false, show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-start-loading', () => globalShortcut.setSuspended(false));
  window.on('close', requestClose);
  window.on('show', refreshTray);
  window.on('hide', refreshTray);
  window.once('ready-to-show', () => { if (!process.env.RECORDER_TEST_HIDDEN) window.show(); });
  await window.loadFile(path.join(__dirname, 'index.html'));
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });

if (ownsInstance) app.whenReady().then(async () => {
  storage = createStorage(app);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(Boolean(liveContents()) && contents === liveContents() && ['media', 'display-capture'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => Boolean(liveContents()) && contents === liveContents() && ['media', 'display-capture'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (!selectedSource) return callback({});
    callback({ video: selectedSource, audio: 'loopback' });
  });
  hotkeys = createHotkeys({ globalShortcut, storage, trigger: action => emit('recorder:shortcut', action), warn: text => hotkeyWarnings.push(text) });
  agents = createAgentService({ app, storage, listSources, command: agentCommand, emit,
    capabilities: () => capabilities(app, screen, agentTools),
    multiview: (recipe, allowed) => runMultiview(app, storage, recipe, allowed),
    speech: (recipe, allowed) => speech(app, storage, recipe, allowed),
    demo: (recipe, allowed) => runDemo(app, storage, recipe, allowed),
    compose: (recipe, allowed) => compose(app, storage, recipe, allowed) });
  await agents.start();
  bindIpc();
  await createWindow();
  tray = new Tray(path.join(__dirname, 'assets', 'recorder.ico'));
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
  hotkeys.start();
  refreshTray();
}).catch(error => { dialog.showErrorBox('No se pudo iniciar Recorder', error.message); app.quit(); });

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { agents?.close(); globalShortcut.unregisterAll(); tray?.destroy(); });
