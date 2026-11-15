// Fox Queue – Electron-Hauptprozess
const { app, BrowserWindow, ipcMain, Notification, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { checkTarget } = require('./engine');

// ---- Auto-Update ----
const RELEASES_API = 'https://api.github.com/repos/Djlover007/Fox-Queue-Downloads/releases/latest';
const RELEASES_PAGE = 'https://github.com/Djlover007/Fox-Queue-Downloads/releases/latest';
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
const update = { status: 'idle', latest: '', progress: 0, message: '', current: '', canInstall: false };
let autoUpdater = null;

function newer(a, b) {
  const x = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const y = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function setupUpdater() {
  update.current = app.getVersion();
  // Installierte Version (NSIS): echtes Auto-Update mit electron-updater
  if (app.isPackaged && !isPortable) {
    try {
      autoUpdater = require('electron-updater').autoUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('checking-for-update', () => { update.status = 'checking'; update.message = ''; });
      autoUpdater.on('update-not-available', () => { update.status = 'latest'; });
      autoUpdater.on('update-available', (i) => { update.status = 'downloading'; update.latest = i.version; update.progress = 0; log('info', `Update ${i.version} wird geladen …`); });
      autoUpdater.on('download-progress', (p) => { update.progress = Math.round(p.percent); });
      autoUpdater.on('update-downloaded', (i) => {
        update.status = 'ready'; update.latest = i.version; update.progress = 100; update.canInstall = true;
        log('info', `Update ${i.version} ist bereit – wird beim Beenden installiert.`);
        if (Notification.isSupported()) {
          const n = new Notification({ title: 'Fox Queue Update bereit', body: `Version ${i.version} – klicken zum Neustarten und Installieren.` });
          n.on('click', () => installUpdate());
          n.show();
        }
      });
      autoUpdater.on('error', (e) => { update.status = 'error'; update.message = String(e && e.message || e).split('\n')[0]; });
    } catch (e) {
      autoUpdater = null;
    }
  }
  checkUpdate();
  setInterval(checkUpdate, 6 * 3600 * 1000);
}

async function checkUpdate() {
  if (['downloading', 'ready'].includes(update.status)) return;
  if (autoUpdater) { autoUpdater.checkForUpdates().catch(() => {}); return; }
  // Portable/Entwicklung: nur prüfen und Download-Seite anbieten
  update.status = 'checking'; update.message = '';
  try {
    const res = await fetch(RELEASES_API, { headers: { 'User-Agent': 'FoxQueue-Updater', Accept: 'application/vnd.github+json' } });
    if (res.status === 404) { update.status = 'latest'; update.message = 'Noch keine Version veröffentlicht.'; return; }
    if (!res.ok) throw new Error(`GitHub antwortet mit HTTP ${res.status}`);
    const tag = String((await res.json()).tag_name || '').replace(/^v/, '');
    update.latest = tag;
    update.status = newer(tag, update.current) ? 'available' : 'latest';
    if (update.status === 'available') log('info', `Update verfügbar: Version ${tag}`);
  } catch (e) {
    update.status = 'error'; update.message = e.message;
  }
}

function installUpdate() {
  if (autoUpdater && update.status === 'ready') {
    stop();
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  } else if (update.status === 'available') {
    shell.openExternal(RELEASES_PAGE);
  }
}

const DATA_FILE = () => path.join(app.getPath('userData'), 'foxqueue.json');

const state = {
  running: false,
  platform: 'windows',
  config: { intervalSec: 60, webhook: '', notify: true, openBrowser: false, sound: true },
  targets: [],
  stats: { alerts: 0, errors: 0, checks: 0 },
  log: [],
  events: [],   // Drop-Statistik: { t, targetId, name, mode }
  ringing: null, // laufender Ton-Alarm: { name, url, t }
};
let ringTimer = null;
let loopTimer = null;
let win = null;

// ---- Speichern/Laden ----
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
    state.config = { ...state.config, ...(d.config || {}) };
    state.targets = (d.targets || []).map(t => ({ webhook: '', ...t, status: 'Wartet', live: false, lastCheck: 0, lastError: '' }));
    state.events = Array.isArray(d.events) ? d.events : [];
  } catch { /* erster Start */ }
}
function save() {
  const targets = state.targets.map(({ id, name, url, mode, keyword, enabled, webhook }) => ({ id, name, url, mode, keyword, enabled, webhook: webhook || '' }));
  fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
  fs.writeFileSync(DATA_FILE(), JSON.stringify({ config: state.config, targets, events: state.events }, null, 2));
}

function log(type, msg) {
  state.log.unshift({ t: Date.now(), type, msg });
  if (state.log.length > 300) state.log.length = 300;
}

// ---- Alarm ----
async function alarm(t, title, body, { test = false } = {}) {
  if (!test) {
    state.stats.alerts++;
    state.events.push({ t: Date.now(), targetId: t.id, name: t.name, mode: t.mode });
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
    save();
  }
  log('alert', `🦊 ${title}: ${t.name}`);

  // Ton-Alarm: spielt in der Oberfläche, bis gestoppt wird (max. 2 Minuten)
  if (state.config.sound) {
    state.ringing = { name: t.name, url: t.url, title, t: Date.now() };
    clearTimeout(ringTimer);
    ringTimer = setTimeout(stopAlarm, 120000);
    if (win) { if (win.isMinimized()) win.restore(); win.showInactive(); }
  }

  if (state.config.notify && Notification.isSupported()) {
    const n = new Notification({ title: `Fox Queue – ${title}`, body: `${t.name}\n${body}`, urgency: 'critical' });
    n.on('click', () => shell.openExternal(t.url));
    n.show();
  }
  if (state.config.openBrowser) shell.openExternal(t.url);
  const hook = t.webhook || state.config.webhook;
  if (hook) await sendDiscord(hook, title, t.name, body, t.url);
  if (win && !win.isFocused()) win.flashFrame(true);
}

