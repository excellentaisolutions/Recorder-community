const $ = selector => document.querySelector(selector);
export function updateSelectionSummary(settings, sources) {
  const source = sources.find(item => item.id === settings.sourceId);
  const names = { screen: 'Pantalla', window: 'Ventana', region: 'Área', device: 'Cámara', audio: 'Solo audio', scene: 'Composición' };
  let label = `${names[settings.mode]} · ${source?.name || 'Sin fuente'}`, detail = '', ready = Boolean(source);
  if (settings.mode === 'scene') {
    const items = settings.scene?.items || [];
    label = `Composición · ${items.length} fuentes · ${settings.scene?.width || 1920} × ${settings.scene?.height || 1080}`;
    detail = `${{ horizontal: 'Lado a lado', vertical: 'Una sobre otra', grid: 'Cuadrícula' }[settings.scene?.layout] || ''}\n` + items.map((item, i) => {
      const real = sources.find(source => source.id === item.sourceId);
      return `${i + 1}. ${real?.name || item.label || item.sourceId}${real ? '' : ' — no disponible'}${item.region ? ' · con recorte' : ''}`;
    }).join('\n');
    ready = items.length >= 2 && items.every(item => sources.some(source => source.id === item.sourceId));
  } else if (settings.mode === 'region') {
    const r = settings.region; ready = Boolean(source && r);
    if (r && source) {
      label += source.width && source.height ? ` · ${Math.round(r.width * source.width)} × ${Math.round(r.height * source.height)} px` : ` · ${Math.round(r.width * 100)} × ${Math.round(r.height * 100)} %`;
      detail = `Posición: ${Math.round(r.x * 100)} %, ${Math.round(r.y * 100)} % · Tamaño: ${Math.round(r.width * 100)} % × ${Math.round(r.height * 100)} %`;
    }
  } else if (settings.mode === 'device') {
    label = `Cámara · ${$('.camera-select').selectedOptions[0]?.textContent || 'Predeterminada'}`;
    ready = !label.includes('no disponible') && (!settings.systemAudio || Boolean(source));
    if (settings.systemAudio) detail = `Audio del sistema: ${source?.name || 'elige una pantalla con Seleccionar'}`;
  } else if (settings.mode === 'audio') {
    label = `Solo audio · ${[settings.systemAudio && 'Sistema', settings.microphone && 'Micrófono'].filter(Boolean).join(' + ') || 'Sin entradas activas'}`;
    ready = Boolean(settings.systemAudio || settings.microphone) && (!settings.systemAudio || Boolean(source));
    detail = settings.systemAudio ? `Fuente del sistema: ${source?.name || 'sin seleccionar'}` : '';
  } else if (source) ready = source.kind === settings.mode;
  if (settings.microphone) {
    const mic = $('.microphone-select').selectedOptions[0]?.textContent || 'Predeterminado';
    detail += `${detail ? '\n' : ''}Micrófono: ${mic}`; if (mic.includes('no disponible')) ready = false;
  }
  if (settings.webcamOverlay && !['device', 'audio'].includes(settings.mode)) {
    const camera = $('.camera-select').selectedOptions[0]?.textContent || 'Predeterminada';
    detail += `${detail ? '\n' : ''}Webcam superpuesta: ${camera}`; if (camera.includes('no disponible')) ready = false;
  }
  $('#selected-source').textContent = label; $('#selected-source').title = label;
  $('#selection-details').textContent = detail; $('#selection-details').hidden = !detail;
  $('#selection-status').textContent = ready ? 'Aplicada' : settings.sourceId || settings.mode === 'scene' ? 'Revisar selección' : 'Selecciona una fuente';
  $('#selection-status').classList.toggle('needs-selection', !ready);
  $('#source-label').textContent = settings.mode === 'scene' ? `${settings.scene?.items.length || 0} fuentes` : settings.mode === 'audio' ? 'Solo audio' : settings.mode === 'device' ? 'Cámara' : source?.name || 'Seleccionar fuente';
  $('#source-button').title = `${label}${detail ? '\n' + detail : ''}`;
  $('#source-icon').setAttribute('href', `#i-${{ screen: 'screen', window: 'window', region: 'region', device: 'video', audio: 'mic', scene: 'grid' }[settings.mode] || 'screen'}`);
}
