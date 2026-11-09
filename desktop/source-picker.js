const $ = selector => document.querySelector(selector);
let selected = new Set();
let sources = [], mode, onChoose, onScene, currentId, appliedScene;

export function showSources(items, currentMode, scene, choose, chooseScene, sourceId, preserve = false) {
  sources = items; mode = currentMode; onChoose = choose; onScene = chooseScene;
  currentId = sourceId;
  if (!preserve) {
    appliedScene = scene;
    $('#source-search').value = '';
    $('#combine-sources').checked = mode === 'scene';
    selected = new Set((scene?.items || []).map(item => item.sourceId));
    $('#scene-layout').value = scene?.layout || 'horizontal';
  }
  selected = new Set([...selected].filter(id => sources.some(source => source.id === id)));
  render();
}

function render() {
  const combined = $('#combine-sources').checked;
  $('#scene-tools').hidden = !combined; $('#confirm-scene').hidden = !combined;
  $('#confirm-scene').disabled = selected.size < 2 || selected.size > 4;
  $('#scene-count').textContent = `${selected.size} / 4 fuentes · pendiente de aplicar`;
  $('#source-help').textContent = combined ? 'El orden de selección es el orden de los paneles. Pulsa Usar composición para aplicar; Cancelar conserva tu configuración.' : mode === 'window' ? 'Elige una ventana para aplicar. Cancelar conserva la selección anterior.' : 'Elige una pantalla para aplicar. Cancelar conserva la selección anterior.';
  const query = $('#source-search').value.toLocaleLowerCase();
  const eligible = sources.filter(item => (combined || item.kind === (mode === 'window' ? 'window' : 'screen')) && item.name.toLocaleLowerCase().includes(query));
  $('#sources-grid').replaceChildren();
  for (const item of eligible) {
    const button = document.createElement('button'); button.className = 'source-tile'; button.title = item.name;
    const checked = combined ? selected.has(item.id) : currentId === item.id;
    button.setAttribute('aria-pressed', String(checked));
    const img = document.createElement('img'); img.src = item.thumbnail || item.dataURL || ''; img.alt = '';
    const label = document.createElement('span'); label.textContent = `${checked ? combined ? `${[...selected].indexOf(item.id) + 1} · ` : 'Seleccionada · ' : ''}${item.name}`;
    const detail = document.createElement('span'); detail.className = 'muted';
    detail.textContent = item.kind === 'screen' ? `${item.width} × ${item.height} · ${Math.round(item.scaleFactor * 100)} %${item.primary ? ' · Principal' : ''}` : 'Ventana de aplicación';
    button.append(img, label, detail);
    button.addEventListener('click', () => {
      if (!combined) return onChoose(item);
      if (selected.has(item.id)) selected.delete(item.id); else if (selected.size < 4) selected.add(item.id);
      render();
    });
    $('#sources-grid').append(button);
  }
  if (!eligible.length) $('#source-help').textContent = 'No se encontraron fuentes. Abre la aplicación y actualiza, o cambia la búsqueda.';
}

export function bindSourcePicker() {
  $('#source-search').addEventListener('input', render);
  $('#combine-sources').addEventListener('change', render);
  $('#all-screens').addEventListener('click', () => { selected = new Set(sources.filter(s => s.kind === 'screen').slice(0, 4).map(s => s.id)); render(); });
  $('#confirm-scene').addEventListener('click', () => {
    if (selected.size < 2 || selected.size > 4) return;
    onScene({ layout: $('#scene-layout').value, width: appliedScene?.width || 1920, height: appliedScene?.height || 1080,
      items: [...selected].map(sourceId => ({ ...appliedScene?.items.find(item => item.sourceId === sourceId), sourceId,
        label: sources.find(s => s.id === sourceId).name.slice(0, 100) })) });
  });
}
