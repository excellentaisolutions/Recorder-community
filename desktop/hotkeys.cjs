const defaults = Object.freeze({ record: 'F9', pause: 'F10', screenshot: 'F11' });
const actions = Object.keys(defaults);
const modifierOrder = ['Control', 'Alt', 'Shift', 'Super', 'Command'];
const namedKeys = new Set(['Up', 'Down', 'Left', 'Right', 'Space', 'Delete', 'Insert', 'PageUp', 'PageDown', 'Home', 'End', 'PrintScreen', 'Scrolllock', 'Return', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec']);
const functionKey = /^F([1-9]|1\d|2[0-4])$/;
const mac = process.platform === 'darwin';

// Combinaciones que un registro global sí consigue, pero que quitaría al resto del sistema.
const everyApp = 'Esa combinación la usan el sistema o casi todas las aplicaciones (copiar, pegar, cerrar…). Elige otra.';
const altGr = 'Ctrl+Alt equivale a AltGr: con esa combinación dejarías de poder escribir símbolos como @, # o €. Elige otra.';
const reserved = new Map([
  ...['A', 'C', 'F', 'N', 'O', 'P', 'Q', 'S', 'T', 'V', 'W', 'X', 'Y', 'Z'].flatMap(key => [[`Control+${key}`, everyApp], [`Command+${key}`, everyApp]]),
  ...['Alt+F4', 'Alt+Space', 'Command+Space', 'Command+H', 'Command+M', 'Super+D', 'Super+E', 'Super+I', 'Super+L', 'Super+R', 'Super+V', 'Super+Shift+S', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5', 'Control+Alt+Delete'].map(key => [key, everyApp]),
  ...(mac ? [] : ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'E'].map(key => [`Control+Alt+${key}`, altGr])),
]);

function normalize(accelerator) {
  if (accelerator === '') return '';
  if (typeof accelerator !== 'string' || accelerator.length > 64) throw new Error('Atajo no válido.');
  const parts = accelerator.split('+');
  const key = parts.pop();
  const modifiers = parts.map(part => part === 'Ctrl' ? 'Control' : part === 'Meta' ? 'Super' : part);
  if (modifiers.some(part => !modifierOrder.includes(part)) || new Set(modifiers).size !== modifiers.length) throw new Error('Atajo no válido.');
  if (!(/^[A-Z0-9]$/.test(key) || /^num\d$/.test(key) || functionKey.test(key) || namedKeys.has(key))) throw new Error('Esa tecla no se puede usar en un atajo global. Prueba con letras, números, flechas o teclas F.');
  if (!functionKey.test(key) && !modifiers.some(part => ['Control', 'Alt', 'Super', 'Command'].includes(part))) {
    throw new Error('Añade Ctrl, Alt o Win: una tecla sola o con Mayús dejaría de escribirse en el resto de aplicaciones.');
  }
  const result = [...modifierOrder.filter(part => modifiers.includes(part)), key].join('+');
  if (reserved.has(result)) throw new Error(reserved.get(result));
  return result;
}

const names = mac ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘', Command: '⌘' } : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Mayús', Super: 'Win', Command: 'Win' };
const label = accelerator => accelerator ? accelerator.split('+').map(part => names[part] || part).join(mac ? '' : '+') : '';

function createHotkeys({ globalShortcut, storage, trigger, warn = () => {} }) {
  let bindings = { ...defaults };
  const active = {};
  const saved = storage.getConfig().hotkeys || {};
  for (const action of actions) {
    if (!(action in saved)) continue;
    try { bindings[action] = normalize(saved[action]); }
    catch { warn(`El atajo guardado para «${action}» no es válido; se usa ${label(defaults[action])}.`); }
  }
  const values = Object.values(bindings).filter(Boolean);
  if (new Set(values).size !== values.length) { warn('Había atajos repetidos; se restablecen los originales.'); bindings = { ...defaults }; }

  function register(action) {
    const value = bindings[action];
    active[action] = Boolean(value) && globalShortcut.register(value, () => trigger(action));
  }
  function release(action) {
    if (active[action]) globalShortcut.unregister(bindings[action]);
    active[action] = false;
  }
  const state = () => ({ bindings: { ...bindings }, defaults: { ...defaults }, active: { ...active } });
  function persist(next) { storage.saveConfig({ hotkeys: next }); }

  function set(action, accelerator) {
    if (!actions.includes(action)) throw new Error('Acción desconocida.');
    const value = normalize(accelerator);
    const owner = actions.find(item => item !== action && value && bindings[item] === value);
    if (owner) throw new Error(`${label(value)} ya está asignado a otra acción de Recorder.`);
    globalShortcut.setSuspended(false);
    if (value === bindings[action] && (active[action] || !value)) return { ok: true, state: state() };
    const previous = bindings[action];
    release(action);
    bindings[action] = value;
    register(action);
    if (value && !active[action]) {
      bindings[action] = previous;
      register(action);
      return { ok: false, state: state() };
    }
    try { persist({ ...bindings }); }
    catch (error) { release(action); bindings[action] = previous; register(action); throw error; }
    return { ok: true, state: state() };
  }

  function reset() {
    globalShortcut.setSuspended(false);
    const previous = { ...bindings };
    actions.forEach(release);
    bindings = { ...defaults };
    actions.forEach(register);
    try { persist({ ...bindings }); }
    catch (error) { actions.forEach(release); bindings = previous; actions.forEach(register); throw error; }
    return state();
  }

  return {
    start: () => actions.forEach(register),
    state, set, reset,
    suspend: flag => { globalShortcut.setSuspended(Boolean(flag)); return globalShortcut.isSuspended(); },
    label: action => label(bindings[action]),
  };
}

module.exports = { createHotkeys, normalize, label, defaults, actions };
