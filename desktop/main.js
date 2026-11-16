// Fox Queue – Electron-Hauptprozess
const { app, BrowserWindow, ipcMain, Notification, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { checkTarget, setProxy } = require('./engine');
const { isQueueHost, effInterval, backoffMs } = require('./queue');

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
  config: { intervalSec: 60, webhook: '', notify: true, openBrowser: false, sound: true, proxy: '', captchaNotify: true, captchaSound: false, captchaFront: true, tgToken: '', tgChat: '' },
  targets: [],
  stats: { alerts: 0, errors: 0, checks: 0 },
  log: [],
  events: [],   // Drop-Statistik: { t, targetId, name, mode }
  ringing: null, // laufender Ton-Alarm: { name, url, t }
};
let ringTimer = null;
let ringingWin = null; // Zielfenster, das gerade „Du bist dran“ klingelt
let loopTimer = null;
let win = null;

// ---- Speichern/Laden ----
function load() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
    state.config = { ...state.config, ...(d.config || {}) };
    state.targets = (d.targets || []).map(t => ({ webhook: '', intervalSec: 0, startAt: 0, dropAt: 0, windows: 1, ...t, status: 'Wartet', live: false, lastCheck: 0, lastError: '' }));
    state.events = Array.isArray(d.events) ? d.events : [];
    try { setProxy(state.config.proxy); } catch (e) { log('error', `Proxy ungültig: ${e.message}`); }
  } catch { /* erster Start */ }
}
function save() {
  const targets = state.targets.map(({ id, name, url, mode, keyword, enabled, webhook, intervalSec, startAt, dropAt, windows }) => ({ id, name, url, mode, keyword, enabled, webhook: webhook || '', intervalSec: intervalSec || 0, startAt: startAt || 0, dropAt: dropAt || 0, windows: windows || 1 }));
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
  await remote(t.webhook || state.config.webhook, title, t.name, body, t.url);
  if (win && !win.isFocused()) win.flashFrame(true);
}

function stopAlarm() {
  ringingWin = null;
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

// Telegram als zweiter Kanal (Bot-Token + Chat-ID aus den Einstellungen)
async function sendTelegram(title, name, body, url) {
  const { tgToken, tgChat } = state.config;
  if (!tgToken || !tgChat) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text: `🦊 ${title}\n${name}\n${body}\n${url}`, disable_web_page_preview: true }),
    });
    if (!res.ok) log('error', `Telegram: HTTP ${res.status}${res.status === 401 ? ' (Bot-Token prüfen)' : res.status === 400 ? ' (Chat-ID prüfen)' : ''}`);
  } catch (e) {
    log('error', `Telegram: ${e.message}`);
  }
}

/** Alarm an alle eingerichteten Fern-Kanäle: Discord (falls Webhook) und Telegram (falls eingerichtet). */
async function remote(hook, title, name, body, url) {
  await Promise.all([hook ? sendDiscord(hook, title, name, body, url) : null, sendTelegram(title, name, body, url)]);
}

// ---- Prüfschleife ----
// Bis zu 4 Ziele gleichzeitig prüfen (jedes Ziel trotzdem nur einmal pro Intervall)
const PARALLEL = 4;

