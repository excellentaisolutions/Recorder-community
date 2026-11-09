const { contextBridge, ipcRenderer } = require('electron');

const invoke = name => (...args) => ipcRenderer.invoke(`recorder:${name}`, ...args);
const listen = channel => callback => {
  if (typeof callback !== 'function') throw new TypeError('Se requiere una función.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('recorder', Object.freeze({
  integrationStatus: invoke('integrationStatus'), integrationSet: invoke('integrationSet'), integrationCancel: invoke('integrationCancel'),
  onIntegrationChanged: listen('recorder:integrationChanged'),
  onMetadataWarning: listen('recorder:metadataWarning'),
  onAgentCommand: listen('recorder:agentCommand'),
  agentReply: value => ipcRenderer.send('recorder:agentReply', value),
  agentState: value => ipcRenderer.send('recorder:agentState', value),
  getConfig: invoke('getConfig'), saveConfig: invoke('saveConfig'), chooseFolder: invoke('chooseFolder'),
  listSources: invoke('listSources'), selectSource: invoke('selectSource'),
  startFile: invoke('startFile'), appendChunk: invoke('appendChunk'), finishFile: invoke('finishFile'), abortFile: invoke('abortFile'),
  saveScreenshot: invoke('saveScreenshot'), listFiles: invoke('listFiles'), openFile: invoke('openFile'), revealFile: invoke('revealFile'), deleteFile: invoke('deleteFile'), openFolder: invoke('openFolder'),
  minimize: invoke('minimize'), close: invoke('close'), getStatus: invoke('getStatus'),
  getHotkeys: invoke('getHotkeys'), setHotkey: invoke('setHotkey'), resetHotkeys: invoke('resetHotkeys'), suspendHotkeys: invoke('suspendHotkeys'),
  onShortcut: listen('recorder:shortcut'), onExportProgress: listen('recorder:exportProgress'),
}));
