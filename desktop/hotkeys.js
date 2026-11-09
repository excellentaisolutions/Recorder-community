const actions = [
  { id: 'record', label: 'Grabar / detener', hint: 'Empieza o termina la grabación' },
  { id: 'pause', label: 'Pausar / continuar', hint: 'Solo durante una grabación' },
  { id: 'screenshot', label: 'Capturar imagen', hint: 'También mientras grabas' },
];
const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
const modifierNames = mac ? { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Super: '⌘' } : { Control: 'Ctrl', Alt: 'Alt', Shift: 'Mayús', Super: 'Win', Command: 'Win' };
const keyNames = { Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Espacio', Delete: 'Supr', Insert: 'Insert', PageUp: 'Re Pág', PageDown: 'Av Pág',
  Home: 'Inicio', End: 'Fin', PrintScreen: 'Impr Pant', Scrolllock: 'Bloq Despl', Return: 'Intro', numadd: 'Num +', numsub: 'Num −', nummult: 'Num ×', numdiv: 'Num ÷', numdec: 'Num ,' };
const codeKeys = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Delete: 'Delete', Insert: 'Insert', PageUp: 'PageUp', PageDown: 'PageDown',
  Home: 'Home', End: 'End', PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock', Enter: 'Return', NumpadEnter: 'Return', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' };
const modifierCodes = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$|^AltGraph$/;

export function describe(accelerator) {
  if (!accelerator) return [];
  return accelerator.split('+').map(part => modifierNames[part] || keyNames[part] || (/^num\d$/.test(part) ? `Num ${part.slice(3)}` : part));
}

export function label(accelerator) { return accelerator ? describe(accelerator).join(mac ? '' : '+') : 'Sin atajo'; }

function keyFromCode(code) {
  if (codeKeys[code]) return codeKeys[code];
  let match = /^Key([A-Z])$/.exec(code) || /^Digit(\d)$/.exec(code);
  if (match) return match[1];
  if ((match = /^Numpad(\d)$/.exec(code))) return `num${match[1]}`;
  if ((match = /^F(\d{1,2})$/.exec(code)) && Number(match[1]) >= 1 && Number(match[1]) <= 24) return code;
  return null;
}

export function fromEvent(event) {
  if (modifierCodes.test(event.code)) return { pending: true };
  const key = keyFromCode(event.code);
  if (!key) return { error: 'Esa tecla no se puede usar en un atajo global. Prueba con letras, números, flechas o teclas F.' };
  const parts = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push(mac ? 'Command' : 'Super');
  return { accelerator: [...parts, key].join('+') };
}

