// Fox Queue – Electron-Hauptprozess
const { app, BrowserWindow, ipcMain, Notification, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { checkTarget } = require('./engine');

const DATA_FILE = () => path.join(app.getPath('userData'), 'foxqueue.json');

const state = {
  running: false,
  platform: 'windows',
  config: { intervalSec: 60, webhook: '', notify: true, openBrowser: false },
  targets: [],
  stats: { alerts: 0, errors: 0, checks: 0 },
  log: [],
};
let loopTimer = null;
let win = null;

// ---- Speichern/Laden ----
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
    state.config = { ...state.config, ...(d.config || {}) };
    state.targets = (d.targets || []).map(t => ({ ...t, status: 'Wartet', live: false, lastCheck: 0, lastError: '' }));
  } catch { /* erster Start */ }
}
function save() {
  const targets = state.targets.map(({ id, name, url, mode, keyword, enabled }) => ({ id, name, url, mode, keyword, enabled }));
  fs.mkdirSync(path.dirname(DATA_FILE()), { recursive: true });
  fs.writeFileSync(DATA_FILE(), JSON.stringify({ config: state.config, targets }, null, 2));
}

function log(type, msg) {
  state.log.unshift({ t: Date.now(), type, msg });
  if (state.log.length > 300) state.log.length = 300;
}

// ---- Alarm ----
async function alarm(t, title, body) {
  state.stats.alerts++;
  log('alert', `🦊 ${title}: ${t.name}`);

  if (state.config.notify && Notification.isSupported()) {
    const n = new Notification({ title: `Fox Queue – ${title}`, body: `${t.name}\n${body}`, urgency: 'critical' });
    n.on('click', () => shell.openExternal(t.url));
    n.show();
  }
  if (state.config.openBrowser) shell.openExternal(t.url);
  if (state.config.webhook) await sendDiscord(title, t.name, body, t.url);
  if (win && !win.isFocused()) win.flashFrame(true);
}

async function sendDiscord(title, name, body, url) {
  try {
    const res = await fetch(state.config.webhook, {
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
const snapshot = () => JSON.parse(JSON.stringify(state));
ipcMain.handle('getState', () => snapshot());
ipcMain.handle('saveConfig', (_e, c) => {
  state.config = { ...state.config, ...c, intervalSec: Math.max(20, Number(c.intervalSec) || 60) };
  save(); log('info', 'Einstellungen gespeichert.');
  return snapshot();
});
ipcMain.handle('addTarget', (_e, t) => {
  state.targets.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: t.name, url: t.url, mode: t.mode, keyword: t.keyword || '', enabled: true, status: 'Wartet', live: false, lastCheck: 0, lastError: '' });
  save(); log('info', `Ziel hinzugefügt: ${t.name}`);
  return snapshot();
});
ipcMain.handle('updateTarget', (_e, id, p) => {
  const t = state.targets.find(x => x.id === id);
  if (t) { Object.assign(t, p); if (p.enabled === false) t.live = false; save(); }
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
  await alarm({ name: 'Test', url: 'https://github.com/Djlover007' }, 'Test-Alarm', 'Wenn du das siehst, funktionieren die Benachrichtigungen.');
  state.stats.alerts--;
  return snapshot();
});
ipcMain.handle('openUrl', (_e, u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); return snapshot(); });

// ---- Fenster ----
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 820, minHeight: 600,
    backgroundColor: '#0f1115', title: 'Fox Queue',
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('focus', () => win.flashFrame(false));
}

app.setAppUserModelId('de.djlover007.foxqueue');
app.whenReady().then(() => { load(); createWindow(); });
app.on('window-all-closed', () => { stop(); app.quit(); });
