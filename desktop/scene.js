export function validateScene(scene) {
  if (!scene || !Array.isArray(scene.items) || scene.items.length < 2 || scene.items.length > 4)
    throw new Error('Selecciona entre dos y cuatro fuentes.');
  if (new Set(scene.items.map(item => item.sourceId)).size !== scene.items.length || scene.items.some(item => !item.sourceId))
    throw new Error('Cada fuente de la composición debe ser distinta.');
  if (!['horizontal', 'vertical', 'grid'].includes(scene.layout)) throw new Error('Distribución no válida.');
  for (const [key, min, max] of [['width', 320, 3840], ['height', 240, 2160]])
    if (!Number.isInteger(scene[key]) || scene[key] < min || scene[key] > max || scene[key] % 2) throw new Error('Resolución de composición no válida.');
  for (const item of scene.items) {
    const r = item.region;
    if (r && (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1))
      throw new Error('Área de composición fuera de la fuente.');
  }
}

export function drawScene(ctx, canvas, videos, scene) {
  const columns = scene.layout === 'vertical' ? 1 : scene.layout === 'grid' ? 2 : videos.length;
  const rows = Math.ceil(videos.length / columns);
  const cellWidth = canvas.width / columns, cellHeight = canvas.height / rows;
  ctx.fillStyle = '#111722'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  videos.forEach((video, i) => {
    if (!video.videoWidth) return;
    const item = scene.items[i], r = item.region || { x: 0, y: 0, width: 1, height: 1 };
    const x = (i % columns) * cellWidth, y = Math.floor(i / columns) * cellHeight;
    const labelHeight = item.label ? 36 : 0;
    const sw = video.videoWidth * r.width, sh = video.videoHeight * r.height;
    const scale = Math.min(cellWidth / sw, (cellHeight - labelHeight) / sh);
    ctx.drawImage(video, r.x * video.videoWidth, r.y * video.videoHeight, sw, sh,
      x + (cellWidth - sw * scale) / 2, y + labelHeight + (cellHeight - labelHeight - sh * scale) / 2, sw * scale, sh * scale);
    if (item.label) {
      ctx.fillStyle = '#ffffff'; ctx.font = '600 18px Segoe UI, sans-serif';
      ctx.fillText(String(item.label).slice(0, 100), x + 12, y + 25, cellWidth - 24);
    }
  });
}