function kbdList(accelerator) {
  const keys = describe(accelerator);
  if (!keys.length) return '<span class="hotkey-none">Sin atajo</span>';
  return keys.map(key => `<kbd>${key.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`)}</kbd>`).join('');
}

export function bindHotkeys(api, { notify, fail, isBusy }) {
  const card = document.querySelector('#hotkeys-card');
  const list = card.querySelector('.hotkey-list');
  let state = { bindings: {}, defaults: {}, active: {} };
  let capturing = null;
  let message = null;

  function paintReferences() {
    document.querySelectorAll('[data-hotkey]').forEach(element => {
      const value = state.bindings[element.dataset.hotkey];
      element.textContent = label(value);
      element.hidden = !value;
    });
    document.querySelectorAll('[data-hotkey-title]').forEach(element => {
      const value = state.bindings[element.dataset.hotkeyTitle];
      element.title = value ? `${element.dataset.title} · ${label(value)}` : element.dataset.title;
    });
  }

  function render() {
    list.innerHTML = actions.map(action => {
      const value = state.bindings[action.id];
      const editing = capturing === action.id;
      const status = !value ? ['off', 'Desactivado'] : state.active[action.id] ? ['ok', 'Activo'] : ['warn', 'Ocupado'];
      const error = message?.action === action.id ? `<p class="hotkey-error" role="alert">${message.text}</p>` : '';
      const changed = value !== state.defaults[action.id];
      return `<div class="hotkey-row${editing ? ' capturing' : ''}${error ? ' has-error' : ''}" data-action="${action.id}">
        <div class="hotkey-name"><strong>${action.label}</strong><small>${action.hint}</small></div>
        <div class="hotkey-combo" aria-live="polite">${editing ? '<span class="hotkey-listening">Pulsa la combinación… <small>Esc para cancelar</small></span>' : kbdList(value)}</div>
        <span class="hotkey-status ${status[0]}" title="${status[0] === 'warn' ? 'Windows u otra aplicación ya usa esta combinación' : ''}">${editing ? '' : status[1]}</span>
        <div class="hotkey-actions">${editing ? '<button class="text-button" data-cancel>Cancelar</button>' : `<button class="secondary" data-change>Cambiar</button>${value ? '<button class="text-button" data-clear>Quitar</button>' : ''}${changed ? '<button class="text-button" data-default>Original</button>' : ''}`}</div>
        ${error}
      </div>`;
    }).join('');
    const custom = actions.some(action => state.bindings[action.id] !== state.defaults[action.id]);
    card.querySelector('#hotkeys-reset').disabled = !custom || Boolean(capturing);
    paintReferences();
  }

  async function finish() {
    capturing = null;
    await api.suspendHotkeys(false).catch(fail);
    render();
  }

  async function apply(action, accelerator) {
    try {
      const result = await api.setHotkey(action, accelerator);
      state = result.state;
      if (!result.ok) { message = { action, text: `Windows u otra aplicación ya usa ${label(accelerator)}. Se mantiene ${label(state.bindings[action])}; prueba otra combinación.` }; return false; }
      message = null;
      notify(accelerator ? `${actions.find(item => item.id === action).label}: ${label(accelerator)}` : 'Atajo desactivado. Puedes seguir usando el botón.');
      return true;
    } catch (error) { message = { action, text: error.message }; return false; }
  }

  async function start(action) {
    if (isBusy()) return notify('Termina la grabación antes de cambiar los atajos.', true);
    message = null;
    capturing = action;
    render();
    list.querySelector(`[data-action="${action}"] [data-cancel]`)?.focus();
    await api.suspendHotkeys(true).catch(fail);
  }

  window.addEventListener('keydown', async event => {
    if (!capturing) return;
    event.preventDefault(); event.stopPropagation();
    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) return finish();
    const result = fromEvent(event);
    if (result.pending) return;
    const action = capturing;
    if (result.error) { message = { action, text: result.error }; return render(); }
    const owner = actions.find(item => item.id !== action && state.bindings[item.id] === result.accelerator);
    if (owner) { message = { action, text: `${label(result.accelerator)} ya está asignado a «${owner.label}».` }; return render(); }
    if (await apply(action, result.accelerator)) return finish();
    if (capturing === action) await api.suspendHotkeys(true).catch(fail);
    render();
  }, true);

  list.addEventListener('click', async event => {
    const row = event.target.closest('[data-action]');
    if (!row) return;
    const action = row.dataset.action;
    if (event.target.closest('[data-change]')) return start(action);
    if (event.target.closest('[data-cancel]')) { message = null; return finish(); }
    if (event.target.closest('[data-clear]')) { await apply(action, ''); return render(); }
    if (event.target.closest('[data-default]')) {
      const owner = actions.find(item => item.id !== action && state.bindings[item.id] === state.defaults[action]);
      if (owner) { message = { action, text: `${label(state.defaults[action])} ya está asignado a «${owner.label}». Cámbialo primero.` }; return render(); }
      await apply(action, state.defaults[action]); return render();
    }
  });
  card.querySelector('#hotkeys-reset').addEventListener('click', async () => {
    try {
      state = await api.resetHotkeys(); message = null;
      const busyKeys = actions.filter(action => !state.active[action.id]).map(action => label(state.bindings[action.id]));
      if (busyKeys.length) notify(`Atajos originales restablecidos, pero ${busyKeys.join(', ')} ${busyKeys.length > 1 ? 'los usa' : 'lo usa'} otra aplicación. Cámbialos si los necesitas.`, true);
      else notify('Atajos originales restablecidos.');
    } catch (error) { fail(error); }
    render();
  });
  window.addEventListener('blur', () => { if (capturing) { message = null; finish(); } });

  return {
    async load() { state = await api.getHotkeys(); render(); return state; },
    unavailable: () => actions.filter(action => state.bindings[action.id] && !state.active[action.id]).map(action => label(state.bindings[action.id])),
    labelFor: action => label(state.bindings[action]),
  };
}
