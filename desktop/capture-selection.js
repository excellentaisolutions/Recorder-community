import { bindSourcePicker, showSources } from './source-picker.js';
const $ = selector => document.querySelector(selector);

export function captureSelection({ getSettings, loadSources, commit, fail }) {
  let mode, regionSource, pendingRegion, regionStart;
  bindSourcePicker();
  async function open(nextMode = getSettings().mode, refresh = false) {
    mode = nextMode;
    if (!refresh) $('#source-search').value = '';
    const dialog = $('#sources-dialog');
    if (!dialog.open) dialog.showModal();
    $('#sources-grid').replaceChildren(); $('#source-help').textContent = 'Buscando fuentes…';
    $('#confirm-scene').disabled = true;
    try {
      const sources = await loadSources();
      if (!dialog.open) return;
      const settings = getSettings();
      showSources(sources, mode, settings.scene, choose, scene => {
        dialog.close(); commit({ mode: 'scene', scene, sourceId: scene.items[0].sourceId, region: null });
      }, settings.sourceId, refresh);
    } catch (error) { $('#source-help').textContent = 'No se pudieron cargar las fuentes. Vuelve a actualizar.'; throw error; }
  }
  function choose(item) {
    $('#sources-dialog').close();
    if (mode === 'region') return openRegion(item);
    commit({ mode: mode === 'scene' ? item.kind : mode, sourceId: item.id, region: null });
  }
  function openRegion(item) {
    regionSource = item; pendingRegion = null; regionStart = null;
    const image = $('#region-image');
    image.onload = () => { $('#region-stage').style.maxWidth = `${420 * image.naturalWidth / image.naturalHeight}px`; };
    image.src = item.thumbnail || item.dataURL;
    $('#region-selection').style.display = 'none'; $('#confirm-region').disabled = true;
    $('#region-size').textContent = 'Arrastra para seleccionar · pendiente de aplicar';
    const current = getSettings();
    if (current.mode === 'region' && current.sourceId === item.id && current.region) {
      pendingRegion = { ...current.region }; showRegion(true);
    }
    $('#region-dialog').showModal();
  }
  function point(event) {
    const rect = $('#region-image').getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  }
  function draw(event) {
    if (!regionStart) return;
    const end = point(event);
    pendingRegion = { x: Math.min(regionStart.x, end.x), y: Math.min(regionStart.y, end.y), width: Math.abs(end.x - regionStart.x), height: Math.abs(end.y - regionStart.y) };
    showRegion();
  }
  function showRegion(applied = false) {
    const { x, y, width, height } = pendingRegion;
    Object.assign($('#region-selection').style, { display: 'block', left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` });
    $('#confirm-region').disabled = width < .02 || height < .02;
    $('#region-size').textContent = regionSource.width && regionSource.height
      ? `${Math.round(width * regionSource.width)} × ${Math.round(height * regionSource.height)} píxeles · pendiente de aplicar`
      : `${Math.round(width * 100)} × ${Math.round(height * 100)} % · pendiente de aplicar`;
    if (applied) $('#region-size').textContent = $('#region-size').textContent.replace('pendiente de aplicar', 'área actual');
  }
  const stage = $('#region-stage');
  stage.addEventListener('pointerdown', event => { event.preventDefault(); regionStart = point(event); stage.setPointerCapture(event.pointerId); });
  stage.addEventListener('pointermove', draw);
  stage.addEventListener('pointerup', event => { draw(event); regionStart = null; stage.releasePointerCapture(event.pointerId); });
  stage.addEventListener('pointercancel', () => { regionStart = null; });
  $('#confirm-region').addEventListener('click', () => {
    if (!pendingRegion || $('#confirm-region').disabled) return;
    commit({ mode: 'region', sourceId: regionSource.id, region: pendingRegion }); $('#region-dialog').close();
  });
  $('#refresh-sources').addEventListener('click', () => open(mode, true).catch(fail));
  return { open };
}
