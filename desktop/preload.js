const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('fox', {
  getState: call('getState'),
  saveConfig: call('saveConfig'),
  addTarget: call('addTarget'),
  updateTarget: call('updateTarget'),
  removeTarget: call('removeTarget'),
  start: call('start'),
  stop: call('stop'),
  clearLog: call('clearLog'),
  testAlert: call('testAlert'),
  openUrl: call('openUrl'),
});