async function runRound() {
  // Nur Ziele, deren (eigenes) Intervall abgelaufen ist
  const now = Date.now();
  const list = state.targets.filter(t => t.enabled && !(t.pauseUntil > now) && now - (t.lastCheck || 0) >= effInterval(t, state.config.intervalSec) * 1000 - 1500);
  let next = 0;
  const worker = async () => {
    while (state.running && next < list.length) {
      const t = list[next++];
      await new Promise(r => setTimeout(r, Math.random() * 300)); // leicht versetzt starten
      if (state.running) await checkOne(t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
}

async function checkOne(t) {
    try {
      const r = await checkTarget(t);
      state.stats.checks++;
      t.lastCheck = Date.now();
      if (t.lastError) log('info', `${t.name}: wieder erreichbar`);
      t.lastError = ''; t.backoff = 0; t.pauseUntil = 0;
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
      let msg = e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message;
      if (e.status === 429) {
        // Shop bremst: Ziel pausieren, bei jeder weiteren 429 doppelt so lang
        t.backoff = (t.backoff || 0) + 1;
        t.pauseUntil = Date.now() + backoffMs(t.backoff, e.retryAfter);
        msg += `. Pause bis ${new Date(t.pauseUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` + (t.backoff >= 3 ? ' – am besten das Prüfintervall für dieses Ziel erhöhen' : '');
      }
      if (t.lastError !== msg) log('error', `${t.name}: ${msg}`);
      t.lastError = msg;
    }
}

function scheduleNext() {
  if (!state.running) return;
  // Takt = kürzestes Intervall aller aktiven Ziele
  const tick = Math.min(state.config.intervalSec, ...state.targets.filter(t => t.enabled).map(t => effInterval(t, state.config.intervalSec)));
  const jitter = Math.random() * Math.min(10, tick * 0.15) * 1000;
  loopTimer = setTimeout(async () => { await runRound(); scheduleNext(); }, tick * 1000 + jitter);
}

function start() {
  if (state.running) return;
  state.running = true;
  state.stats = { alerts: 0, errors: 0, checks: 0 };
  state.targets.forEach(t => { t.live = false; t.hash = undefined; t.lastError = ''; t.lastCheck = 0; });
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
const snapshot = () => JSON.parse(JSON.stringify({ ...state, windows: listWindows(), version: app.getVersion(), update }));
ipcMain.handle('getState', () => snapshot());
ipcMain.handle('saveConfig', (_e, c) => {
  state.config = { ...state.config, ...c, intervalSec: Math.max(20, Number(c.intervalSec) || 60) };
  try { setProxy(state.config.proxy); } catch (e) { log('error', `Proxy ungültig: ${e.message}`); }
  save(); log('info', state.config.proxy ? 'Einstellungen gespeichert – Abrufe laufen über den Proxy.' : 'Einstellungen gespeichert.');
  return snapshot();
});
// Eigenes Intervall (0 = Standard), Startzeit (0 = keine) und Zahl der Fenster – mit sicheren Grenzen
function targetExtras(p) {
  const out = {};
  if ('intervalSec' in p) { const n = parseInt(p.intervalSec, 10) || 0; out.intervalSec = n > 0 ? Math.max(20, n) : 0; }
  if ('startAt' in p) out.startAt = Math.max(0, Number(p.startAt) || 0);
  if ('dropAt' in p) out.dropAt = Math.max(0, Number(p.dropAt) || 0); // Drop-Zeit, nur für Anzeige und Countdown
  if ('windows' in p) out.windows = Math.min(TASK_MAX, Math.max(1, parseInt(p.windows, 10) || 1));
  return out;
}
ipcMain.handle('addTarget', (_e, t) => {
  state.targets.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: t.name, url: t.url, mode: t.mode, keyword: t.keyword || '', webhook: t.webhook || '', ...targetExtras(t), enabled: true, status: 'Wartet', live: false, lastCheck: 0, lastError: '' });
  save(); log('info', `Ziel hinzugefügt: ${t.name}`);
  return snapshot();
});
ipcMain.handle('updateTarget', (_e, id, p) => {
  const t = state.targets.find(x => x.id === id);
  if (t) {
    if ('enabled' in p) { t.enabled = !!p.enabled; if (!t.enabled) t.live = false; t.pauseUntil = 0; } // Pausieren/Fortsetzen hebt eine 429-Pause auf
    if ('webhook' in p) t.webhook = String(p.webhook || '');
    if (p.name) t.name = String(p.name);
    // Adresse, Modus oder Text geändert → Ziel fängt neu an zu beobachten
    const before = t.url + '|' + t.mode + '|' + t.keyword;
    if (p.url && /^https?:\/\//.test(p.url)) t.url = p.url;
    if (p.mode && ['queue', 'keyword', 'gone', 'change'].includes(p.mode)) t.mode = p.mode;
    if ('keyword' in p) t.keyword = String(p.keyword || '');
    if (before !== t.url + '|' + t.mode + '|' + t.keyword) { t.backoff = 0; t.pauseUntil = 0; t.live = false; t.hash = undefined; t.lastError = ''; t.status = 'Wartet'; t.lastCheck = 0; }
    Object.assign(t, targetExtras(p));
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
ipcMain.handle('testPassed', async () => {
  await alarm({ id: 'test', name: 'Test #1', url: 'https://github.com/Djlover007' }, 'Du bist dran', 'So klingt es, wenn ein Fenster die Warteschlange verlässt.', { test: true });
  return snapshot();
});
ipcMain.handle('stopAlarm', () => { stopAlarm(); return snapshot(); });
ipcMain.handle('clearStats', () => { state.events = []; save(); return snapshot(); });
ipcMain.handle('checkUpdate', () => { checkUpdate(); return snapshot(); });
ipcMain.handle('installUpdate', () => { installUpdate(); return snapshot(); });
ipcMain.handle('openUrl', (_e, u) => { if (/^https?:\/\//.test(u)) shell.openExternal(u); return snapshot(); });

// ---- Zielseite in eigenen Fenstern (eigener Eintrag in der Taskleiste) ----
const TASK_MAX = 20;
const taskWins = new Map(); // id → { id, w, title, url, queue, captcha, passed, pos, wait }
let nextWinId = 1;
// Seiten-Erkennung (gleiche Datei wie auf Android). Liest nur, löst und klickt nichts.
let DETECT_JS = '';
try { DETECT_JS = fs.readFileSync(path.join(__dirname, '..', 'ui', 'page-detect.js'), 'utf8'); } catch { }

const winStatus = (i) => i.captcha ? 'captcha' : i.queue ? 'queue' : i.passed ? 'passed' : (i.w.webContents.isLoading() ? 'loading' : 'open');
function listWindows() {
  return [...taskWins.values()].filter(i => !i.w.isDestroyed())
    .map(i => ({ id: i.id, title: i.title, url: i.w.webContents.getURL() || i.url, status: winStatus(i), pos: i.pos, wait: i.wait }));
}
const showWin = (w) => { if (w.isDestroyed()) return; if (w.isMinimized()) w.restore(); w.show(); w.focus(); };
const hookFor = (url) => { const t = state.targets.find(x => x.url === url); return (t && t.webhook) || state.config.webhook; };

/** Beobachtet ein Zielfenster: Captcha, Warteschlange (Adresse oder Seiteninhalt), Platz – und „Du bist dran“. */
function watchWindow(info) {
  const { w, title, url } = info;
  let captchaShown = false, lastCaptchaAlert = 0, hostQueue = false, pageQueue = false, notQueuePolls = 0;

  const passed = () => {
    info.passed = true; info.queue = false; info.pos = ''; info.wait = '';
    state.stats.alerts++;
    state.events.push({ t: Date.now(), targetId: 'task', name: title, mode: 'queue' });
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
    save();
    log('alert', `🎉 Du bist dran: ${title}`);
    if (w.isFocused()) return; // du schaust schon drauf
    if (state.config.sound) {
      state.ringing = { name: title, url, title: 'Du bist dran', t: Date.now() };
      clearTimeout(ringTimer);
      ringTimer = setTimeout(stopAlarm, 120000);
      ringingWin = w;
    }
    if (w.isMinimized()) w.restore();
    w.moveTop(); w.flashFrame(true);
    if (Notification.isSupported()) {
      const n = new Notification({ title: `🎉 Du bist dran: ${title}`, body: 'Warteschlange durch – klicken und schnell weitermachen', urgency: 'critical' });
      n.on('click', () => showWin(w));
      n.show();
    }
    remote(hookFor(url), 'Du bist dran', title, 'Die Warteschlange ist durch – du bist im Shop.', url);
  };

  // Warteschlange unter eigener Adresse (Queue-it): sofort beim Seitenwechsel erkennen
  const onNav = (_e, u) => {
    if (!/^https?:/.test(u)) return;
    if (isQueueHost(u)) { hostQueue = true; info.passed = false; return; }
    if (!hostQueue) return;
    hostQueue = false; pageQueue = false;
    passed();
  };
  w.webContents.on('did-navigate', onNav);
  w.webContents.on('did-navigate-in-page', onNav);

  const timer = setInterval(async () => {
    if (w.isDestroyed() || !DETECT_JS) return;
    let d;
    try { d = await w.webContents.executeJavaScript(DETECT_JS, true); } catch { return; }
    if (!d || typeof d !== 'object') return;
    const onHost = isQueueHost(w.webContents.getURL());

    // Warteschlange unter der Adresse des Shops (Cloudflare Waiting Room, eigene Warteseiten):
    // erst „durch“, wenn die fertig geladene Seite zweimal hintereinander keine Warteseite mehr ist
    if (d.queue && !onHost) { pageQueue = true; notQueuePolls = 0; info.passed = false; }
    else if (pageQueue && !onHost && d.ready && ++notQueuePolls >= 2) { pageQueue = false; passed(); }

    info.queue = onHost || !!d.queue;
    info.pos = info.queue ? String(d.pos || '') : '';
    info.wait = info.queue ? String(d.wait || '') : '';

    info.captcha = !!d.captcha;
    if (d.captcha && !captchaShown) {
      captchaShown = true;
      if (state.config.captchaNotify === false) return;
      if (w.isFocused() || Date.now() - lastCaptchaAlert < 60000) return; // du siehst es schon / nicht zu oft
      lastCaptchaAlert = Date.now();
      log('alert', `🧩 Captcha wartet: ${title}`);
      w.flashFrame(true);
      if (state.config.captchaSound) {
        state.ringing = { name: title, url, title: 'Captcha wartet', t: Date.now() };
        clearTimeout(ringTimer);
        ringTimer = setTimeout(stopAlarm, 120000);
        ringingWin = w;
      }
      if (Notification.isSupported()) {
        const n = new Notification({ title: `🧩 Captcha: ${title}`, body: 'Klicken und selbst lösen', urgency: 'critical' });
        n.on('click', () => showWin(w));
        n.show();
      }
      remote(hookFor(url), 'Captcha wartet', title, 'In einem Fox-Queue-Fenster ist ein Captcha aufgetaucht – bitte selbst lösen.', url);
      // Fenster von selbst nach vorn holen – außer du arbeitest gerade in einem Fenster,
      // das schon durch die Warteschlange ist oder selbst ein Captcha zeigt (dann nur blinken)
      if (state.config.captchaFront !== false) {
        const cur = BrowserWindow.getFocusedWindow();
        const busy = [...taskWins.values()].some(i => i.w === cur && i.w !== w && (i.passed || i.captcha));
        if (!busy) showWin(w);
      }
    } else if (!d.captcha && captchaShown) {
      captchaShown = false;
      w.flashFrame(false);
    }
  }, 2000);

  // Im Fenster angekommen → Blinken und Ton aus
  w.on('focus', () => { w.flashFrame(false); if (ringingWin === w) stopAlarm(); });
  w.on('closed', () => { clearInterval(timer); if (ringingWin === w) ringingWin = null; taskWins.delete(info.id); });
}

function openTaskWindows(url, name, count) {
  if (!/^https?:\/\//.test(url)) return;
  const n = Math.min(TASK_MAX, Math.max(1, parseInt(count, 10) || 1), Math.max(0, TASK_MAX * 2 - taskWins.size));
  if (n < 1) { log('error', 'Zu viele Fenster offen – schließe erst welche.'); return; }
  const label = name || new URL(url).host;
  for (let i = 1; i <= n; i++) {
    const title = n > 1 ? `${label} #${i}` : label;
    const off = ((i - 1) % 10) * 28; // leicht versetzt, damit man alle sieht
    const w = new BrowserWindow({
      width: 1100, height: 760, x: 80 + off, y: 60 + off,
      backgroundColor: '#0f1115', title: `🦊 ${title}`, autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'ui', 'icon.png'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    w.setMenuBarVisibility(false);
    w.on('page-title-updated', (e) => e.preventDefault()); // Titel „#1, #2 …“ behalten
    // Links, die ein neues Fenster wollen, im selben Fenster öffnen
    w.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:\/\//.test(u)) w.loadURL(u); return { action: 'deny' }; });
    const info = { id: nextWinId++, w, title, url, queue: false, captcha: false, passed: false, pos: '', wait: '' };
    taskWins.set(info.id, info);
    watchWindow(info);
    w.loadURL(url);
  }
  if (n > 1) log('info', `${n} Fenster geöffnet: ${label}`);
}

/** Alle Zielfenster als Raster über den Bildschirm verteilen. */
function arrangeWindows() {
  const list = [...taskWins.values()].filter(i => !i.w.isDestroyed());
  if (!list.length) return;
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const cols = Math.ceil(Math.sqrt(list.length)), rows = Math.ceil(list.length / cols);
  const cw = Math.floor(width / cols), ch = Math.floor(height / rows);
  list.forEach((i, k) => {
    if (i.w.isMinimized()) i.w.restore();
    if (i.w.isMaximized()) i.w.unmaximize();
    i.w.setBounds({ x: x + (k % cols) * cw, y: y + Math.floor(k / cols) * ch, width: cw, height: ch });
    i.w.showInactive();
  });
}

ipcMain.handle('openTask', (_e, u, name, count) => { openTaskWindows(u, name, count); return snapshot(); });
ipcMain.handle('focusWindow', (_e, id) => { const i = taskWins.get(Number(id)); if (i) showWin(i.w); return snapshot(); });
ipcMain.handle('closeWindow', (_e, id) => { const i = taskWins.get(Number(id)); if (i && !i.w.isDestroyed()) i.w.destroy(); return snapshot(); });
ipcMain.handle('closeAllWindows', () => { for (const i of [...taskWins.values()]) if (!i.w.isDestroyed()) i.w.destroy(); return snapshot(); });
ipcMain.handle('arrangeWindows', () => { arrangeWindows(); return snapshot(); });

// ---- Startzeit pro Ziel: Monitor starten und Fenster öffnen ----
function fireDueStarts() {
  const now = Date.now();
  for (const t of state.targets) {
    if (!t.startAt || t.startAt > now) continue;
    const late = now - t.startAt;
    t.startAt = 0; save();
    if (late > 10 * 60000) { log('error', `Startzeit verpasst: ${t.name} (Fox Queue lief nicht)`); continue; }
    log('alert', `⏰ Startzeit erreicht: ${t.name}`);
    if (!t.enabled) t.enabled = true;
    start();
    openTaskWindows(t.url, t.name, t.windows || 1);
    if (state.config.notify && Notification.isSupported()) new Notification({ title: `⏰ Gleich geht's los: ${t.name}`, body: (t.dropAt > now ? `Drop um ${new Date(t.dropAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr. ` : '') + `Monitor läuft, ${t.windows || 1} Fenster geöffnet.` }).show();
  }
}

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
  // Hauptfenster zu → auch alle Zielfenster schließen, damit die App sauber beendet
  win.on('closed', () => { for (const i of [...taskWins.values()]) if (!i.w.isDestroyed()) i.w.destroy(); });
}

app.setAppUserModelId('de.djlover007.foxqueue');
app.whenReady().then(() => { load(); createWindow(); setTimeout(setupUpdater, 4000); setInterval(fireDueStarts, 1000); });
app.on('window-all-closed', () => { stop(); stopAlarm(); app.quit(); });
