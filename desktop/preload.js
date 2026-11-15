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
  stopAlarm: call('stopAlarm'),
  clearStats: call('clearStats'),
  checkUpdate: call('checkUpdate'),
  installUpdate: call('installUpdate'),
  openUrl: call('openUrl'),
  openTask: call('openTask'),
});