function stopAlarm() {
  clearTimeout(ringTimer);
  state.ringing = null;
}

async function sendDiscord(hook, title, name, body, url) {
  try {
    const res = await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Fox Queue',
        embeds: [{ title: `🦊 ${title}`, description: `**${name}**\n${body}`, url, color: 0xe8893a, timestamp: new Date().toISOString() }],
      }),
    });
    if (!res.ok) log('error', `Discord-Webhook: HTTP ${res.status}`);
  } catch (e) {
    log('error', `Discord-Webhook: ${e.message}`);
  }
}

// ---- Prüfschleife ----
async function runRound() {
  const list = state.targets.filter(t => t.enabled);
  for (const t of list) {
    if (!state.running) return;
    try {
      const r = await checkTarget(t);
      state.stats.checks++;
      t.lastCheck = Date.now();
      if (t.lastError) log('info', `${t.name}: wieder erreichbar`);
      t.lastError = '';
      t.status = r.status;

      if (t.mode === 'change') {
        if (t.hash && r.hash !== t.hash) {
          t.live = true;
          await alarm(t, 'Seite hat sich geändert', 'Der Inhalt ist anders als beim letzten Abruf.');
        } else t.live = false;
        t.hash = r.hash;
      } else {
        const was = t.live;
        t.live = r.live;
        if (r.live && !was) {
          const titles = { queue: 'Warteschlange ist offen', keyword: 'Text ist aufgetaucht', gone: 'Text ist verschwunden' };
          await alarm(t, titles[t.mode], `Jetzt selbst im Browser anstellen: ${t.url}`);
        } else if (!r.live && was) {
          log('info', `${t.name}: ${r.status}`);
        }
      }
    } catch (e) {
      state.stats.errors++;
      t.lastCheck = Date.now();
      const msg = e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message;
      if (t.lastError !== msg) log('error', `${t.name}: ${msg}`);
      t.lastError = msg;
    }
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
  }
}

function scheduleNext() {
  if (!state.running) return;
  const jitter = Math.random() * Math.min(10, state.config.intervalSec * 0.15) * 1000;
  loopTimer = setTimeout(async () => { await runRound(); scheduleNext(); }, state.config.intervalSec * 1000 + jitter);
}

function start() {
  if (state.running) return;
  state.running = true;
  state.stats = { alerts: 0, errors: 0, checks: 0 };
  state.targets.forEach(t => { t.live = false; t.hash = undefined; t.lastError = ''; });
  log('info', `Monitor gestartet – ${state.targets.filter(t => t.enabled).length} Ziel(e), alle ${state.config.intervalSec} s.`);
  runRound().then(scheduleNext);
}
function stop() {
  if (!state.running) return;
  state.running = false;
  clearTimeout(loopTimer);
  state.targets.forEach(t => { t.live = false; });
  log('info', 'Monitor gestoppt.');
}

// ---- IPC ----
const snapshot = () => JSON.parse(JSON.stringify({ ...state, version: app.getVersion(), update }));
ipcMain.handle('getState', () => snapshot());
ipcMain.handle('saveConfig', (_e, c) => {
  state.config = { ...state.config, ...c, intervalSec: Math.max(20, Number(c.intervalSec) || 60) };
  save(); log('info', 'Einstellungen gespeichert.');
  return snapshot();
});
ipcMain.handle('addTarget', (_e, t) => {
  state.targets.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: t.name, url: t.url, mode: t.mode, keyword: t.keyword || '', webhook: t.webhook || '', enabled: true, status: 'Wartet', live: false, lastCheck: 0, lastError: '' });
  save(); log('info', `Ziel hinzugefügt: ${t.name}`);
  return snapshot();
});
ipcMain.handle('updateTarget', (_e, id, p) => {
  const t = state.targets.find(x => x.id === id);
  if (t) {
    if ('enabled' in p) { t.enabled = !!p.enabled; if (!t.enabled) t.live = false; }
    if ('webhook' in p) t.webhook = String(p.webhook || '');
    save();
  }
  return snapshot();
});
ipcMain.handle('removeTarget', (_e, id) => {
  state.targets = state.targets.filter(x => x.id !== id);
  save(); return snapshot();
});
ipcMain.handle('start', () => { start(); return snapshot(); });
ipcMain.handle('stop', () => { stop(); return snapshot(); });
ipcMain.handle('clearLog', () => { state.log = []; return snapshot(); });
ipcMain.handle('testAlert', async () => {
  await alarm({ id: 'test', name: 'Test', url: 'https://github.com/Djlover007' }, 'Test-Alarm', 'Wenn du das siehst, funktionieren die Benachrichtigungen.', { test: true });
  return snapshot();
});
ipcMain.handle('stopAlarm', () => { stopAlarm(); return snapshot(); });
ipcMain.handle('clearStats', () => { state.events = []; save(); return snapshot(); });
ipcMain.handle('checkUpdate', () => { checkUpdate(); return snapshot(); });
ipcMain.handle('installUpdate', () => { installUpdate(); return snapshot(); });
ipcMain.handle('openUrl', (_e, u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); return snapshot(); });

// ---- Fenster ----
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 820, minHeight: 600,
    backgroundColor: '#0f1115', title: 'Fox Queue',
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('focus', () => win.flashFrame(false));
}

app.setAppUserModelId('de.djlover007.foxqueue');
app.whenReady().then(() => { load(); createWindow(); setTimeout(setupUpdater, 4000); });
app.on('window-all-closed', () => { stop(); stopAlarm(); app.quit(); });
