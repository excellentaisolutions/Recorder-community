const fs = require('node:fs');
const path = require('node:path');
function installedBrowsers() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return [['msedge', 'Microsoft/Edge/Application/msedge.exe'], ['chrome', 'Google/Chrome/Application/chrome.exe']]
    .map(([channel, relative]) => ({ channel, installed: roots.some(root => fs.existsSync(path.join(root, relative))) }));
}
function displayInfo(display, primaryId) {
  return { id: String(display.id), name: display.label || `Monitor ${display.id}`, primary: display.id === primaryId,
    bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, rotation: display.rotation,
    width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor),
    coordinateSpace: 'bounds/workArea: Windows DIP; width/height: nominal physical pixels; capture dimensions returned after start' };
}
function capabilities(app, screen, tools) {
  return { version: app.getVersion(), platform: process.platform, monitors: screen.getAllDisplays().map(d => displayInfo(d, screen.getPrimaryDisplay().id)),
    demoBrowsers: installedBrowsers(), methods: tools().map(tool => tool.name.replaceAll('_', '.')),
    capture: { modes: ['screen', 'window', 'region', 'device', 'audio', 'scene'], maxSceneSources: 4,
      layouts: ['horizontal', 'vertical', 'grid'], fps: [24, 30, 60], sceneMaxSize: { width: 3840, height: 2160 },
      systemAudioScope: 'Windows output mix, once per scene; not per application', normalizedRegions: true },
    limitations: ['A live unlocked Windows session is required.', 'Protected content cannot be captured; minimized/hidden windows depend on the application and Windows.',
      'Window capture includes the visible browser tab; independent hidden tabs require demo.run/demo.multiview.',
      'No native DirectX/OpenGL/Vulkan game hooks or arbitrary desktop UI automation.',
      'Multiple sources share one composited recording; no frame-perfect synchronization guarantee.',
      'Scheduled captures require this app to remain open; pending agent schedules are cancelled on exit or revocation.'] };
}
module.exports = { capabilities, displayInfo };
